//! The in-app reading view: a standalone HTML page next to the article.
//! Images are relative (`images/…`) and the shared assets live in
//! `<data>/reader-assets/`, three levels above `archives/<key>/article/`.

use std::path::Path;

use anyhow::Result;

use crate::pipeline::markdown::Article;

const ASSETS: &str = "../../../reader-assets";

pub async fn write_reader_html(final_root: &Path, article: &Article) -> Result<()> {
    tokio::fs::write(final_root.join("reader.html"), page(article)).await?;
    Ok(())
}

fn page(article: &Article) -> String {
    let title = html_escape::encode_text(&article.title);
    format!(
        r#"<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>{title}</title>
<link rel="stylesheet" href="{ASSETS}/katex/katex.min.css">
<link rel="stylesheet" href="{ASSETS}/reader.css">
<script defer src="{ASSETS}/katex/katex.min.js"></script>
<script defer src="{ASSETS}/reader.js"></script>
</head>
<body>
<article class="article">
{content}
</article>
</body>
</html>
"#,
        content = article.html
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reader_page_escapes_the_title_and_links_shared_assets() {
        let html = page(&Article {
            title: "A <b>title</b>".into(),
            excerpt: String::new(),
            markdown: String::new(),
            html: "<p>正文</p>".into(),
        });
        assert!(html.contains("<title>A &lt;b&gt;title&lt;/b&gt;</title>"));
        assert!(html.contains("../../../reader-assets/katex/katex.min.js"));
        assert!(html.contains("<p>正文</p>"));
    }
}
