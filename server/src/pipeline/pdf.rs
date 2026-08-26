use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::Duration,
};

use anyhow::{Context, Result};
use tokio::{
    io::{AsyncReadExt, AsyncSeekExt},
    process::Command,
};

use crate::{
    config::Config,
    db::AppState,
    events::{self, EventInput},
};

use super::markdown::Article;

pub struct PdfArtifact {
    pub path: PathBuf,
    pub print_html_path: PathBuf,
    pub bytes: u64,
}

pub async fn render_journal_pdf(
    state: &Arc<AppState>,
    id: &str,
    article: &Article,
    final_root: &Path,
) -> Result<PdfArtifact> {
    events::progress(
        &state.pool,
        id,
        "pdf_layout_started",
        92,
        "开始生成期刊论文风格 PDF",
        Some("A4 版心、衬线字体、摘要区、规范标题层级、表格与图片分页控制、KaTeX 公式排版"),
    )
    .await?;

    let artifact = render_pdf_artifact(&state.config, id, article, final_root).await?;
    events::append(
        &state.pool,
        id,
        EventInput {
            stage: "pdf_rendered",
            state: "completed",
            level: "success",
            progress: 93,
            message: "期刊论文风格 PDF 已生成并通过文件校验",
            detail: Some(&format!(
                "输出 {} 字节；公式由本地 KaTeX 排版，PDF 由本地 Chromium 打印，不访问外部 CDN",
                artifact.bytes
            )),
            current: Some(artifact.bytes as i64),
            total: Some(artifact.bytes as i64),
        },
    )
    .await?;
    Ok(artifact)
}

pub async fn render_archived_journal_pdf(
    config: &Config,
    id: &str,
    article: &Article,
    archive_root: &Path,
) -> Result<PdfArtifact> {
    render_pdf_artifact(config, id, article, archive_root).await
}

async fn render_pdf_artifact(
    config: &Config,
    id: &str,
    article: &Article,
    document_root: &Path,
) -> Result<PdfArtifact> {
    let article_root = document_root.join("article");
    tokio::fs::create_dir_all(&article_root).await?;
    let print_html_path = article_root.join("print.html");
    let pdf_path = article_root.join("article.pdf");
    let partial_path = article_root.join("article.pdf.partial");
    let print_html = build_print_html(
        id,
        article,
        &config.pdf_katex_root,
        chrono::Local::now().format("%Y-%m-%d").to_string().as_str(),
    )?;
    tokio::fs::write(&print_html_path, print_html.as_bytes())
        .await
        .context("无法写入 PDF 打印版 HTML")?;

    let mut command = Command::new(&config.pdf_node_binary);
    command
        .arg(&config.pdf_renderer_script)
        .arg(&print_html_path)
        .arg(&partial_path)
        .env(
            "PDF_RENDER_TIMEOUT_MS",
            (config.pdf_render_timeout_seconds * 1_000).to_string(),
        )
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let output = tokio::time::timeout(
        Duration::from_secs(config.pdf_render_timeout_seconds + 15),
        command.output(),
    )
    .await
    .context("PDF 渲染超时")?
    .context("无法启动 Node/Chromium PDF 渲染器")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        anyhow::bail!(
            "PDF 渲染器退出（{}）：{}{}",
            output.status,
            stderr.chars().take(2_000).collect::<String>(),
            stdout.chars().take(1_000).collect::<String>()
        );
    }
    verify_pdf(&partial_path).await?;
    tokio::fs::rename(&partial_path, &pdf_path)
        .await
        .context("无法原子发布 PDF")?;
    let bytes = tokio::fs::metadata(&pdf_path).await?.len();
    Ok(PdfArtifact {
        path: pdf_path,
        print_html_path,
        bytes,
    })
}

async fn verify_pdf(path: &Path) -> Result<()> {
    let metadata = tokio::fs::metadata(path)
        .await
        .context("PDF 渲染器没有生成输出文件")?;
    if metadata.len() < 1_024 {
        anyhow::bail!("PDF 输出异常短（{} 字节）", metadata.len());
    }
    let mut file = tokio::fs::File::open(path).await?;
    let mut header = [0_u8; 5];
    file.read_exact(&mut header).await?;
    let tail_size = metadata.len().min(4_096) as usize;
    file.seek(std::io::SeekFrom::End(-(tail_size as i64)))
        .await?;
    let mut tail = vec![0_u8; tail_size];
    file.read_exact(&mut tail).await?;
    if &header != b"%PDF-" || !tail.windows(5).any(|window| window == b"%%EOF") {
        anyhow::bail!("PDF 文件头或结束标记无效");
    }
    Ok(())
}

fn build_print_html(
    id: &str,
    article: &Article,
    katex_root: &Path,
    generated_date: &str,
) -> Result<String> {
    let katex_css = file_url(&katex_root.join("katex.min.css"))?;
    let katex_js = file_url(&katex_root.join("katex.min.js"))?;
    let content = article
        .html
        .replace(&format!("/api/v1/jobs/{id}/assets/"), "../images/")
        .replace(&format!("/api/documents/{id}/assets/"), "../images/");
    let title = html_escape::encode_text(&article.title);
    let excerpt = html_escape::encode_text(&article.excerpt);
    let abstract_block = if article.excerpt.trim().is_empty() {
        String::new()
    } else {
        format!(r#"<section class="paper-abstract"><h2>摘要</h2><p>{excerpt}</p></section>"#)
    };
    Ok(format!(
        r#"<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>{title}</title>
  <link rel="stylesheet" href="{katex_css}">
  <style>
    @page {{ size: A4; }}
    :root {{ color-scheme: light; }}
    * {{ box-sizing: border-box; }}
    html {{ font-size: 10.5pt; background: #fff; }}
    body {{ margin: 0; color: #151515; background: #fff; font-family: "Linux Libertine O", "Noto Serif CJK SC", "Noto Serif CJK TC", "Noto Serif", serif; font-kerning: normal; text-rendering: optimizeLegibility; }}
    .paper {{ width: 100%; }}
    .paper-header {{ margin: 0 0 9mm; padding: 0 0 6mm; text-align: center; border-bottom: .45pt solid #9a9a9a; }}
    .paper-kicker {{ margin: 0 0 3mm; color: #555; font-family: "Noto Sans CJK SC", sans-serif; font-size: 7.5pt; font-weight: 600; letter-spacing: .16em; text-transform: uppercase; }}
    .paper-title {{ max-width: 168mm; margin: 0 auto 3.5mm; color: #111; font-size: 20pt; font-weight: 700; line-height: 1.28; letter-spacing: .015em; }}
    .paper-meta {{ color: #666; font-family: "Noto Sans CJK SC", sans-serif; font-size: 8pt; letter-spacing: .06em; }}
    .paper-abstract {{ margin: 0 0 8mm; padding: 4.5mm 5.5mm; border-top: .6pt solid #333; border-bottom: .6pt solid #333; background: #fafafa; break-inside: avoid; }}
    .paper-abstract h2 {{ display: inline; margin: 0 .75em 0 0; font-size: 9.5pt; font-weight: 700; }}
    .paper-abstract p {{ display: inline; margin: 0; font-size: 9.25pt; line-height: 1.65; text-align: justify; }}
    .paper-content {{ font-size: 10.5pt; line-height: 1.78; text-align: justify; overflow-wrap: anywhere; }}
    .paper-content > h1:first-child {{ display: none; }}
    .paper-content p {{ margin: 0 0 .72em; text-indent: 2em; orphans: 3; widows: 3; }}
    .paper-content h1, .paper-content h2, .paper-content h3, .paper-content h4, .paper-content h5, .paper-content h6 {{ color: #111; font-weight: 700; line-height: 1.35; text-align: left; break-after: avoid-page; page-break-after: avoid; }}
    .paper-content h1 {{ margin: 1.25em 0 .6em; padding-bottom: .22em; border-bottom: .7pt solid #555; font-size: 16pt; }}
    .paper-content h2 {{ margin: 1.15em 0 .55em; font-size: 13.5pt; }}
    .paper-content h3 {{ margin: 1em 0 .45em; font-size: 11.5pt; }}
    .paper-content h4, .paper-content h5, .paper-content h6 {{ margin: .9em 0 .4em; font-size: 10.5pt; }}
    .paper-content h1 + p, .paper-content h2 + p, .paper-content h3 + p, .paper-content h4 + p, .paper-content li p, .paper-content blockquote p, .paper-content td p, .paper-content th p {{ text-indent: 0; }}
    .paper-content ul, .paper-content ol {{ margin: .45em 0 .85em; padding-left: 2.2em; text-align: left; }}
    .paper-content li {{ margin: .2em 0; padding-left: .15em; }}
    .paper-content blockquote {{ margin: 1em 1.5em; padding: .5em 1em; color: #444; border-left: 2pt solid #777; background: #f7f7f7; break-inside: avoid-page; }}
    .paper-content table {{ width: 100%; margin: 1.1em auto 1.35em; border-collapse: collapse; table-layout: fixed; font-size: 8.75pt; break-inside: avoid-page; }}
    .paper-content thead {{ display: table-header-group; }}
    .paper-content tr {{ break-inside: avoid; }}
    .paper-content th, .paper-content td {{ padding: .42em .55em; border-top: .5pt solid #777; border-bottom: .5pt solid #aaa; vertical-align: top; word-break: break-word; }}
    .paper-content th {{ background: #f1f1f1; font-weight: 700; text-align: left; }}
    .paper-content img {{ display: block; max-width: 92%; max-height: 205mm; width: auto; height: auto; margin: 1.2em auto; object-fit: contain; break-inside: avoid-page; image-rendering: auto; }}
    .paper-content figure {{ margin: 1.2em auto; text-align: center; break-inside: avoid-page; }}
    .paper-content figcaption {{ margin-top: .45em; color: #555; font-size: 8.5pt; text-align: center; }}
    .paper-content a {{ color: #111; text-decoration: underline; text-decoration-thickness: .45pt; text-underline-offset: 1.5pt; }}
    .paper-content code {{ padding: .05em .24em; border-radius: 2px; background: #f2f2f2; font-family: "Noto Sans Mono", "DejaVu Sans Mono", monospace; font-size: .86em; }}
    .paper-content pre {{ margin: 1em 0; padding: .8em 1em; border: .5pt solid #bbb; background: #f7f7f7; font-size: 8.2pt; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; break-inside: avoid-page; }}
    .paper-content pre code {{ padding: 0; background: transparent; }}
    .math-inline {{ white-space: nowrap; }}
    .math-block {{ margin: 1.05em 0; overflow: visible; text-align: center; break-inside: avoid-page; }}
    .katex-display {{ margin: 0; overflow: visible; }}
    .footnotes {{ margin-top: 2em; padding-top: .7em; border-top: .5pt solid #999; font-size: 8.5pt; }}
    hr {{ margin: 1.4em 0; border: 0; border-top: .5pt solid #888; }}
  </style>
  <script src="{katex_js}"></script>
</head>
<body>
  <main class="paper">
    <header class="paper-header">
      <p class="paper-kicker">DOCFLOW ACADEMIC EDITION</p>
      <h1 class="paper-title">{title}</h1>
      <div class="paper-meta">生成日期 {generated_date} · A4 学术排版</div>
    </header>
    {abstract_block}
    <article class="paper-content">{content}</article>
  </main>
  <script>
    (() => {{
      const finish = async () => {{
        const deadline = (promise) => Promise.race([promise, new Promise((resolve) => setTimeout(resolve, 15000))]);
        try {{
          document.querySelectorAll('.math-inline,.math-block').forEach((element) => {{
            try {{
              window.katex.render(element.textContent || '', element, {{
                displayMode: element.classList.contains('math-block'),
                throwOnError: false,
                strict: 'warn'
              }});
            }} catch (error) {{ console.warn('KaTeX render failed', error); }}
          }});
          if (document.fonts && document.fonts.ready) await deadline(document.fonts.ready);
          await deadline(Promise.all(Array.from(document.images).map((image) => image.complete
            ? Promise.resolve()
            : new Promise((resolve) => {{ image.addEventListener('load', resolve, {{ once: true }}); image.addEventListener('error', resolve, {{ once: true }}); }}))));
        }} finally {{
          window.__DOCFLOW_PDF_READY__ = true;
        }}
      }};
      if (document.readyState === 'complete') finish();
      else window.addEventListener('load', finish, {{ once: true }});
    }})();
  </script>
</body>
</html>"#
    ))
}

fn file_url(path: &Path) -> Result<String> {
    url::Url::from_file_path(path)
        .map(|value| value.to_string())
        .map_err(|_| anyhow::anyhow!("无法把本地 PDF 资源路径转换为 file URL：{}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn article() -> Article {
        Article {
            title: "测试 <论文>".into(),
            excerpt: "包含公式与图片的摘要。".into(),
            markdown: String::new(),
            html: r#"<h1>测试论文</h1><p>正文 <span class="math-inline">x^2</span></p><img src="/api/v1/jobs/test-id/assets/figure.webp">"#.into(),
        }
    }

    #[test]
    fn creates_portable_print_markup_and_rewrites_local_images() {
        let katex_root = std::env::temp_dir().join("docflow-katex-test");
        let html = build_print_html("test-id", &article(), &katex_root, "2026-08-26").unwrap();
        assert!(html.contains("测试 &lt;论文&gt;"));
        assert!(html.contains("src=\"../images/figure.webp\""));
        assert!(!html.contains("/api/v1/jobs/test-id/assets/"));
        assert!(html.contains("Noto Serif CJK SC"));
        assert!(html.contains("__DOCFLOW_PDF_READY__"));
    }

    #[test]
    #[ignore = "manual visual-regression fixture"]
    fn writes_academic_pdf_preview_fixture() {
        let output_root = PathBuf::from(
            std::env::var("DOCFLOW_PDF_PREVIEW_DIR").expect("DOCFLOW_PDF_PREVIEW_DIR is required"),
        );
        let katex_root = PathBuf::from(
            std::env::var("DOCFLOW_PDF_KATEX_ROOT").expect("DOCFLOW_PDF_KATEX_ROOT is required"),
        );
        std::fs::create_dir_all(output_root.join("article")).unwrap();
        std::fs::create_dir_all(output_root.join("images")).unwrap();
        let figure = image::RgbImage::from_fn(1400, 760, |x, y| {
            let nx = x as f32 / 1400.0;
            let ny = y as f32 / 760.0;
            image::Rgb([
                (238.0 - 70.0 * ny) as u8,
                (244.0 - 45.0 * nx) as u8,
                (248.0 - 90.0 * nx * ny) as u8,
            ])
        });
        figure
            .save_with_format(
                output_root.join("images/figure.webp"),
                image::ImageFormat::WebP,
            )
            .unwrap();
        let preview = Article {
            title: "复杂文档解析与并发翻译系统：一种可迁移的自托管实现".into(),
            excerpt: "本文给出一个从文档解析、图片本地化、分段并发翻译到永久归档的完整工作流，并讨论公式保护、队列公平性以及可复现学术排版。".into(),
            markdown: String::new(),
            html: r#"
<h1>复杂文档解析与并发翻译系统</h1>
<h2>1 引言</h2>
<p>面向长篇学术文档的自动处理系统，需要同时解决结构保真、资源本地化、翻译并发与输出可迁移性问题。本文采用确定性格式清洗，并将所有最终材料永久保存于当前部署目录。</p>
<p>系统的总体吞吐量可以写为 <span class="math-inline">T=\sum_{i=1}^{n} c_i / p_i</span>，其中 <span class="math-inline">c_i</span> 表示分块字符数，<span class="math-inline">p_i</span> 表示相应任务池的并行度。</p>
<div class="math-block">\mathcal{L}=\frac{1}{N}\sum_{i=1}^{N}\left\|y_i-\hat{y}_i\right\|_2^2+\lambda\Omega(\theta)</div>
<h2>2 系统设计</h2>
<h3>2.1 处理流水线</h3>
<ol><li>验证并永久保存源文件。</li><li>提交解析任务并轮询页面进度。</li><li>将全部图片转换为 WebP。</li><li>按原始顺序合并并发翻译分块。</li></ol>
<blockquote><p>任何公式、代码、图片或链接占位符在翻译后不一致时，该分块必须重试，不能发布损坏结果。</p></blockquote>
<img src="/api/v1/jobs/preview/assets/figure.webp" alt="系统吞吐量示意图">
<p style="text-align:center;text-indent:0;font-size:9pt;color:#555">图 1　并发任务池吞吐量示意图</p>
<h3>2.2 性能比较</h3>
<table><thead><tr><th>方案</th><th>并发模型</th><th>本地归档</th><th>适用场景</th></tr></thead><tbody><tr><td>串行处理</td><td>单队列单任务</td><td>支持</td><td>小型文档</td></tr><tr><td>文档内并发</td><td>单文档多分块</td><td>支持</td><td>长篇论文</td></tr><tr><td>全站共享池</td><td>多文档公平排队</td><td>支持</td><td>多人同时提交</td></tr></tbody></table>
<h2>3 安全性与可迁移性</h2>
<p>磁盘物理路径只使用随机存储键和固定 ASCII 文件名。展示标题、下载名称与物理路径相互独立，因此中文名称不会进入底层文件系统路径。</p>
<pre><code>archives/{storage_key}/
├── source/source.pdf
├── markdown/normalized.md
├── article/article.pdf
└── images/*.webp</code></pre>
<h2>4 结论</h2>
<p>该实现能够在不依赖外部 CDN 的条件下生成包含公式、表格、图片、页眉和页码的 A4 学术版 PDF，并随完整数据目录一键迁移。</p>
"#.into(),
        };
        let html = build_print_html("preview", &preview, &katex_root, "2026-08-26").unwrap();
        std::fs::write(output_root.join("article/print.html"), html).unwrap();
    }
}
