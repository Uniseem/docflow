use std::{collections::HashMap, sync::Arc};

use anyhow::Result;
use comrak::{Options, markdown_to_html};
use regex::Regex;

use crate::{
    events::{self, EventInput},
    state::AppState,
};

pub struct Article {
    pub title: String,
    pub excerpt: String,
    pub markdown: String,
    pub html: String,
}

/// `fallback_title` is used when the article has no level-1 heading.
pub async fn normalize_and_render(
    state: &Arc<AppState>,
    id: &str,
    input: &str,
    fallback_title: &str,
) -> Result<Article> {
    events::progress(
        &state.pool,
        id,
        "formatting_started",
        88,
        "开始规范化 Markdown",
        Some("公式保护 → 标题/列表规范 → 中英文间距 → CommonMark/GFM 解析 → HTML 白名单消毒"),
    )
    .await?;
    let formula = normalize_formula_delimiters(input)?;
    events::append(
        &state.pool,
        id,
        EventInput {
            stage: "formula_normalized",
            state: "completed",
            level: "success",
            progress: 89,
            message: "公式定界符已统一",
            detail: Some("行内公式使用 $...$，行间公式使用 $$...$$；代码区域不参与改写"),
            current: None,
            total: None,
        },
    )
    .await?;
    let markdown = normalize_structure_and_spacing(&formula)?;
    events::append(
        &state.pool,
        id,
        EventInput {
            stage: "markdown_normalized",
            state: "completed",
            level: "success",
            progress: 90,
            message: "Markdown 结构和中英文间距已规范",
            detail: Some(
                "使用 Rust 正则保护片段并整理标题、列表、空行；不会调用模型二次改写公式或代码",
            ),
            current: Some(markdown.chars().count() as i64),
            total: Some(markdown.chars().count() as i64),
        },
    )
    .await?;
    let rendered_math = math_to_html(&markdown)?;
    let mut options = Options::default();
    options.render.r#unsafe = true;
    options.extension.table = true;
    options.extension.strikethrough = true;
    options.extension.tasklist = true;
    options.extension.autolink = true;
    options.extension.footnotes = true;
    let raw_html = markdown_to_html(&rendered_math, &options);
    let mut cleaner = ammonia::Builder::default();
    cleaner
        .add_tags(["span", "div"])
        .add_generic_attributes(["class"])
        .url_relative(ammonia::UrlRelative::PassThrough);
    let html = cleaner.clean(&raw_html).to_string();
    events::append(
        &state.pool,
        id,
        EventInput {
            stage: "html_sanitized",
            state: "completed",
            level: "success",
            progress: 91,
            message: "CommonMark/GFM 渲染与 HTML 安全消毒完成",
            detail: Some("渲染器：comrak；白名单消毒：ammonia；危险标签、属性与协议不会进入阅读视图"),
            current: Some(html.len() as i64),
            total: Some(html.len() as i64),
        },
    )
    .await?;
    let title = extract_title(&markdown).unwrap_or_else(|| fallback_title.trim().to_string());
    let excerpt = extract_excerpt(&markdown);
    Ok(Article {
        title,
        excerpt,
        markdown,
        html,
    })
}

fn normalize_formula_delimiters(text: &str) -> Result<String> {
    let (replaced, map) = protect_code(text)?;
    let value = replaced
        .replace("\\[", "$$")
        .replace("\\]", "$$")
        .replace("\\(", "$")
        .replace("\\)", "$");
    Ok(restore(value, map))
}

fn normalize_structure_and_spacing(text: &str) -> Result<String> {
    let (replaced, map) = protect_all(text)?;
    let heading = Regex::new(r"(?m)^(#{1,6})\s*")?.replace_all(&replaced, "$1 ");
    let list = Regex::new(r"(?m)^(\s*[-+*])\s*")?.replace_all(&heading, "$1 ");
    let cjk_ascii = Regex::new(r"([\p{Han}])([A-Za-z0-9])")?.replace_all(&list, "$1 $2");
    let ascii_cjk = Regex::new(r"([A-Za-z0-9])([\p{Han}])")?.replace_all(&cjk_ascii, "$1 $2");
    let blanks = Regex::new(r"\n{3,}")?.replace_all(&ascii_cjk, "\n\n");
    Ok(restore(blanks.trim().to_string() + "\n", map))
}

fn protect_code(text: &str) -> Result<(String, HashMap<String, String>)> {
    protect_with(
        text,
        Regex::new(r"(?s:```[^\n]*\n.*?\n```)|(?s:~~~[^\n]*\n.*?\n~~~)|`+[^`\n]+`+")?,
    )
}
fn protect_all(text: &str) -> Result<(String, HashMap<String, String>)> {
    protect_with(
        text,
        Regex::new(
            r#"(?s:```[^\n]*\n.*?\n```)|(?s:~~~[^\n]*\n.*?\n~~~)|(?s:\$\$.*?\$\$)|\$[^$\n]+\$|`+[^`\n]+`+|!\[[^\]]*\]\([^\n)]*\)|\[[^\]]+\]\([^\n)]*\)"#,
        )?,
    )
}
fn protect_with(text: &str, re: Regex) -> Result<(String, HashMap<String, String>)> {
    let mut map = HashMap::new();
    let value = re
        .replace_all(text, |caps: &regex::Captures| {
            let token = format!("DOCFLOWFORMAT{:06}TOKEN", map.len());
            map.insert(token.clone(), caps[0].to_string());
            token
        })
        .into_owned();
    Ok((value, map))
}
fn restore(mut text: String, map: HashMap<String, String>) -> String {
    let mut entries = map.into_iter().collect::<Vec<_>>();
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    for (token, value) in entries {
        text = text.replace(&token, &value)
    }
    text
}

fn math_to_html(text: &str) -> Result<String> {
    let block = Regex::new(r"(?s)\$\$(.+?)\$\$")?;
    let mut value = block
        .replace_all(text, |caps: &regex::Captures| {
            format!("\n<div class=\"math-block\">{}</div>\n", escape(&caps[1]))
        })
        .into_owned();
    let inline = Regex::new(r"\$([^$\n]+)\$")?;
    value = inline
        .replace_all(&value, |caps: &regex::Captures| {
            format!("<span class=\"math-inline\">{}</span>", escape(&caps[1]))
        })
        .into_owned();
    Ok(value)
}
fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}
fn extract_title(text: &str) -> Option<String> {
    Regex::new(r"(?m)^#\s+(.+?)\s*$")
        .ok()?
        .captures(text)
        .map(|v| v[1].trim().to_string())
}
/// A short plain-text summary: the paragraph under an "Abstract"/"摘要"
/// heading when there is one, otherwise the first substantial paragraph.
fn extract_excerpt(text: &str) -> String {
    let blocks = text
        .split("\n\n")
        .map(str::trim)
        .filter(|block| !block.is_empty())
        .collect::<Vec<_>>();
    let is_heading = |block: &str| block.starts_with('#');
    let is_abstract = |label: &str| {
        let label = label.trim().to_lowercase();
        label.starts_with("abstract") || label.starts_with("摘要") || label.starts_with("summary")
    };
    let start = blocks
        .iter()
        .position(|block| is_heading(block) && is_abstract(block.trim_start_matches('#')))
        .map(|index| index + 1);
    let candidates = match start {
        Some(start) => blocks[start..]
            .iter()
            .copied()
            .take_while(|block| !is_heading(block))
            .collect::<Vec<_>>(),
        None => blocks
            .iter()
            .copied()
            .filter(|block| !is_heading(block))
            .collect(),
    };
    let label = Regex::new(r"(?i)^(abstract|summary|摘\s*要)\s*[:：.\-—]?\s*").expect("static label regex");
    let mut fallback = String::new();
    for block in candidates {
        let plain = plain_text(block);
        let plain = label.replace(&plain, "").trim().to_string();
        if plain.chars().count() >= 30 {
            return truncate(&plain, 240);
        }
        if fallback.is_empty() {
            fallback = plain;
        }
    }
    truncate(&fallback, 240)
}

fn plain_text(block: &str) -> String {
    let mut plain = block.to_string();
    for (pattern, replacement) in [
        (r"(?s)```.*?```", " "),
        (r"(?s)\$\$.*?\$\$", " "),
        (r"\$[^$\n]+\$", "…"),
        (r"!\[[^\]]*\]\([^)]*\)", " "),
        (r"\[([^\]]+)\]\([^)]*\)", "$1"),
        (r"(?s)<[^>]+>", " "),
        (r"[#>*_`|]", " "),
    ] {
        if let Ok(re) = Regex::new(pattern) {
            plain = re.replace_all(&plain, replacement).into_owned();
        }
    }
    Regex::new(r"\s+")
        .expect("static whitespace regex")
        .replace_all(&plain, " ")
        .trim()
        .to_string()
}

fn truncate(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        text.to_string()
    } else {
        let mut value = text.chars().take(limit).collect::<String>();
        value.push('…');
        value
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_math_without_touching_code() {
        let value =
            normalize_formula_delimiters("行内 \\(x+1\\)\n\n```tex\n\\[keep\\]\n```\n\n\\[y\\]")
                .unwrap();
        assert!(value.contains("$x+1$"));
        assert!(value.contains("$$y$$"));
        assert!(value.contains("\\[keep\\]"));
    }

    #[test]
    fn adds_cjk_ascii_spacing_and_standard_heading_space() {
        let value = normalize_structure_and_spacing("#标题\n\n使用Rust2026版本").unwrap();
        assert!(value.contains("# 标题"));
        assert!(value.contains("使用 Rust2026 版本"));
    }

    #[test]
    fn extracts_title_and_excerpt() {
        let text = "# 文档标题\n\n这是摘要正文。";
        assert_eq!(extract_title(text).as_deref(), Some("文档标题"));
        assert!(extract_excerpt(text).contains("摘要正文"));
    }

    #[test]
    fn excerpt_prefers_the_abstract_and_drops_markup_and_math() {
        let text = "# Title\n\n## 1 Intro\n\nShort.\n\n## Abstract\n\nWe study $T=\\sum_i c_i$ with <b>bold</b> and [links](https://x.y) in a long enough sentence.\n\n## 2 Method\n\nOther text that is long enough to be chosen otherwise.";
        assert_eq!(
            extract_excerpt(text),
            "We study … with bold and links in a long enough sentence."
        );
        let labelled = "摘要：本文提出一种文档解析与翻译流程，能够在保持公式和表格结构的同时并发翻译长文档。";
        assert!(extract_excerpt(labelled).starts_with("本文提出"));
        assert!(extract_excerpt(&"很长的段落。".repeat(100)).ends_with('…'));
    }
}
