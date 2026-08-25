use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use anyhow::{Context, Result};
use futures::StreamExt;
use regex::Regex;

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
                "原文 {} 字符；保护 {} 个公式、代码、图片或链接；采用全站 FIFO 公平队列并按原始序号回收结果",
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
) -> Result<(usize, String)> {
    let number = index + 1;
    let tokens = expected_tokens(&source, placeholders);
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
    for validation_attempt in 1..=3 {
        let response = submit_with_retry(
            state,
            id,
            number,
            total,
            &source,
            strategy,
            validation_attempt > 1,
            completed.load(Ordering::Relaxed),
        )
        .await?;
        let candidate = strip_wrapper(&response.text);
        match restore(&candidate, &tokens, placeholders) {
            Ok(value) => {
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
                        message: &format!(
                            "分块 {number} 翻译完成；总体已完成 {done} / {total}"
                        ),
                        detail: Some(&format!(
                            "队列等待 {} ms；服务处理 {} ms；{}；占位符校验第 {validation_attempt} 次通过",
                            response.queue_wait.as_millis(),
                            response.service_time.as_millis(),
                            response.usage_detail.as_deref().unwrap_or("服务未返回 token 用量")
                        )),
                        current: Some(done as i64),
                        total: Some(total as i64),
                    },
                )
                .await?;
                return Ok((index, value));
            }
            Err(error) => {
                placeholder_error = Some(error.to_string());
                if validation_attempt < 3 {
                    events::append(
                        &state.pool,
                        id,
                        EventInput {
                            stage: "translation_placeholder_retry",
                            state: "warning",
                            level: "warning",
                            progress: progress_for(completed.load(Ordering::Relaxed), total),
                            message: &format!(
                                "分块 {number} 的公式/代码/链接占位符校验失败，正在严格重译"
                            ),
                            detail: placeholder_error.as_deref(),
                            current: Some(validation_attempt),
                            total: Some(3),
                        },
                    )
                    .await?;
                }
            }
        }
    }
    anyhow::bail!(
        "分块 {number} 连续 3 次破坏公式、代码或链接占位符：{}",
        placeholder_error.unwrap_or_else(|| "未知占位符错误".into())
    )
}

#[allow(clippy::too_many_arguments)]
async fn submit_with_retry(
    state: &Arc<AppState>,
    id: &str,
    number: usize,
    total: usize,
    source: &str,
    strategy: &TranslationStrategy,
    strict: bool,
    overall_completed: usize,
) -> Result<crate::translation_pool::PoolResponse> {
    let pools = state
        .translation_pools
        .as_ref()
        .context("全站翻译任务池不可用")?;
    let request = provider_request(id, source, strategy, strict);
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
    strict: bool,
) -> PoolRequest {
    match strategy {
        TranslationStrategy::GoogleFast { api_key } => PoolRequest::Google {
            api_key: api_key.clone(),
            content: source.to_string(),
        },
        TranslationStrategy::DeepSeekBalanced { api_key }
        | TranslationStrategy::DeepSeekPrecise { api_key } => {
            let placeholder_rule = if strict {
                "所有 DOCFLOWKEEP 加六位数字加 TOKEN 的占位符必须逐字符原样输出且各出现一次；输出前逐个核对，禁止插入空格、反引号或换行。"
            } else {
                "所有 DOCFLOWKEEP000000TOKEN 形式的占位符必须原样保留且各出现一次。"
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
    let mut tokens = map
        .keys()
        .filter(|token| source.contains(token.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    tokens.sort();
    tokens
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

fn restore(text: &str, tokens: &[String], map: &HashMap<String, String>) -> Result<String> {
    let mut value = text.replace(['\u{200b}', '\u{feff}'], "");
    for token in tokens {
        let digits = &token[11..17];
        let pattern = format!(
            r"(?i)`*D\s*O\s*C\s*F\s*L\s*O\s*W\s*K\s*E\s*E\s*P\s*{}\s*T\s*O\s*K\s*E\s*N`*",
            digits
                .chars()
                .map(|value| value.to_string())
                .collect::<Vec<_>>()
                .join(r"\s*")
        );
        value = Regex::new(&pattern)?
            .replace_all(&value, token.as_str())
            .into_owned();
        if value.matches(token).count() != 1 {
            anyhow::bail!("占位符 {token} 数量不是 1");
        }
    }
    for token in tokens {
        value = value.replace(token, map.get(token).context("占位映射丢失")?);
    }
    Ok(value)
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
