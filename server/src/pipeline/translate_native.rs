//! BabelDOC callbacks use the same provider requests, limits, retry policy and
//! administrator snapshot as MinerU. This module adds PDF marker protection and
//! paragraph assembly; it never creates another HTTP client or provider pool.
use super::*;
use std::sync::atomic::AtomicI32;

pub(crate) const MAX_PARAGRAPH_CHARS: usize = 200_000;

#[derive(Debug, Clone)]
pub(crate) struct NativeRequest {
    pub request_id: u64,
    pub text: String,
}

pub(crate) struct NativeSession {
    state: Arc<AppState>,
    document_id: String,
    strategy: TranslationStrategy,
    pub runtime: TranslationRuntimeSettings,
    pub progress: Arc<AtomicI32>,
    completed: AtomicUsize,
}

struct Paragraph {
    request_id: u64,
    original: String,
    protected_parts: Vec<String>,
    markers: HashMap<String, String>,
    cache_dir: PathBuf,
    output: Vec<Option<String>>,
}

impl NativeSession {
    pub async fn new(
        state: Arc<AppState>,
        id: &str,
        tier: i16,
        progress: Arc<AtomicI32>,
    ) -> Result<Arc<Self>> {
        let runtime =
            settings::document_translation_runtime(&state.pool, &state.config, id).await?;
        let key_name = if tier == 1 {
            settings::GOOGLE_TRANSLATE_API_KEY
        } else {
            settings::DEEPSEEK_API_KEY
        };
        let key = settings::get(&state.pool, &state.config.secret_key, key_name)
            .await?
            .filter(|value| !value.trim().is_empty())
            .context("该任务选择的翻译服务尚未配置密钥")?;
        let strategy = match tier {
            1 => TranslationStrategy::GoogleFast { api_key: key },
            2 => TranslationStrategy::DeepSeekBalanced { api_key: key },
            3 => TranslationStrategy::DeepSeekPrecise { api_key: key },
            _ => anyhow::bail!("PDF 原生翻译档位无效"),
        };
        Ok(Arc::new(Self {
            state,
            document_id: id.to_string(),
            strategy,
            runtime,
            progress,
            completed: AtomicUsize::new(0),
        }))
    }

    pub fn batch_limit(&self) -> usize {
        self.strategy
            .settings(&self.runtime)
            .max_segments_per_request
    }

    pub fn callback_workers(&self) -> usize {
        self.runtime
            .per_document_concurrency
            .saturating_mul(self.batch_limit())
            .clamp(1, 64)
    }

    async fn event(
        &self,
        stage: &str,
        message: &str,
        detail: Option<&str>,
        warning: bool,
    ) -> Result<()> {
        events::append(
            &self.state.pool,
            &self.document_id,
            EventInput {
                stage,
                state: if warning { "warning" } else { "running" },
                level: if warning { "warning" } else { "info" },
                progress: self.progress.load(Ordering::Relaxed),
                message,
                detail,
                current: Some(self.completed.load(Ordering::Relaxed) as i64),
                total: None,
            },
        )
        .await?;
        Ok(())
    }

    async fn submit(
        &self,
        segments: &[(usize, String)],
        mode: TranslationRequestMode,
    ) -> Result<PoolResponse> {
        let request = provider_request_segments(
            &self.document_id,
            segments,
            &self.strategy,
            &self.runtime,
            mode,
        );
        submit_scoped_request(
            &self.state,
            &self.document_id,
            request,
            RequestContext {
                stage: "pdf2zh_translation_retry",
                label: format!(
                    "PDF 原生翻译 {} 段的 {} 请求",
                    segments.len(),
                    self.strategy.provider().label()
                ),
                progress: 30,
                live_progress: Some(self.progress.clone()),
                current: None,
                total: None,
            },
        )
        .await
    }

    /// One future uses at most one provider slot at any time. The outer broker
    /// bounds the number of these futures by per_document_concurrency.
    pub async fn translate_batch(
        &self,
        requests: Vec<NativeRequest>,
    ) -> Result<Vec<(u64, String)>> {
        anyhow::ensure!(
            !requests.is_empty() && requests.len() <= self.batch_limit(),
            "原生翻译批次段数无效"
        );
        let mut paragraphs = Vec::with_capacity(requests.len());
        for request in requests {
            anyhow::ensure!(
                request.text.chars().count() <= MAX_PARAGRAPH_CHARS,
                "PDF 段落异常长，拒绝超量解析结果"
            );
            let (protected, markers) = protect_pdf(&request.text)?;
            let mut parts = chunk(
                &protected,
                self.strategy.settings(&self.runtime).chunk_chars,
            );
            if parts.is_empty() {
                parts.push(protected);
            }
            let fingerprint = native_fingerprint(&self.strategy, &self.runtime, &request.text);
            let cache_dir =
                super::super::document_root(&self.state.config.work_root, &self.document_id)?
                    .join("native-translation-cache-v1")
                    .join(fingerprint);
            tokio::fs::create_dir_all(&cache_dir).await?;
            let count = parts.len();
            paragraphs.push(Paragraph {
                request_id: request.request_id,
                original: request.text,
                protected_parts: parts,
                markers,
                cache_dir,
                output: vec![None; count],
            });
        }

        // Each pending part retains its own marker map. Equal {v0} placeholders
        // in separate PDF paragraphs must never share or overwrite one mapping.
        let mut locations = Vec::new();
        let mut sources = Vec::new();
        let mut cache_hits = 0;
        for (paragraph_index, paragraph) in paragraphs.iter_mut().enumerate() {
            for (part_index, source) in paragraph.protected_parts.iter().enumerate() {
                if source.trim().is_empty() {
                    paragraph.output[part_index] = Some(source.clone());
                } else if let Some(cached) =
                    load_chunk_cache(&paragraph.cache_dir, part_index, &self.strategy, source).await
                {
                    if validate_pdf_markers(
                        &restore_pdf_source(source, &paragraph.markers),
                        &cached,
                    )
                    .is_ok()
                    {
                        paragraph.output[part_index] = Some(cached);
                        cache_hits += 1;
                    } else {
                        locations.push((paragraph_index, part_index));
                        sources.push(source.clone());
                    }
                } else {
                    locations.push((paragraph_index, part_index));
                    sources.push(source.clone());
                }
            }
        }
        if cache_hits > 0 {
            self.event(
                "pdf2zh_translation_cache",
                &format!("复用 {cache_hits} 个已校验的 PDF 翻译断点"),
                Some("缓存与原始段落、档位、段长、批量参数及提示词指纹绑定"),
                false,
            )
            .await?;
        }

        for batch in plan_batches(&sources, &self.strategy, &self.runtime)? {
            self.event("pdf2zh_translation_batch", &format!("PDF 原生段落组批：{} 段进入全站 {} 池", batch.len(), self.strategy.provider().label()),
                Some(&format!("单段最多 {} 字符；单次请求最多 {} 段；本篇最多 {} 个在途请求。与 MinerU 共用并发和配额，不直接从 Python 调用云端", self.strategy.settings(&self.runtime).chunk_chars, self.batch_limit(), self.runtime.per_document_concurrency)), false).await?;
            let response = self
                .submit(&batch, TranslationRequestMode::PdfParagraph)
                .await;
            let mut retry = Vec::new();
            match response {
                Ok(response) => {
                    anyhow::ensure!(
                        response.texts.len() == batch.len(),
                        "PDF 批次译文段数不匹配"
                    );
                    for ((unit, source), text) in batch.iter().zip(&response.texts) {
                        let (paragraph_index, part_index) = locations[*unit];
                        let paragraph = &mut paragraphs[paragraph_index];
                        match restore_pdf_piece(source, text, &paragraph.markers) {
                            Ok(value) => self.store_piece(paragraph, part_index, value).await?,
                            Err(_) => retry.push((*unit, source.clone())),
                        }
                    }
                    self.event(
                        "pdf2zh_translation_batch_completed",
                        &format!("PDF 批次服务完成：{} 段", batch.len()),
                        Some(&format!(
                            "共享队列等待 {} ms；服务处理 {} ms；{}",
                            response.queue_wait.as_millis(),
                            response.service_time.as_millis(),
                            response.usage_detail.as_deref().unwrap_or("无用量信息")
                        )),
                        false,
                    )
                    .await?;
                }
                Err(error)
                    if error
                        .downcast_ref::<ProviderError>()
                        .is_some_and(|error| error.split_retry) =>
                {
                    retry = batch
                }
                Err(error) => return Err(error),
            }
            // Save valid parts first. Recover only damaged parts; never replace
            // a failed translation with its untranslated source silently.
            for (unit, source) in retry {
                let (paragraph_index, part_index) = locations[unit];
                self.event(
                    "pdf2zh_translation_repair",
                    "PDF 译文结构校验未通过，改为单段和公式隔离恢复",
                    Some("公式与样式保留在本机；无法完整恢复时停止任务，不发布部分未翻译的 PDF"),
                    true,
                )
                .await?;
                let value = self
                    .recover_piece(&source, &paragraphs[paragraph_index].markers)
                    .await?;
                self.store_piece(&mut paragraphs[paragraph_index], part_index, value)
                    .await?;
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
            let done = self.completed.fetch_add(1, Ordering::Relaxed) + 1;
            self.event(
                "pdf2zh_translation_completed",
                &format!(
                    "第 {} 个 PDF 段落已完成，累计回填 {done} 段",
                    paragraph.request_id
                ),
                None,
                false,
            )
            .await?;
            replies.push((paragraph.request_id, output));
        }
        Ok(replies)
    }

    async fn store_piece(
        &self,
        paragraph: &mut Paragraph,
        index: usize,
        value: String,
    ) -> Result<()> {
        let source = &paragraph.protected_parts[index];
        let value = preserve_boundary_whitespace(source, &value);
        let assembled_chars = paragraph
            .output
            .iter()
            .enumerate()
            .filter(|(piece, _)| *piece != index)
            .filter_map(|(_, text)| text.as_ref())
            .map(|text| text.chars().count())
            .sum::<usize>();
        anyhow::ensure!(
            assembled_chars + value.chars().count() <= MAX_PARAGRAPH_CHARS,
            "PDF 段落译文异常膨胀，超过排版器安全回填上限"
        );
        if let Err(error) =
            save_chunk_cache(&paragraph.cache_dir, index, &self.strategy, source, &value).await
        {
            self.event(
                "pdf2zh_translation_cache_warning",
                "PDF 分段已翻译，但断点保存失败",
                Some(&error.to_string()),
                true,
            )
            .await?;
        }
        paragraph.output[index] = Some(value);
        Ok(())
    }

    async fn recover_piece(
        &self,
        source: &str,
        markers: &HashMap<String, String>,
    ) -> Result<String> {
        match self
            .submit(
                &[(0, source.to_string())],
                TranslationRequestMode::PdfStrictPlaceholders,
            )
            .await
        {
            Ok(response) => {
                if let Some(text) = response.texts.first()
                    && let Ok(restored) = restore_pdf_piece(source, text, markers)
                {
                    return Ok(restored);
                }
            }
            Err(error)
                if error
                    .downcast_ref::<ProviderError>()
                    .is_some_and(|error| error.split_retry) => {}
            Err(error) => return Err(error),
        }
        let tokens = expected_tokens(source, markers);
        let mut assembled = String::new();
        for piece in isolate_protected_pieces(source, &tokens)? {
            match piece {
                IsolatedPiece::Token(token) => assembled.push_str(&token),
                IsolatedPiece::Text(text) => {
                    for text in hard_split(
                        &text,
                        self.strategy.settings(&self.runtime).chunk_chars.min(2_000),
                    ) {
                        let Some((start, end)) = non_whitespace_bounds(&text) else {
                            assembled.push_str(&text);
                            continue;
                        };
                        let response = self
                            .submit(
                                &[(0, text[start..end].to_string())],
                                TranslationRequestMode::PdfIsolatedText,
                            )
                            .await?;
                        let translated = strip_wrapper(
                            response.texts.first().context("PDF 隔离翻译没有返回文本")?,
                        )
                        .replace(['\u{200b}', '\u{feff}'], "");
                        anyhow::ensure!(!translated.trim().is_empty(), "PDF 隔离片段译文为空");
                        validate_pdf_markers(&text[start..end], &translated)?;
                        anyhow::ensure!(
                            !translated.contains("DOCFLOWKEEP"),
                            "PDF 隔离片段包含额外保护标记"
                        );
                        assembled.push_str(&preserve_boundary_whitespace(&text, &translated));
                    }
                }
            }
        }
        restore_pdf_piece(source, &assembled, markers)
    }
}

fn native_marker_regex() -> Regex {
    Regex::new(r"(?i)\{\s*v\s*\d+\s*\}|<style\b[^>]*>|</style\s*>")
        .expect("static PDF marker regex")
}

fn protect_pdf(source: &str) -> Result<(String, HashMap<String, String>)> {
    let regex =
        Regex::new(r"(?i)DOCFLOWKEEP\d{6}TOKEN|\{\s*v\s*\d+\s*\}|<style\b[^>]*>|</style\s*>")?;
    let mut markers = HashMap::new();
    let protected = regex
        .replace_all(source, |capture: &regex::Captures| {
            let token = format!("DOCFLOWKEEP{:06}TOKEN", markers.len());
            markers.insert(token.clone(), capture[0].to_string());
            token
        })
        .into_owned();
    Ok((protected, markers))
}

fn restore_pdf_source(source: &str, markers: &HashMap<String, String>) -> String {
    Regex::new(r"DOCFLOWKEEP[0-9]{6}TOKEN")
        .expect("static protection regex")
        .replace_all(source, |capture: &regex::Captures| {
            markers
                .get(&capture[0])
                .cloned()
                .unwrap_or_else(|| capture[0].to_string())
        })
        .into_owned()
}

fn restore_pdf_piece(
    source: &str,
    translated: &str,
    markers: &HashMap<String, String>,
) -> Result<String> {
    let tokens = expected_tokens(source, markers);
    let (restored, _) = restore_with_policy(&strip_wrapper(translated), &tokens, markers, false)?;
    validate_pdf_markers(&restore_pdf_source(source, markers), &restored)?;
    Ok(restored)
}

fn validate_pdf_markers(source: &str, translated: &str) -> Result<()> {
    let regex = native_marker_regex();
    let expected = regex
        .find_iter(source)
        .map(|m| m.as_str())
        .collect::<Vec<_>>();
    let actual = regex
        .find_iter(translated)
        .map(|m| m.as_str())
        .collect::<Vec<_>>();
    anyhow::ensure!(expected == actual, "PDF 公式或样式标记丢失、增加或顺序改变");
    Ok(())
}

fn native_fingerprint(
    strategy: &TranslationStrategy,
    runtime: &TranslationRuntimeSettings,
    source: &str,
) -> String {
    source_sha256(&format!(
        "babeldoc-0.6.4-plain-strict-v2:{}",
        translation_fingerprint(strategy, runtime, source)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_formulas_and_style_tags_are_locally_protected() {
        let source = "The {v0} and {v12} <style id='2'>styled</style> text.";
        let (protected, markers) = protect_pdf(source).unwrap();
        assert!(!protected.contains("{v"));
        assert!(!protected.contains("<style"));
        assert_eq!(markers.len(), 4);
        assert_eq!(
            restore_pdf_piece(&protected, &protected, &markers).unwrap(),
            source
        );
        assert!(
            restore_pdf_piece(
                &protected,
                &protected.replace("DOCFLOWKEEP000001TOKEN", ""),
                &markers
            )
            .is_err()
        );
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
        let (source, markers) = protect_pdf("{v0} is smaller than {v1}").unwrap();
        for damaged in [
            "DOCFLOWKEEP000001TOKEN 大于 DOCFLOWKEEP000000TOKEN",
            "DOCFLOWKEEP000000TOKEN 小于 DOCFLOWKEEP000000TOKEN",
            "DOCFLOWKEEP999999TOKEN 小于 DOCFLOWKEEP000001TOKEN",
        ] {
            assert!(restore_pdf_piece(&source, damaged, &markers).is_err());
        }
        assert_eq!(
            restore_pdf_piece(
                &source,
                "`DOCFLOW KEEP 0 0 0 0 0 0 TOKEN` 小于 DOCFLOWKEEP000001TOKEN",
                &markers
            )
            .unwrap(),
            "{v0} 小于 {v1}"
        );
    }

    #[test]
    fn marker_ids_are_independent_for_each_paragraph() {
        let (a, map_a) = protect_pdf("A {v0}").unwrap();
        let (b, map_b) = protect_pdf("B {v19}").unwrap();
        assert_eq!(restore_pdf_piece(&a, &a, &map_a).unwrap(), "A {v0}");
        assert_eq!(restore_pdf_piece(&b, &b, &map_b).unwrap(), "B {v19}");
    }

    #[test]
    fn native_requests_keep_admin_prompt_but_do_not_ask_for_markdown() {
        let runtime = super::super::tests::test_runtime();
        let strategy = TranslationStrategy::DeepSeekPrecise {
            api_key: "test".into(),
        };
        for mode in [
            TranslationRequestMode::PdfParagraph,
            TranslationRequestMode::PdfStrictPlaceholders,
            TranslationRequestMode::PdfIsolatedText,
        ] {
            let request = provider_request("doc", "PDF paragraph", &strategy, mode, &runtime);
            let PoolRequest::DeepSeek {
                system, thinking, ..
            } = request
            else {
                panic!("DeepSeek expected")
            };
            assert!(system.starts_with(&runtime.system_prompt));
            assert!(system.contains("PDF 原生段落翻译"));
            assert!(thinking);
        }
    }

    #[test]
    fn native_caches_are_distinct_from_markdown_and_prompt_sensitive() {
        let mut runtime = super::super::tests::test_runtime();
        let strategy = TranslationStrategy::DeepSeekBalanced {
            api_key: "test".into(),
        };
        let first = native_fingerprint(&strategy, &runtime, "Same {v0}");
        assert_ne!(
            first,
            translation_fingerprint(&strategy, &runtime, "Same {v0}")
        );
        runtime.system_prompt.push_str("Use terminology.");
        assert_ne!(first, native_fingerprint(&strategy, &runtime, "Same {v0}"));
    }
}
