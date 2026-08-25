use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};

use anyhow::{Context, Result};
use regex::Regex;
use serde_json::{Value, json};

use crate::{
    db::AppState,
    events::{self, EventInput},
};

pub enum TranslationProvider {
    Google,
    DeepSeek { api_key: String, model: String },
}

impl TranslationProvider {
    fn label(&self) -> &str {
        match self {
            Self::Google => "Google 免费翻译",
            Self::DeepSeek { model, .. } => model,
        }
    }

    fn chunk_limit(&self, configured: usize) -> usize {
        match self {
            Self::Google => configured.min(3_500),
            Self::DeepSeek { .. } => configured,
        }
        .max(500)
    }
}

pub async fn translate(
    state: &Arc<AppState>,
    id: &str,
    markdown: &str,
    provider: &TranslationProvider,
) -> Result<String> {
    let chunk_limit = provider.chunk_limit(state.config.translation_chunk_chars);
    events::progress(
        &state.pool,
        id,
        "translation_preparing",
        71,
        "正在保护公式、代码、图片和链接并规划翻译分块",
        Some(&format!(
            "全站翻译服务：{}；目标分块 {chunk_limit} 字符；占位内容不发送给翻译服务改写",
            provider.label()
        )),
    )
    .await?;
    let (protected, map) = protect(markdown)?;
    let chunks = chunk(&protected, chunk_limit);
    events::append(
        &state.pool,
        id,
        EventInput {
            stage: "translation_prepared",
            state: "completed",
            level: "success",
            progress: 72,
            message: &format!("翻译规划完成：共 {} 个分块", chunks.len()),
            detail: Some(&format!(
                "原文 {} 字符；保护 {} 个公式、代码、图片或链接片段",
                markdown.chars().count(),
                map.len()
            )),
            current: Some(0),
            total: Some(chunks.len() as i64),
        },
    )
    .await?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(240))
        .no_proxy()
        .build()?;
    let mut output = Vec::new();
    let mut fallback_count = 0;
    for (index, source) in chunks.iter().enumerate() {
        let current = index + 1;
        let count = chunks.len();
        let started = Instant::now();
        let placeholders = expected_tokens(source, &map);
        events::append(
            &state.pool,
            id,
            EventInput {
                stage: "translation_chunk_started",
                state: "running",
                level: "info",
                progress: 72 + ((current - 1) * 14 / count.max(1)) as i32,
                message: &format!("开始翻译第 {current} / {count} 块"),
                detail: Some(&format!(
                    "本块 {} 字符；{} 个受保护占位符",
                    source.chars().count(),
                    placeholders.len()
                )),
                current: Some(current as i64),
                total: Some(count as i64),
            },
        )
        .await?;
        let mut completed = None;
        let mut last_error = String::new();
        for placeholder_attempt in 1..=3 {
            events::append(
                &state.pool,
                id,
                EventInput {
                    stage: "translation_provider_call",
                    state: "running",
                    level: "info",
                    progress: 72 + ((current - 1) * 14 / count.max(1)) as i32,
                    message: &format!(
                        "第 {current} / {count} 块：{} 调用 {placeholder_attempt} / 3",
                        provider.label()
                    ),
                    detail: Some(if placeholder_attempt == 1 {
                        "普通翻译规则"
                    } else {
                        "严格占位符保持与自检规则"
                    }),
                    current: Some(current as i64),
                    total: Some(count as i64),
                },
            )
            .await?;
            match call_provider(
                &client,
                provider,
                source,
                placeholder_attempt > 1,
                CallProgress {
                    state,
                    id,
                    current,
                    total: count,
                },
            )
            .await
            .and_then(|text| restore(&text, &placeholders, &map))
            {
                Ok(text) => {
                    completed = Some(text);
                    break;
                }
                Err(error) => {
                    last_error = format!("{error:#}");
                    events::append(
                        &state.pool,
                        id,
                        EventInput {
                            stage: "translation_placeholder_retry",
                            state: "warning",
                            level: "warning",
                            progress: 72 + ((current - 1) * 14 / count.max(1)) as i32,
                            message: &format!("第 {current} 块占位符校验未通过，准备安全重试"),
                            detail: Some(&format!(
                                "第 {placeholder_attempt} 次结果：{}",
                                last_error.chars().take(600).collect::<String>()
                            )),
                            current: Some(placeholder_attempt),
                            total: Some(3),
                        },
                    )
                    .await?;
                }
            }
        }
        let final_text = if let Some(value) = completed {
            value
        } else {
            fallback_count += 1;
            events::append(&state.pool,id,EventInput{stage:"translation_chunk_preserved",state:"warning",level:"warning",progress:72+(current*14/count.max(1)) as i32,message:&format!("第 {current} 块为保护公式与链接，保留原文继续发布"),detail:Some(&format!("三次翻译结果均未通过无损校验；不会再因占位符破坏导致整个任务失败。最后错误：{}",last_error.chars().take(700).collect::<String>())),current:Some(current as i64),total:Some(count as i64)}).await?;
            restore(source, &placeholders, &map).context("恢复原文保护片段失败")?
        };
        output.push(final_text);
        events::append(
            &state.pool,
            id,
            EventInput {
                stage: "translation_chunk_completed",
                state: "completed",
                level: "success",
                progress: 72 + (current * 14 / count.max(1)) as i32,
                message: &format!("第 {current} / {count} 块处理完成"),
                detail: Some(&format!(
                    "耗时 {:.1} 秒；{} 个占位片段逐一恢复",
                    started.elapsed().as_secs_f32(),
                    placeholders.len()
                )),
                current: Some(current as i64),
                total: Some(count as i64),
            },
        )
        .await?;
    }
    events::append(
        &state.pool,
        id,
        EventInput {
            stage: "translation_completed",
            state: "completed",
            level: if fallback_count == 0 {
                "success"
            } else {
                "warning"
            },
            progress: 87,
            message: "全部翻译分块已按原顺序合并",
            detail: Some(&format!(
                "共 {} 块；{} 块因无损校验连续失败而保留原文；任务继续进入规范化",
                chunks.len(),
                fallback_count
            )),
            current: Some(chunks.len() as i64),
            total: Some(chunks.len() as i64),
        },
    )
    .await?;
    Ok(output.join("\n\n"))
}

fn protect(markdown: &str) -> Result<(String, HashMap<String, String>)> {
    let re = Regex::new(
        r#"(?s:```[^\n]*\n.*?\n```)|(?s:~~~[^\n]*\n.*?\n~~~)|(?s:\$\$.*?\$\$)|(?s:\\\[.*?\\\])|\\\([^\n]*?\\\)|`+[^`\n]+`+|\$[^$\n]+\$|!\[[^\]]*\]\([^\n)]*\)|\[[^\]]+\]\([^\n)]*\)|<img\b[^>]*>"#,
    )?;
    let mut map = HashMap::new();
    let text = re
        .replace_all(markdown, |caps: &regex::Captures| {
            let token = format!("DOCFLOWKEEP{:06}TOKEN", map.len());
            map.insert(token.clone(), caps.get(0).unwrap().as_str().to_string());
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
        let pieces = hard_split(block, limit);
        for piece in pieces {
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
    };
    let chars = text.chars().collect::<Vec<_>>();
    chars.chunks(limit).map(|v| v.iter().collect()).collect()
}

#[derive(Clone, Copy)]
struct CallProgress<'a> {
    state: &'a Arc<AppState>,
    id: &'a str,
    current: usize,
    total: usize,
}

async fn call_provider(
    client: &reqwest::Client,
    provider: &TranslationProvider,
    content: &str,
    strict: bool,
    progress: CallProgress<'_>,
) -> Result<String> {
    match provider {
        TranslationProvider::Google => call_google(client, content, progress).await,
        TranslationProvider::DeepSeek { api_key, model } => {
            call_deepseek(client, api_key, model, content, strict, progress).await
        }
    }
}

async fn call_deepseek(
    client: &reqwest::Client,
    key: &str,
    model: &str,
    content: &str,
    strict: bool,
    progress: CallProgress<'_>,
) -> Result<String> {
    let CallProgress {
        state,
        id,
        current,
        total,
    } = progress;
    let rule = if strict {
        "占位符保持校验重试：所有 DOCFLOWKEEP 加六位数字加 TOKEN 的字符串必须逐字符原样输出，禁止空格、换行、反引号或大小写变化；输出前核对数量。"
    } else {
        "所有 DOCFLOWKEEP000000TOKEN 形式的占位符必须原样保留且各出现一次。"
    };
    let body = json!({"model":model,"messages":[{"role":"system","content":format!("你是严谨的学术文献译者。把 Markdown 准确翻译成简体中文，保持标题、列表、表格和引用结构。{rule} 不解释，不加代码围栏，只输出 Markdown。")},{"role":"user","content":content}],"temperature":if strict{0.0}else{0.1},"max_tokens":16384,"stream":false});
    let mut last = String::new();
    for attempt in 1u32..=4 {
        let response = client
            .post("https://api.deepseek.com/chat/completions")
            .bearer_auth(key)
            .json(&body)
            .send()
            .await?;
        if [429, 500, 502, 503, 504].contains(&response.status().as_u16()) {
            last = response.text().await.unwrap_or_default();
            let delay = 2u64.pow((attempt - 1).min(3));
            events::append(
                &state.pool,
                id,
                EventInput {
                    stage: "translation_api_retry",
                    state: "warning",
                    level: "warning",
                    progress: 72 + ((current - 1) * 14 / total.max(1)) as i32,
                    message: &format!("第 {current} 块 DeepSeek 暂时不可用，{delay} 秒后重试"),
                    detail: Some(&format!(
                        "API 重试 {attempt} / 4；响应 {}",
                        last.chars().take(300).collect::<String>()
                    )),
                    current: Some(attempt as i64),
                    total: Some(4),
                },
            )
            .await?;
            tokio::time::sleep(Duration::from_secs(delay)).await;
            continue;
        }
        let status = response.status();
        let value: Value = response.json().await?;
        if !status.is_success() {
            anyhow::bail!(
                "DeepSeek HTTP {status}：{}",
                value.to_string().chars().take(400).collect::<String>()
            )
        }
        let text = value["choices"][0]["message"]["content"]
            .as_str()
            .context("DeepSeek 未返回文本")?
            .trim();
        if text.is_empty() {
            anyhow::bail!("DeepSeek 返回空文本")
        };
        return Ok(strip_wrapper(text));
    }
    anyhow::bail!(
        "DeepSeek 多次重试仍不可用：{}",
        last.chars().take(300).collect::<String>()
    )
}

async fn call_google(
    client: &reqwest::Client,
    content: &str,
    progress: CallProgress<'_>,
) -> Result<String> {
    let mut last = String::new();
    for attempt in 1u32..=4 {
        let response = client
            .get("https://clients5.google.com/translate_a/t")
            .query(&[
                ("client", "dict-chrome-ex"),
                ("sl", "auto"),
                ("tl", "zh-CN"),
                ("q", content),
            ])
            .header(
                reqwest::header::USER_AGENT,
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
            )
            .header(reqwest::header::REFERER, "https://translate.google.com/")
            .send()
            .await;
        let response = match response {
            Ok(value) => value,
            Err(error) => {
                last = error.to_string();
                let delay = 2u64.pow((attempt - 1).min(3));
                append_provider_retry(progress, attempt, delay, "Google 免费翻译连接失败", &last)
                    .await?;
                tokio::time::sleep(Duration::from_secs(delay)).await;
                continue;
            }
        };
        let status = response.status();
        let body = response.text().await?;
        if [429, 500, 502, 503, 504].contains(&status.as_u16()) {
            last = body;
            let delay = 2u64.pow((attempt - 1).min(3));
            append_provider_retry(
                progress,
                attempt,
                delay,
                &format!("Google 免费翻译返回 HTTP {status}"),
                &last,
            )
            .await?;
            tokio::time::sleep(Duration::from_secs(delay)).await;
            continue;
        }
        if !status.is_success() {
            anyhow::bail!(
                "Google 免费翻译 HTTP {status}：{}",
                body.chars().take(400).collect::<String>()
            );
        }
        let value: Value =
            serde_json::from_str(&body).with_context(|| "Google 免费翻译返回了无法解析的结果")?;
        return parse_google_response(&value);
    }
    anyhow::bail!(
        "Google 免费翻译多次重试仍不可用：{}",
        last.chars().take(300).collect::<String>()
    )
}

async fn append_provider_retry(
    progress: CallProgress<'_>,
    attempt: u32,
    delay: u64,
    reason: &str,
    detail: &str,
) -> Result<()> {
    let CallProgress {
        state,
        id,
        current,
        total,
    } = progress;
    events::append(
        &state.pool,
        id,
        EventInput {
            stage: "translation_api_retry",
            state: "warning",
            level: "warning",
            progress: 72 + ((current - 1) * 14 / total.max(1)) as i32,
            message: &format!("第 {current} 块：{reason}，{delay} 秒后重试"),
            detail: Some(&format!(
                "服务重试 {attempt} / 4；响应 {}",
                detail.chars().take(300).collect::<String>()
            )),
            current: Some(attempt as i64),
            total: Some(4),
        },
    )
    .await?;
    Ok(())
}

fn parse_google_response(value: &Value) -> Result<String> {
    let segments = value.as_array().context("Google 免费翻译响应不是数组")?;
    let translated = segments
        .iter()
        .filter_map(|segment| segment.as_array()?.first()?.as_str())
        .collect::<Vec<_>>()
        .join("");
    if translated.trim().is_empty() {
        anyhow::bail!("Google 免费翻译返回空文本");
    }
    Ok(translated)
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
                .map(|v| v.to_string())
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
    fn parses_google_chrome_dictionary_response() {
        let value = json!([["你好世界", "en"]]);
        assert_eq!(parse_google_response(&value).unwrap(), "你好世界");
    }
}
