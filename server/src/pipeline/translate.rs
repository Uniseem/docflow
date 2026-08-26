use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use anyhow::{Context, Result};
use futures::StreamExt;
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    db::AppState,
    events::{self, EventInput},
    translation_pool::{PoolRequest, ProviderKind},
};

#[derive(Debug, Clone)]
pub enum TranslationStrategy {
    GoogleFast { api_key: String },
    DeepSeekBalanced { api_key: String },
    DeepSeekPrecise { api_key: String },
}

impl TranslationStrategy {
    fn tier(&self) -> i16 {
        match self {
            Self::GoogleFast { .. } => 1,
            Self::DeepSeekBalanced { .. } => 2,
            Self::DeepSeekPrecise { .. } => 3,
        }
    }

    fn name(&self) -> &'static str {
        match self {
            Self::GoogleFast { .. } => "极速",
            Self::DeepSeekBalanced { .. } => "均衡",
            Self::DeepSeekPrecise { .. } => "精准",
        }
    }

    fn engine(&self) -> &'static str {
        match self {
            Self::GoogleFast { .. } => "Google Cloud Translation Basic v2",
            Self::DeepSeekBalanced { .. } => "deepseek-v4-flash（非思考模式）",
            Self::DeepSeekPrecise { .. } => "deepseek-v4-flash（思考模式）",
        }
    }

    fn provider(&self) -> ProviderKind {
        match self {
            Self::GoogleFast { .. } => ProviderKind::Google,
            Self::DeepSeekBalanced { .. } | Self::DeepSeekPrecise { .. } => ProviderKind::DeepSeek,
        }
    }

    fn chunk_limit(&self, configured: usize) -> usize {
        match self {
            // Google 官方建议单次最多 5,000 Unicode code points；预留 10% 余量。
            Self::GoogleFast { .. } => 4_500,
            // V4 Flash 有 1M 上下文；主动保持小块，降低尾延迟与失败重传成本。
            Self::DeepSeekBalanced { .. } => configured.min(12_000),
            // 思考 token 与可见输出共用 max_tokens，精准档使用更小输入块。
            Self::DeepSeekPrecise { .. } => configured.min(8_000),
        }
        .max(500)
    }

    fn thinking(&self) -> bool {
        matches!(self, Self::DeepSeekPrecise { .. })
    }
}

pub struct TranslationOutput {
    pub markdown: String,
    pub guidance: Option<String>,
}

#[derive(Debug, Clone, Copy)]
enum TranslationRequestMode {
    Standard,
    StrictPlaceholders,
    IsolatedText,
}

#[derive(Debug, Serialize, Deserialize)]
struct ChunkCacheEntry {
    version: u8,
    source_sha256: String,
    tier: i16,
    markdown: String,
}

#[derive(Debug)]
enum IsolatedPiece {
    Text(String),
    Token(String),
}

pub async fn translate(
    state: &Arc<AppState>,
    id: &str,
    markdown: &str,
    strategy: &TranslationStrategy,
) -> Result<TranslationOutput> {
    let pools = state
        .translation_pools
        .as_ref()
        .context("Worker 未初始化全站翻译任务池")?;
    let pool_concurrency = pools.concurrency(strategy.provider());
    let per_document = state.config.translation_per_document_concurrency;
    let chunk_limit = strategy.chunk_limit(state.config.translation_chunk_chars);
    events::progress(
        &state.pool,
        id,
        "translation_pool_selected",
        71,
        &format!(
            "已选择第 {} 档：{}，正在准备并发翻译",
            strategy.tier(),
            strategy.name()
        ),
        Some(&format!(
            "执行引擎：{}；全站 {} 共享池并发 {}；本任务最多同时提交 {} 个分块；单块上限 {} Unicode 字符",
            strategy.engine(),
            strategy.provider().label(),
            pool_concurrency,
            per_document,
            chunk_limit
        )),
    )
    .await?;

    let (protected, placeholders) = protect(markdown)?;
    let chunks = chunk(&protected, chunk_limit);
    if chunks.is_empty() {
        anyhow::bail!("文档没有可翻译文本");
    }
    let count = chunks.len();
    let cache_dir = Arc::new(translation_cache_dir(state, id)?);
    tokio::fs::create_dir_all(cache_dir.as_ref())
        .await
        .context("无法创建翻译断点缓存目录")?;
    events::append(
        &state.pool,
        id,
        EventInput {
            stage: "translation_chunks_prepared",
            state: "completed",
            level: "success",
            progress: 72,
            message: &format!("并发计划已生成：共 {count} 个翻译分块"),
            detail: Some(&format!(
                "原文 {} 字符；保护 {} 个公式、代码、图片或链接；采用全站 FIFO 公平队列并按原始序号回收结果；每个成功分块立即写入本地断点缓存",
                markdown.chars().count(),
                placeholders.len()
            )),
            current: Some(0),
            total: Some(count as i64),
        },
    )
    .await?;

    let completed = Arc::new(AtomicUsize::new(0));
    let placeholders = Arc::new(placeholders);
    let strategy = Arc::new(strategy.clone());
    let work = futures::stream::iter(chunks.into_iter().enumerate().map(|(index, source)| {
        let state = state.clone();
        let id = id.to_string();
        let placeholders = placeholders.clone();
        let strategy = strategy.clone();
        let completed = completed.clone();
        let cache_dir = cache_dir.clone();
        async move {
            translate_chunk(
                &state,
                &id,
                index,
                count,
                source,
                &placeholders,
                &strategy,
                completed,
                &cache_dir,
            )
            .await
        }
    }))
    .buffer_unordered(per_document);

    let results = work.collect::<Vec<_>>().await;
    let mut translated = Vec::with_capacity(count);
    for result in results {
        translated.push(result?);
    }
    translated.sort_by_key(|(index, _)| *index);
    let markdown = translated
        .into_iter()
        .map(|(_, value)| value)
        .collect::<Vec<_>>()
        .join("\n\n");

    events::progress(
        &state.pool,
        id,
        "translation_completed",
        87,
        &format!(
            "{}档翻译完成，所有并发结果已按原文顺序合并",
            strategy.name()
        ),
        Some(&format!(
            "共完成 {count} / {count} 个分块；输出 {} 字符；占位符校验全部通过",
            markdown.chars().count()
        )),
    )
    .await?;
    Ok(TranslationOutput {
        markdown,
        guidance: None,
    })
}

#[allow(clippy::too_many_arguments)]
async fn translate_chunk(
    state: &Arc<AppState>,
    id: &str,
    index: usize,
    total: usize,
    source: String,
    placeholders: &HashMap<String, String>,
    strategy: &TranslationStrategy,
    completed: Arc<AtomicUsize>,
    cache_dir: &Path,
) -> Result<(usize, String)> {
    let number = index + 1;
    let tokens = expected_tokens(&source, placeholders);
    if let Some(value) = load_chunk_cache(cache_dir, index, strategy, &source).await {
        let done = completed.fetch_add(1, Ordering::SeqCst) + 1;
        let progress = progress_for(done, total);
        sqlx::query("UPDATE documents SET progress=GREATEST(progress,$2),stage='translation_concurrent',updated_at=NOW(),last_heartbeat_at=NOW() WHERE id=$1")
            .bind(id)
            .bind(progress)
            .execute(&state.pool)
            .await?;
        events::append(
            &state.pool,
            id,
            EventInput {
                stage: "translation_chunk_cache_hit",
                state: "completed",
                level: "success",
                progress,
                message: &format!(
                    "分块 {number} 已从本地断点恢复；总体已完成 {done} / {total}"
                ),
                detail: Some(
                    "该分块曾在较早的任务尝试中通过全部校验；已核对源文本 SHA-256 和翻译档位，无需再次调用翻译服务",
                ),
                current: Some(done as i64),
                total: Some(total as i64),
            },
        )
        .await?;
        return Ok((index, value));
    }
    events::append(
        &state.pool,
        id,
        EventInput {
            stage: "translation_pool_queued",
            state: "running",
            level: "info",
            progress: progress_for(completed.load(Ordering::Relaxed), total),
            message: &format!("分块 {number} / {total} 已进入全站共享队列"),
            detail: Some(&format!(
                "目标池：{}；输入 {} 字符；含 {} 个受保护占位符；等待任一空闲执行槽",
                strategy.provider().label(),
                source.chars().count(),
                tokens.len()
            )),
            current: Some(number as i64),
            total: Some(total as i64),
        },
    )
    .await?;

    let mut placeholder_error = None;
    for validation_attempt in 1..=2 {
        let mode = if validation_attempt == 1 {
            TranslationRequestMode::Standard
        } else {
            TranslationRequestMode::StrictPlaceholders
        };
        let response = submit_with_retry(
            state,
            id,
            number,
            total,
            &source,
            strategy,
            mode,
            completed.load(Ordering::Relaxed),
        )
        .await?;
        let candidate = strip_wrapper(&response.text);
        match restore_detailed(&candidate, &tokens, placeholders) {
            Ok((value, repaired)) => {
                if repaired {
                    events::append(
                        &state.pool,
                        id,
                        EventInput {
                            stage: "translation_placeholder_repaired",
                            state: "completed",
                            level: "warning",
                            progress: progress_for(completed.load(Ordering::Relaxed), total),
                            message: &format!(
                                "分块 {number} 的保护标记已在本地无损修复"
                            ),
                            detail: Some(
                                "模型改变了保护标记的空格、编号或重复关系；程序按原文出现顺序重新映射，并在恢复公式、代码和链接前再次确认每个标记恰好出现一次",
                            ),
                            current: Some(number as i64),
                            total: Some(total as i64),
                        },
                    )
                    .await?;
                }
                let detail = format!(
                    "队列等待 {} ms；服务处理 {} ms；{}；占位符校验第 {validation_attempt} 次通过{}",
                    response.queue_wait.as_millis(),
                    response.service_time.as_millis(),
                    response
                        .usage_detail
                        .as_deref()
                        .unwrap_or("服务未返回 token 用量"),
                    if repaired {
                        "（含本地顺序修复）"
                    } else {
                        ""
                    }
                );
                return finish_translated_chunk(
                    state, id, index, total, &source, strategy, completed, cache_dir, value,
                    &detail,
                )
                .await;
            }
            Err(error) => {
                placeholder_error = Some(error.to_string());
                if validation_attempt < 2 {
                    events::append(
                        &state.pool,
                        id,
                        EventInput {
                            stage: "translation_placeholder_retry",
                            state: "warning",
                            level: "warning",
                            progress: progress_for(completed.load(Ordering::Relaxed), total),
                            message: &format!("分块 {number} 的保护标记无法安全修复，正在严格重译"),
                            detail: placeholder_error.as_deref(),
                            current: Some(validation_attempt),
                            total: Some(2),
                        },
                    )
                    .await?;
                }
            }
        }
    }

    events::append(
        &state.pool,
        id,
        EventInput {
            stage: "translation_fragment_fallback",
            state: "warning",
            level: "warning",
            progress: progress_for(completed.load(Ordering::Relaxed), total),
            message: &format!("分块 {number} 已切换为保护内容隔离翻译"),
            detail: Some(&format!(
                "两次整块翻译都无法通过无损校验：{}。接下来公式、代码、图片和链接不会再发送给翻译服务；程序只翻译它们之间的普通文本，再按原始位置拼回",
                placeholder_error.as_deref().unwrap_or("未知保护标记错误")
            )),
            current: Some(number as i64),
            total: Some(total as i64),
        },
    )
    .await?;

    let (value, fragment_count) = translate_isolated_fragments(
        state,
        id,
        number,
        total,
        &source,
        &tokens,
        placeholders,
        strategy,
        completed.load(Ordering::Relaxed),
    )
    .await
    .with_context(|| format!("分块 {number} 的保护内容隔离翻译仍未成功"))?;
    finish_translated_chunk(
        state,
        id,
        index,
        total,
        &source,
        strategy,
        completed,
        cache_dir,
        value,
        &format!(
            "整块翻译连续损坏保护标记后，已完成 {fragment_count} 个普通文本片段；公式、代码、图片和链接由本地程序按原位无损拼回"
        ),
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn finish_translated_chunk(
    state: &Arc<AppState>,
    id: &str,
    index: usize,
    total: usize,
    source: &str,
    strategy: &TranslationStrategy,
    completed: Arc<AtomicUsize>,
    cache_dir: &Path,
    value: String,
    detail: &str,
) -> Result<(usize, String)> {
    let number = index + 1;
    if let Err(error) = save_chunk_cache(cache_dir, index, strategy, source, &value).await {
        let warning = format!("分块 {number} 已翻译成功，但断点缓存写入失败：{error:#}");
        let _ = events::append(
            &state.pool,
            id,
            EventInput {
                stage: "translation_cache_warning",
                state: "warning",
                level: "warning",
                progress: progress_for(completed.load(Ordering::Relaxed), total),
                message: "翻译结果可继续使用，但本次无法保存断点缓存",
                detail: Some(&warning),
                current: Some(number as i64),
                total: Some(total as i64),
            },
        )
        .await;
    }
    let done = completed.fetch_add(1, Ordering::SeqCst) + 1;
    let progress = progress_for(done, total);
    sqlx::query("UPDATE documents SET progress=GREATEST(progress,$2),stage='translation_concurrent',updated_at=NOW(),last_heartbeat_at=NOW() WHERE id=$1")
        .bind(id)
        .bind(progress)
        .execute(&state.pool)
        .await?;
    events::append(
        &state.pool,
        id,
        EventInput {
            stage: "translation_chunk_completed",
            state: "completed",
            level: "success",
            progress,
            message: &format!("分块 {number} 翻译完成；总体已完成 {done} / {total}"),
            detail: Some(detail),
            current: Some(done as i64),
            total: Some(total as i64),
        },
    )
    .await?;
    Ok((index, value))
}

#[allow(clippy::too_many_arguments)]
async fn translate_isolated_fragments(
    state: &Arc<AppState>,
    id: &str,
    number: usize,
    total: usize,
    source: &str,
    tokens: &[String],
    placeholders: &HashMap<String, String>,
    strategy: &TranslationStrategy,
    overall_completed: usize,
) -> Result<(String, usize)> {
    let pieces = isolate_protected_pieces(source, tokens)?;
    let fragment_count = pieces
        .iter()
        .filter(|piece| matches!(piece, IsolatedPiece::Text(value) if !value.trim().is_empty()))
        .count();
    let mut fragment_number = 0usize;
    let mut assembled = String::with_capacity(source.len());
    for piece in pieces {
        match piece {
            IsolatedPiece::Token(token) => assembled.push_str(&token),
            IsolatedPiece::Text(text) => {
                let Some((start, end)) = non_whitespace_bounds(&text) else {
                    assembled.push_str(&text);
                    continue;
                };
                fragment_number += 1;
                events::append(
                    &state.pool,
                    id,
                    EventInput {
                        stage: "translation_fragment_queued",
                        state: "running",
                        level: "info",
                        progress: progress_for(overall_completed, total),
                        message: &format!(
                            "分块 {number} 的隔离片段 {fragment_number} / {fragment_count} 已进入共享队列"
                        ),
                        detail: Some(&format!(
                            "仅发送 {} 个普通文本字符；受保护内容保留在本地，不会被翻译服务改写",
                            text[start..end].chars().count()
                        )),
                        current: Some(fragment_number as i64),
                        total: Some(fragment_count as i64),
                    },
                )
                .await?;
                let response = submit_with_retry(
                    state,
                    id,
                    number,
                    total,
                    &text[start..end],
                    strategy,
                    TranslationRequestMode::IsolatedText,
                    overall_completed,
                )
                .await?;
                let translated = strip_wrapper(&response.text);
                if translated.trim().is_empty() {
                    anyhow::bail!("隔离片段 {fragment_number} 返回空译文");
                }
                assembled.push_str(&text[..start]);
                assembled.push_str(&translated);
                assembled.push_str(&text[end..]);
                events::append(
                    &state.pool,
                    id,
                    EventInput {
                        stage: "translation_fragment_completed",
                        state: "completed",
                        level: "success",
                        progress: progress_for(overall_completed, total),
                        message: &format!(
                            "分块 {number} 的隔离片段 {fragment_number} / {fragment_count} 翻译完成"
                        ),
                        detail: response.usage_detail.as_deref(),
                        current: Some(fragment_number as i64),
                        total: Some(fragment_count as i64),
                    },
                )
                .await?;
            }
        }
    }
    let (restored, _) = restore_detailed(&assembled, tokens, placeholders)?;
    Ok((restored, fragment_count))
}

#[allow(clippy::too_many_arguments)]
async fn submit_with_retry(
    state: &Arc<AppState>,
    id: &str,
    number: usize,
    total: usize,
    source: &str,
    strategy: &TranslationStrategy,
    mode: TranslationRequestMode,
    overall_completed: usize,
) -> Result<crate::translation_pool::PoolResponse> {
    let pools = state
        .translation_pools
        .as_ref()
        .context("全站翻译任务池不可用")?;
    let request = provider_request(id, source, strategy, mode);
    for attempt in 1u32..=4 {
        match pools.submit(request.clone()).await {
            Ok(response) => return Ok(response),
            Err(error) if error.retryable && attempt < 4 => {
                let delay = error
                    .retry_after
                    .unwrap_or_else(|| Duration::from_secs(2u64.pow((attempt - 1).min(3))));
                events::append(
                    &state.pool,
                    id,
                    EventInput {
                        stage: "translation_provider_retry",
                        state: "warning",
                        level: "warning",
                        progress: progress_for(overall_completed, total),
                        message: &format!(
                            "分块 {number} 的 {} 请求暂时失败，{} ms 后重新排队",
                            strategy.provider().label(),
                            delay.as_millis()
                        ),
                        detail: Some(&format!(
                            "服务调用尝试 {attempt} / 4；重新入队可让其他用户任务继续公平执行；{}",
                            error.message.chars().take(400).collect::<String>()
                        )),
                        current: Some(number as i64),
                        total: Some(total as i64),
                    },
                )
                .await?;
                tokio::time::sleep(delay).await;
            }
            Err(error) => return Err(error.into()),
        }
    }
    unreachable!("fourth provider attempt always returns")
}

fn provider_request(
    id: &str,
    source: &str,
    strategy: &TranslationStrategy,
    mode: TranslationRequestMode,
) -> PoolRequest {
    match strategy {
        TranslationStrategy::GoogleFast { api_key } => PoolRequest::Google {
            api_key: api_key.clone(),
            content: source.to_string(),
        },
        TranslationStrategy::DeepSeekBalanced { api_key }
        | TranslationStrategy::DeepSeekPrecise { api_key } => {
            let placeholder_rule = match mode {
                TranslationRequestMode::Standard => {
                    "所有 DOCFLOWKEEP000000TOKEN 形式的占位符必须原样保留且各出现一次。"
                }
                TranslationRequestMode::StrictPlaceholders => {
                    "所有 DOCFLOWKEEP 加六位数字加 TOKEN 的占位符必须逐字符原样输出且各出现一次；输出前逐个核对，禁止插入空格、反引号或换行。"
                }
                TranslationRequestMode::IsolatedText => {
                    "本次输入只包含普通 Markdown 文本片段，不含被程序隔离的公式、代码、图片或链接。不要自行添加 DOCFLOWKEEP 标记，也不要补写输入中不存在的技术内容。"
                }
            };
            PoolRequest::DeepSeek {
                api_key: api_key.clone(),
                system: format!(
                    "你是严谨的学术文献译者。把用户提供的 Markdown 准确翻译成简体中文，保持标题、列表、表格、引用和换行结构，不合并、不遗漏、不解释、不加代码围栏。{placeholder_rule}"
                ),
                user: source.to_string(),
                thinking: strategy.thinking(),
                // 官方 max_tokens 同时包含思考 token 和最终可见输出。
                max_tokens: if strategy.thinking() { 32_768 } else { 16_384 },
                user_id: format!("doc_{}", id.replace('-', "")),
            }
        }
    }
}

fn translation_cache_dir(state: &AppState, id: &str) -> Result<PathBuf> {
    Ok(super::document_root(&state.config.work_root, id)?.join("translation-cache-v1"))
}

fn source_sha256(source: &str) -> String {
    format!("{:x}", Sha256::digest(source.as_bytes()))
}

fn chunk_cache_path(
    cache_dir: &Path,
    index: usize,
    strategy: &TranslationStrategy,
    source: &str,
) -> PathBuf {
    cache_dir.join(format!(
        "tier-{}-chunk-{index:06}-{}.json",
        strategy.tier(),
        source_sha256(source)
    ))
}

async fn load_chunk_cache(
    cache_dir: &Path,
    index: usize,
    strategy: &TranslationStrategy,
    source: &str,
) -> Option<String> {
    let path = chunk_cache_path(cache_dir, index, strategy, source);
    let bytes = tokio::fs::read(path).await.ok()?;
    let entry = serde_json::from_slice::<ChunkCacheEntry>(&bytes).ok()?;
    let expected_hash = source_sha256(source);
    (entry.version == 1
        && entry.source_sha256 == expected_hash
        && entry.tier == strategy.tier()
        && !entry.markdown.trim().is_empty())
    .then_some(entry.markdown)
}

async fn save_chunk_cache(
    cache_dir: &Path,
    index: usize,
    strategy: &TranslationStrategy,
    source: &str,
    markdown: &str,
) -> Result<()> {
    let path = chunk_cache_path(cache_dir, index, strategy, source);
    let temporary = path.with_extension("json.partial");
    let entry = ChunkCacheEntry {
        version: 1,
        source_sha256: source_sha256(source),
        tier: strategy.tier(),
        markdown: markdown.to_string(),
    };
    let bytes = serde_json::to_vec(&entry).context("无法序列化翻译断点")?;
    tokio::fs::write(&temporary, bytes)
        .await
        .context("无法写入临时翻译断点")?;
    if let Err(first_error) = tokio::fs::rename(&temporary, &path).await {
        if tokio::fs::try_exists(&path).await.unwrap_or(false) {
            tokio::fs::remove_file(&path)
                .await
                .context("无法替换已有翻译断点")?;
            tokio::fs::rename(&temporary, &path)
                .await
                .context("无法提交翻译断点")?;
        } else {
            return Err(first_error).context("无法提交翻译断点");
        }
    }
    Ok(())
}

fn isolate_protected_pieces(source: &str, tokens: &[String]) -> Result<Vec<IsolatedPiece>> {
    let token_re = Regex::new(r"DOCFLOWKEEP\d{6}TOKEN").expect("static placeholder regex");
    let matches = token_re.find_iter(source).collect::<Vec<_>>();
    let found = matches
        .iter()
        .map(|value| value.as_str())
        .collect::<Vec<_>>();
    let expected = tokens.iter().map(String::as_str).collect::<Vec<_>>();
    if found != expected {
        anyhow::bail!("原文保护标记序列与映射不一致，拒绝执行隔离翻译");
    }

    let mut pieces = Vec::with_capacity(matches.len() * 2 + 1);
    let mut cursor = 0usize;
    for value in matches {
        if cursor < value.start() {
            pieces.push(IsolatedPiece::Text(
                source[cursor..value.start()].to_string(),
            ));
        }
        pieces.push(IsolatedPiece::Token(value.as_str().to_string()));
        cursor = value.end();
    }
    if cursor < source.len() {
        pieces.push(IsolatedPiece::Text(source[cursor..].to_string()));
    }
    Ok(pieces)
}

fn non_whitespace_bounds(value: &str) -> Option<(usize, usize)> {
    let start = value
        .char_indices()
        .find_map(|(index, ch)| (!ch.is_whitespace()).then_some(index))?;
    let end = value
        .char_indices()
        .rev()
        .find_map(|(index, ch)| (!ch.is_whitespace()).then_some(index + ch.len_utf8()))?;
    Some((start, end))
}

fn progress_for(completed: usize, total: usize) -> i32 {
    72 + ((completed * 15 / total.max(1)) as i32)
}

fn protect(markdown: &str) -> Result<(String, HashMap<String, String>)> {
    let re = Regex::new(
        r#"(?s:```[^\n]*\n.*?\n```)|(?s:~~~[^\n]*\n.*?\n~~~)|(?s:\$\$.*?\$\$)|(?s:\\\[.*?\\\])|\\\([^\n]*?\\\)|`+[^`\n]+`+|\$[^$\n]+\$|!\[[^\]]*\]\([^\n)]*\)|\[[^\]]+\]\([^\n)]*\)|<img\b[^>]*>"#,
    )?;
    let mut map = HashMap::new();
    let text = re
        .replace_all(markdown, |captures: &regex::Captures| {
            let token = format!("DOCFLOWKEEP{:06}TOKEN", map.len());
            map.insert(token.clone(), captures.get(0).unwrap().as_str().to_string());
            token
        })
        .into_owned();
    Ok((text, map))
}

fn expected_tokens(source: &str, map: &HashMap<String, String>) -> Vec<String> {
    let token_re = Regex::new(r"DOCFLOWKEEP\d{6}TOKEN").expect("static placeholder regex");
    token_re
        .find_iter(source)
        .map(|value| value.as_str())
        .filter(|token| map.contains_key(*token))
        .map(ToOwned::to_owned)
        .collect()
}

fn chunk(text: &str, limit: usize) -> Vec<String> {
    let mut result = Vec::new();
    let mut current = String::new();
    for block in text.split("\n\n") {
        for piece in hard_split(block, limit) {
            let extra = piece.chars().count() + if current.is_empty() { 0 } else { 2 };
            if !current.is_empty() && current.chars().count() + extra > limit {
                result.push(std::mem::take(&mut current));
            }
            if !current.is_empty() {
                current.push_str("\n\n");
            }
            current.push_str(&piece);
        }
    }
    if !current.trim().is_empty() {
        result.push(current)
    }
    result
}

fn hard_split(text: &str, limit: usize) -> Vec<String> {
    if text.chars().count() <= limit {
        return vec![text.to_string()];
    }
    let chars = text.chars().collect::<Vec<_>>();
    let token_re = Regex::new(r"DOCFLOWKEEP\d{6}TOKEN").expect("static placeholder regex");
    let token_ranges = token_re
        .find_iter(text)
        .map(|value| {
            (
                text[..value.start()].chars().count(),
                text[..value.end()].chars().count(),
            )
        })
        .collect::<Vec<_>>();
    let mut result = Vec::new();
    let mut start = 0usize;
    while start < chars.len() {
        let mut end = (start + limit).min(chars.len());
        if let Some((_, token_end)) = token_ranges
            .iter()
            .find(|(token_start, token_end)| *token_start < end && end < *token_end)
        {
            end = *token_end;
        }
        result.push(chars[start..end].iter().collect());
        start = end;
    }
    result
}

fn strip_wrapper(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.starts_with("```markdown") || trimmed.starts_with("```md") {
        trimmed
            .lines()
            .skip(1)
            .collect::<Vec<_>>()
            .join("\n")
            .strip_suffix("```")
            .unwrap_or(trimmed)
            .trim()
            .to_string()
    } else {
        trimmed.to_string()
    }
}

fn restore_detailed(
    text: &str,
    tokens: &[String],
    map: &HashMap<String, String>,
) -> Result<(String, bool)> {
    let mut value = text.replace(['\u{200b}', '\u{feff}'], "");
    let mut repaired = value != text;
    for token in tokens {
        let digits = &token[11..17];
        let pattern = format!(
            r"(?i)(?:`+[ \t]*)?D[ \t_-]*O[ \t_-]*C[ \t_-]*F[ \t_-]*L[ \t_-]*O[ \t_-]*W[ \t_-]*K[ \t_-]*E[ \t_-]*E[ \t_-]*P[ \t_:-]*{}[ \t_-]*T[ \t_-]*O[ \t_-]*K[ \t_-]*E[ \t_-]*N(?:[ \t]*`+)?",
            digits
                .chars()
                .map(|value| value.to_string())
                .collect::<Vec<_>>()
                .join(r"[ \t_-]*")
        );
        let normalized = Regex::new(&pattern)?
            .replace_all(&value, token.as_str())
            .into_owned();
        if normalized != value {
            repaired = true;
        }
        value = normalized;
    }

    let marker_re = Regex::new(
        r"(?i)(?:`+[ \t]*)?D[ \t_-]*O[ \t_-]*C[ \t_-]*F[ \t_-]*L[ \t_-]*O[ \t_-]*W[ \t_-]*K[ \t_-]*E[ \t_-]*E[ \t_-]*P[ \t_:-]*(?:[0-9][ \t_-]*){1,12}T[ \t_-]*O[ \t_-]*K[ \t_-]*E[ \t_-]*N(?:[ \t]*`+)?",
    )?;
    let marker_values = marker_re
        .find_iter(&value)
        .map(|value| value.as_str())
        .collect::<Vec<_>>();
    let marker_count = marker_values.len();
    let exact_sequence = marker_values
        .iter()
        .copied()
        .eq(tokens.iter().map(String::as_str));
    if !exact_sequence || marker_count != tokens.len() {
        if marker_count != tokens.len() {
            anyhow::bail!(
                "保护标记数量不匹配：原文需要 {} 个，译文检测到 {} 个",
                tokens.len(),
                marker_count
            );
        }
        let mut index = 0usize;
        value = marker_re
            .replace_all(&value, |_captures: &regex::Captures| {
                let token = tokens[index].clone();
                index += 1;
                token
            })
            .into_owned();
        repaired = true;
    }

    for token in tokens {
        if value.matches(token).count() != 1 {
            anyhow::bail!("保护标记 {token} 无法恢复为唯一位置");
        }
        map.get(token).context("占位映射丢失")?;
    }
    let exact_token_re = Regex::new(r"DOCFLOWKEEP\d{6}TOKEN")?;
    let restored = exact_token_re
        .replace_all(&value, |captures: &regex::Captures| {
            map.get(captures.get(0).unwrap().as_str())
                .expect("validated placeholder mapping")
                .as_str()
        })
        .into_owned();
    Ok((restored, repaired))
}

#[cfg(test)]
fn restore(text: &str, tokens: &[String], map: &HashMap<String, String>) -> Result<String> {
    restore_detailed(text, tokens, map).map(|(value, _)| value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protects_and_restores_technical_markdown() {
        let source = "解释 $E=mc^2$，运行 `cargo test`。\n\n![图](images/a.png)";
        let (protected, map) = protect(source).unwrap();
        let tokens = expected_tokens(&protected, &map);
        assert_eq!(tokens.len(), 3);
        assert_eq!(restore(&protected, &tokens, &map).unwrap(), source);
    }

    #[test]
    fn repairs_common_model_placeholder_damage() {
        let source = "公式 $$x+y$$";
        let (protected, map) = protect(source).unwrap();
        let tokens = expected_tokens(&protected, &map);
        let damaged =
            protected.replace("DOCFLOWKEEP000000TOKEN", "`DOCFLOW KEEP 0 0 0 0 0 0 TOKEN`");
        assert_eq!(restore(&damaged, &tokens, &map).unwrap(), source);
    }

    #[test]
    fn repairs_changed_placeholder_ids_by_source_order() {
        let source = "公式 $x$，再运行 `cargo test`。";
        let (protected, map) = protect(source).unwrap();
        let tokens = expected_tokens(&protected, &map);
        let damaged = protected.replace("DOCFLOWKEEP000001TOKEN", "DOCFLOWKEEP999999TOKEN");
        let (restored, repaired) = restore_detailed(&damaged, &tokens, &map).unwrap();
        assert!(repaired);
        assert_eq!(restored, source);
    }

    #[test]
    fn repairs_duplicate_placeholder_ids_by_source_order() {
        let source = "公式 $x$，再运行 `cargo test`。";
        let (protected, map) = protect(source).unwrap();
        let tokens = expected_tokens(&protected, &map);
        let damaged = protected.replace("DOCFLOWKEEP000001TOKEN", "DOCFLOWKEEP000000TOKEN");
        assert_eq!(restore(&damaged, &tokens, &map).unwrap(), source);
    }

    #[test]
    fn repairs_reordered_placeholders_by_source_order() {
        let source = "公式 $x$，再运行 `cargo test`。";
        let (protected, map) = protect(source).unwrap();
        let tokens = expected_tokens(&protected, &map);
        let damaged = protected
            .replace("DOCFLOWKEEP000000TOKEN", "DOCFLOWKEEPTEMP00TOKEN")
            .replace("DOCFLOWKEEP000001TOKEN", "DOCFLOWKEEP000000TOKEN")
            .replace("DOCFLOWKEEPTEMP00TOKEN", "DOCFLOWKEEP000001TOKEN");
        assert_eq!(restore(&damaged, &tokens, &map).unwrap(), source);
    }

    #[test]
    fn rejects_missing_placeholder_before_isolated_fallback() {
        let source = "公式 $x$，再运行 `cargo test`。";
        let (protected, map) = protect(source).unwrap();
        let tokens = expected_tokens(&protected, &map);
        let damaged = protected.replace("DOCFLOWKEEP000001TOKEN", "");
        let error = restore_detailed(&damaged, &tokens, &map).unwrap_err();
        assert!(error.to_string().contains("原文需要 2 个，译文检测到 1 个"));
    }

    #[test]
    fn isolates_protected_content_without_changing_order() {
        let source = "开头 $x$ 中间 `cargo test` 结尾";
        let (protected, map) = protect(source).unwrap();
        let tokens = expected_tokens(&protected, &map);
        let pieces = isolate_protected_pieces(&protected, &tokens).unwrap();
        let assembled = pieces
            .into_iter()
            .map(|piece| match piece {
                IsolatedPiece::Text(value) | IsolatedPiece::Token(value) => value,
            })
            .collect::<String>();
        assert_eq!(assembled, protected);
    }

    #[test]
    fn whitespace_bounds_are_utf8_safe() {
        let value = " \n\t中文片段　";
        let (start, end) = non_whitespace_bounds(value).unwrap();
        assert_eq!(&value[start..end], "中文片段");
        assert_eq!(non_whitespace_bounds(" \n\t"), None);
    }

    #[test]
    fn cache_key_changes_with_tier_and_source() {
        let directory = Path::new("cache");
        let fast = TranslationStrategy::GoogleFast {
            api_key: "key".into(),
        };
        let balanced = TranslationStrategy::DeepSeekBalanced {
            api_key: "key".into(),
        };
        assert_ne!(
            chunk_cache_path(directory, 0, &fast, "a"),
            chunk_cache_path(directory, 0, &fast, "b")
        );
        assert_ne!(
            chunk_cache_path(directory, 0, &fast, "a"),
            chunk_cache_path(directory, 0, &balanced, "a")
        );
    }

    #[test]
    fn chunks_respect_unicode_character_boundaries() {
        let chunks = chunk("中文段落一\n\n中文段落二", 5);
        assert!(chunks.iter().all(|value| value.chars().count() <= 5));
        assert!(!chunks.is_empty());
    }

    #[test]
    fn hard_split_never_cuts_a_protected_placeholder() {
        let value = "abcdefghDOCFLOWKEEP000000TOKENijklmnop";
        let chunks = hard_split(value, 12);
        assert_eq!(chunks.join(""), value);
        assert!(
            chunks
                .iter()
                .any(|chunk| chunk.contains("DOCFLOWKEEP000000TOKEN"))
        );
    }

    #[test]
    fn strategies_use_expected_thinking_and_chunk_limits() {
        let balanced = TranslationStrategy::DeepSeekBalanced {
            api_key: "key".into(),
        };
        let precise = TranslationStrategy::DeepSeekPrecise {
            api_key: "key".into(),
        };
        assert!(!balanced.thinking());
        assert!(precise.thinking());
        assert_eq!(balanced.chunk_limit(20_000), 12_000);
        assert_eq!(precise.chunk_limit(20_000), 8_000);
    }
}
