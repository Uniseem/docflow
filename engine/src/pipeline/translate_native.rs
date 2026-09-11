//! BabelDOC callbacks: PDF paragraphs arrive from the Python runner, are
//! batched, and go through the same requests, checks and repairs as the
//! Markdown route. This module adds PDF marker protection ({v0} formulas,
//! <style> spans) and paragraph assembly; it never creates another HTTP
//! client or provider pool.
use super::*;
use std::sync::atomic::AtomicI32;

pub(crate) const MAX_PARAGRAPH_CHARS: usize = 200_000;
/// Paragraph callbacks the runner may have waiting at once.
pub(crate) const MAX_CALLBACK_WORKERS: usize = 256;

#[derive(Debug, Clone)]
pub(crate) struct NativeRequest {
    pub request_id: u64,
    pub text: String,
}

pub(crate) struct NativeSession {
    state: Arc<AppState>,
    document_id: String,
    translator: Translator,
    pub runtime: TranslationRuntimeSettings,
    pub progress: Arc<AtomicI32>,
    completed: AtomicUsize,
    kept_chars: AtomicUsize,
    total_chars: AtomicUsize,
    rejected: AtomicUsize,
    notices: AtomicUsize,
    cache_root: PathBuf,
}

struct Paragraph {
    request_id: u64,
    original: String,
    parts: Vec<String>,
    output: Vec<Option<String>>,
}

struct PdfRestorer<'a> {
    map: &'a HashMap<String, String>,
}

impl Restorer for PdfRestorer<'_> {
    fn mode(&self) -> Mode {
        Mode::Pdf
    }

    fn restore(&self, source: &str, reply: &str) -> Result<(String, bool)> {
        let tokens = expected_tokens(source, self.map);
        // Formula identities carry meaning (a < b): never renumber them.
        let (restored, repaired) = restore_with_policy(reply, &tokens, self.map, false)?;
        validate_pdf_markers(&restore_pdf_source(source, self.map), &restored)?;
        Ok((restored, repaired))
    }

    fn tokens(&self, source: &str) -> Vec<String> {
        expected_tokens(source, self.map)
    }

    fn fragment_restore(&self, source: &str, assembled: &str) -> Result<String> {
        let (restored, _) = self.restore(source, assembled)?;
        Ok(restored)
    }
}

impl NativeSession {
    pub async fn new(
        state: Arc<AppState>,
        id: &str,
        translator: Translator,
        progress: Arc<AtomicI32>,
    ) -> Result<Arc<Self>> {
        let runtime = settings::document_translation_runtime(&state.pool, id).await?;
        let cache_root = super::super::document_root(&state.config.work_root, id)?
            .join("native-translation-cache-v2")
            .join(native_fingerprint(&translator, &runtime));
        tokio::fs::create_dir_all(&cache_root).await?;
        Ok(Arc::new(Self {
            state,
            document_id: id.to_string(),
            translator,
            runtime,
            progress,
            completed: AtomicUsize::new(0),
            kept_chars: AtomicUsize::new(0),
            total_chars: AtomicUsize::new(0),
            rejected: AtomicUsize::new(0),
            notices: AtomicUsize::new(0),
            cache_root,
        }))
    }

    pub fn translator_label(&self) -> String {
        self.translator.label()
    }

    pub fn batch_limit(&self) -> usize {
        self.translator.max_segments(&self.runtime).max(1)
    }

    pub fn callback_workers(&self) -> usize {
        self.runtime
            .per_document_concurrency
            .saturating_mul(self.batch_limit())
            .clamp(1, MAX_CALLBACK_WORKERS)
    }

    /// Characters kept in the source language, and all characters seen.
    pub fn untranslated(&self) -> (usize, usize) {
        (self.kept_chars.load(Ordering::Relaxed), self.total_chars.load(Ordering::Relaxed))
    }

    pub fn ensure_mostly_translated(&self) -> Result<()> {
        let (kept, total) = self.untranslated();
        super::ensure_mostly_translated(kept, total)
    }

    fn context(&self) -> Work<'_> {
        Work {
            state: &self.state,
            id: &self.document_id,
            translator: &self.translator,
            runtime: &self.runtime,
            total: 0,
            completed: &self.completed,
            kept_chars: &self.kept_chars,
            rejected: &self.rejected,
            notices: &self.notices,
            stage: "pdf2zh_translation_repair",
            progress: Box::new(|| self.progress.load(Ordering::Relaxed)),
        }
    }

    /// One batch of paragraphs; uses at most one provider request at a time
    /// per batch. The broker bounds the number of batches in flight.
    pub async fn translate_batch(&self, requests: Vec<NativeRequest>) -> Result<Vec<(u64, String)>> {
        anyhow::ensure!(!requests.is_empty(), "原生翻译批次为空");
        // Markers are numbered across the whole batch, so the {v0} of one
        // paragraph never shares a mapping with the {v0} of another.
        let mut map = HashMap::new();
        let mut paragraphs = Vec::with_capacity(requests.len());
        for request in requests {
            anyhow::ensure!(
                request.text.chars().count() <= MAX_PARAGRAPH_CHARS,
                "PDF 段落异常长，拒绝超量解析结果"
            );
            self.total_chars.fetch_add(request.text.chars().count(), Ordering::Relaxed);
            let protected = protect_pdf(&request.text, &mut map);
            let mut parts = segment(&protected, self.translator.chunk_chars(&self.runtime));
            if parts.is_empty() {
                parts.push(protected);
            }
            let count = parts.len();
            paragraphs.push(Paragraph {
                request_id: request.request_id,
                original: request.text,
                parts,
                output: vec![None; count],
            });
        }

        let mut locations = Vec::new();
        let mut sources = Vec::new();
        let mut cache_hits = 0;
        for (paragraph_index, paragraph) in paragraphs.iter_mut().enumerate() {
            for (part_index, source) in paragraph.parts.iter().enumerate() {
                let plain = restore_pdf_source(source, &map);
                if !needs_translation(source) {
                    // Whitespace, a lone formula or a number: kept as is.
                    paragraph.output[part_index] = Some(plain);
                } else if let Some(cached) = self.load_cache(&plain).await
                    && validate_pdf_markers(&plain, &cached).is_ok()
                {
                    paragraph.output[part_index] = Some(cached);
                    cache_hits += 1;
                } else {
                    locations.push((paragraph_index, part_index));
                    sources.push(source.clone());
                }
            }
        }
        let context = self.context();
        if cache_hits > 0 {
            context
                .event("pdf2zh_translation_cache", "info", &format!("复用 {cache_hits} 个已校验的 PDF 翻译断点"), None, None)
                .await?;
        }

        let restorer = PdfRestorer { map: &map };
        let items = sources.into_iter().enumerate().collect::<Vec<_>>();
        for batch in plan_batches(&items, &self.translator, &self.runtime) {
            let (replies, response) = translate_batch_replies(&context, &batch, &restorer).await?;
            if let Some(response) = &response {
                context
                    .event(
                        "pdf2zh_translation_batch",
                        "info",
                        &format!("PDF 段落批量翻译完成：{} 段", batch.len()),
                        Some(&format!(
                            "{}；队列等待 {} ms；服务处理 {} ms；{}",
                            self.translator.label(),
                            response.queue_wait.as_millis(),
                            response.service_time.as_millis(),
                            response.usage_detail.as_deref().unwrap_or("校验通过")
                        )),
                        None,
                    )
                    .await?;
            }
            let mut finished = Vec::with_capacity(batch.len());
            let mut retries = Vec::new();
            for ((unit, source), reply) in batch.into_iter().zip(replies) {
                match reply {
                    Some((text, _)) => finished.push((unit, source, text)),
                    None => {
                        let number = usize::try_from(paragraphs[locations[unit].0].request_id).unwrap_or(unit + 1);
                        retries.push((unit, number, source));
                    }
                }
            }
            // Paragraphs the batch could not deliver are repaired side by side.
            let (work, pdf) = (&context, &restorer);
            let repaired = futures::stream::iter(retries.into_iter().map(|(unit, number, source)| async move {
                let (text, _) = translate_segment(work, number, &source, pdf).await?;
                Ok::<_, anyhow::Error>((unit, source, text))
            }))
            .buffer_unordered(REPAIR_PARALLELISM)
            .try_collect::<Vec<_>>()
            .await?;
            for (unit, source, text) in finished.into_iter().chain(repaired) {
                let (paragraph_index, part_index) = locations[unit];
                let text = preserve_boundary_whitespace(&source, &text);
                let plain = restore_pdf_source(&source, &map);
                if let Err(error) = self.save_cache(&plain, &text).await {
                    context
                        .event("pdf2zh_translation_cache_warning", "warning", "PDF 段落已翻译，但断点保存失败", Some(&error.to_string()), None)
                        .await?;
                }
                paragraphs[paragraph_index].output[part_index] = Some(text);
            }
        }

        let mut replies = Vec::with_capacity(paragraphs.len());
        for paragraph in paragraphs {
            let output = paragraph
                .output
                .into_iter()
                .collect::<Option<Vec<_>>>()
                .context("PDF 段落仍缺少部分译文，拒绝回填排版")?
                .concat();
            validate_pdf_markers(&paragraph.original, &output)?;
            anyhow::ensure!(
                paragraph.original.trim().is_empty() || !output.trim().is_empty(),
                "PDF 段落译文为空"
            );
            let assembled = output.chars().count();
            anyhow::ensure!(assembled <= MAX_PARAGRAPH_CHARS, "PDF 段落译文异常膨胀，超过排版器安全回填上限");
            self.completed.fetch_add(1, Ordering::Relaxed);
            replies.push((paragraph.request_id, output));
        }
        Ok(replies)
    }

    fn cache_path(&self, plain: &str) -> PathBuf {
        self.cache_root.join(format!("{}.json", source_sha256(plain)))
    }

    async fn load_cache(&self, plain: &str) -> Option<String> {
        let bytes = tokio::fs::read(self.cache_path(plain)).await.ok()?;
        let entry = serde_json::from_slice::<ChunkCacheEntry>(&bytes).ok()?;
        (entry.version == 3 && entry.source_sha256 == source_sha256(plain) && entry.translator == self.translator.identity())
            .then_some(entry.markdown)
            .filter(|text| !text.trim().is_empty())
    }

    async fn save_cache(&self, plain: &str, text: &str) -> Result<()> {
        let path = self.cache_path(plain);
        let temporary = path.with_extension(format!("{}.partial", uuid::Uuid::new_v4().simple()));
        let entry = ChunkCacheEntry {
            version: 3,
            source_sha256: source_sha256(plain),
            translator: self.translator.identity(),
            markdown: text.to_string(),
        };
        tokio::fs::write(&temporary, serde_json::to_vec(&entry)?).await?;
        if tokio::fs::rename(&temporary, &path).await.is_err() {
            let _ = tokio::fs::remove_file(&path).await;
            tokio::fs::rename(&temporary, &path).await?;
        }
        Ok(())
    }
}

fn native_marker_regex() -> Regex {
    Regex::new(r"(?i)\{\s*v\s*\d+\s*\}|<style\b[^>]*>|</style\s*>").expect("static PDF marker regex")
}

/// Replaces formula and style markers (and anything that looks like a
/// segment tag) with this batch's `DOCFLOWKEEP` markers.
fn protect_pdf(source: &str, map: &mut HashMap<String, String>) -> String {
    let regex = Regex::new(r"(?i)DOCFLOWKEEP\d{6}TOKEN|\{\s*v\s*\d+\s*\}|<style\b[^>]*>|</style\s*>|</?segment\b[^>]*>")
        .expect("static PDF protection regex");
    regex
        .replace_all(source, |capture: &regex::Captures| {
            let marker = token(map.len());
            map.insert(marker.clone(), capture[0].to_string());
            marker
        })
        .into_owned()
}

fn restore_pdf_source(source: &str, markers: &HashMap<String, String>) -> String {
    token_regex()
        .replace_all(source, |capture: &regex::Captures| {
            markers
                .get(&capture[0])
                .cloned()
                .unwrap_or_else(|| capture[0].to_string())
        })
        .into_owned()
}

fn validate_pdf_markers(source: &str, translated: &str) -> Result<()> {
    let regex = native_marker_regex();
    let expected = regex.find_iter(source).map(|m| m.as_str()).collect::<Vec<_>>();
    let actual = regex.find_iter(translated).map(|m| m.as_str()).collect::<Vec<_>>();
    anyhow::ensure!(expected == actual, "PDF 公式或样式标记丢失、增加或顺序改变");
    Ok(())
}

fn native_fingerprint(translator: &Translator, runtime: &TranslationRuntimeSettings) -> String {
    source_sha256(&format!(
        "babeldoc-0.6.4-v3:{}",
        translation_fingerprint(translator, runtime, "")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn restore_piece(source: &str, reply: &str, map: &HashMap<String, String>) -> Result<String> {
        PdfRestorer { map }.restore(source, reply).map(|(text, _)| text)
    }

    #[test]
    fn native_formulas_and_style_tags_are_locally_protected() {
        let source = "The {v0} and {v12} <style id='2'>styled</style> text.";
        let mut map = HashMap::new();
        let protected = protect_pdf(source, &mut map);
        assert!(!protected.contains("{v"));
        assert!(!protected.contains("<style"));
        assert_eq!(map.len(), 4);
        assert_eq!(restore_piece(&protected, &protected, &map).unwrap(), source);
        assert!(restore_piece(&protected, &protected.replace("DOCFLOWKEEP000001TOKEN", ""), &map).is_err());
    }

    #[test]
    fn pdf_markers_cannot_be_invented_or_reordered() {
        for invalid in ["只有 {v1}", "{v1} {v0}", "{v0} {v1} {v2}", "{v0} {V1}"] {
            assert!(validate_pdf_markers("Before {v0} after {v1}", invalid).is_err());
        }
        validate_pdf_markers("Before {v0} after {v1}", "之前 {v0} 之后 {v1}").unwrap();
    }

    #[test]
    fn native_recovery_never_changes_formula_identity_by_position() {
        let mut map = HashMap::new();
        let source = protect_pdf("{v0} is smaller than {v1}", &mut map);
        for damaged in [
            "DOCFLOWKEEP000001TOKEN 大于 DOCFLOWKEEP000000TOKEN",
            "DOCFLOWKEEP000000TOKEN 小于 DOCFLOWKEEP000000TOKEN",
            "DOCFLOWKEEP999999TOKEN 小于 DOCFLOWKEEP000001TOKEN",
        ] {
            assert!(restore_piece(&source, damaged, &map).is_err());
        }
        assert_eq!(
            restore_piece(&source, "`DOCFLOW KEEP 0 0 0 0 0 0 TOKEN` 小于 DOCFLOWKEEP000001TOKEN", &map).unwrap(),
            "{v0} 小于 {v1}"
        );
    }

    #[test]
    fn marker_ids_are_unique_across_a_batch() {
        let mut map = HashMap::new();
        let a = protect_pdf("A {v0}", &mut map);
        let b = protect_pdf("B {v0} <segment id=\"1\">", &mut map);
        assert_ne!(a, b.replace('B', "A"));
        assert_eq!(restore_piece(&a, &a, &map).unwrap(), "A {v0}");
        assert_eq!(restore_pdf_source(&b, &map), "B {v0} <segment id=\"1\">");
    }

    #[test]
    fn native_requests_use_the_pdf_protocol() {
        let runtime = super::super::tests::test_runtime();
        let translator = Translator::Llm(Arc::new(LlmTarget {
            provider_id: "p".into(),
            provider_name: "P".into(),
            endpoint: crate::providers::Endpoint {
                kind: crate::providers::ProviderType::Openai,
                base_url: "https://example.com/v1".into(),
                extra_body: Default::default(),
            },
            model: "m".into(),
            keys: vec![],
            concurrency: 100,
        }));
        for mode in [Mode::Pdf, Mode::PdfStrict, Mode::PdfIsolated] {
            let PoolRequest::Llm { system, .. } = build_request(&translator, &runtime, &[(0, "PDF paragraph".into())], mode) else {
                panic!("LLM request expected")
            };
            assert!(system.starts_with(&runtime.system_prompt));
            assert!(system.contains("PDF 原生段落翻译"));
        }
        assert_ne!(
            native_fingerprint(&translator, &runtime),
            native_fingerprint(&Translator::Google, &runtime)
        );
    }
}
