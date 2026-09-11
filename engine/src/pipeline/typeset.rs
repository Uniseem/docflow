//! Journal-style PDF for the MinerU route, typeset in-process with Typst.
//!
//! No browser, Node.js or network access is involved. Fonts come from the
//! embedded Typst fonts, the bundled BabelDOC font assets and the system;
//! LaTeX math is converted by the vendored MiTeX package. All article text is
//! emitted as escaped Typst string literals, so document content can never be
//! interpreted as Typst code.

use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, LazyLock, OnceLock},
    time::Instant,
};

use anyhow::{Context, Result};
use chrono::Datelike;
use comrak::{
    Arena, Options,
    nodes::{AstNode, ListType, NodeValue, TableAlignment},
};
use regex::Regex;
use scraper::{ElementRef, Html, Node as HtmlNode};
use typst::{
    Library, LibraryExt, World, WorldExt,
    diag::{FileError, FileResult, SourceDiagnostic},
    foundations::{Bytes, Datetime},
    syntax::{FileId, RootedPath, Source, VirtualPath, VirtualRoot},
    text::{Font, FontBook},
    utils::LazyHash,
};
use typst_kit::fonts::FontStore;
use typst_layout::PagedDocument;

use super::{markdown::Article, verify_pdf};
use crate::{
    config::Config,
    events::{self, EventInput},
    state::AppState,
};

const TEMPLATE: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/typeset/journal.typ"));
const MITEX_VERSION: (u32, u32, u32) = (0, 2, 7);
const MITEX_FILES: &[(&str, &[u8])] = &[
    (
        "typst.toml",
        include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/typeset/mitex/typst.toml")),
    ),
    (
        "lib.typ",
        include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/typeset/mitex/lib.typ")),
    ),
    (
        "mitex.typ",
        include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/typeset/mitex/mitex.typ")),
    ),
    (
        "mitex.wasm",
        include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/typeset/mitex/mitex.wasm")),
    ),
    (
        "specs/mod.typ",
        include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/typeset/mitex/specs/mod.typ")),
    ),
    (
        "specs/prelude.typ",
        include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/typeset/mitex/specs/prelude.typ"
        )),
    ),
    (
        "specs/latex/standard.typ",
        include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/typeset/mitex/specs/latex/standard.typ"
        )),
    ),
];
/// Text width of the A4 layout (210 mm − 2 × 20 mm) in points.
const TEXT_WIDTH_PT: f64 = 481.9;
const MAX_IMAGE_HEIGHT_PT: f64 = 580.0;
const MAX_FALLBACK_ROUNDS: usize = 64;
const SOFT_BREAK: char = '\u{E000}';

pub struct PdfArtifact {
    pub path: PathBuf,
    /// The generated Typst source, archived for transparency and reuse.
    pub source_path: PathBuf,
    pub bytes: u64,
    pub pages: usize,
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
        Some("Typst 排版：A4 版心、衬线中英文字体、摘要区、规范标题层级、表格与图片分页控制、LaTeX 公式"),
    )
    .await?;
    let started = Instant::now();
    let config = state.config.clone();
    let article = ArticleInput::from(article);
    let root = final_root.to_path_buf();
    let rendered = tokio::task::spawn_blocking(move || render(&config, &article, &root))
        .await
        .context("PDF 排版线程异常退出")??;
    verify_pdf(&rendered.artifact.path).await?;
    if !rendered.fallbacks.is_empty() {
        events::append(
            &state.pool,
            id,
            EventInput {
                stage: "pdf_formula_fallback",
                state: "warning",
                level: "warning",
                progress: 92,
                message: &format!(
                    "{} 个公式无法排版，已在 PDF 中保留 LaTeX 原文",
                    rendered.fallbacks.len()
                ),
                detail: Some(&rendered.fallbacks.join("\n")),
                current: Some(rendered.fallbacks.len() as i64),
                total: None,
            },
        )
        .await?;
    }
    let artifact = rendered.artifact;
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
                "共 {} 页、{} 字节，用时 {} ms；由内置 Typst 排版，公式由 MiTeX 转换，全程离线",
                artifact.pages,
                artifact.bytes,
                started.elapsed().as_millis()
            )),
            current: Some(artifact.bytes as i64),
            total: Some(artifact.bytes as i64),
        },
    )
    .await?;
    Ok(artifact)
}

#[derive(Clone)]
struct ArticleInput {
    title: String,
    excerpt: String,
    markdown: String,
}

impl From<&Article> for ArticleInput {
    fn from(article: &Article) -> Self {
        Self {
            title: article.title.clone(),
            excerpt: article.excerpt.clone(),
            markdown: article.markdown.clone(),
        }
    }
}

struct Rendered {
    artifact: PdfArtifact,
    fallbacks: Vec<String>,
}

fn render(config: &Config, article: &ArticleInput, root: &Path) -> Result<Rendered> {
    let images = root.join("images");
    let date = chrono::Local::now().date_naive();
    let fonts = fonts(config);
    let mut fallback = HashSet::new();
    let mut round = 0;
    let (pdf, pages, source, formulas) = loop {
        let generated = generate(article, &images, date, &fallback);
        let world = TypesetWorld::new(fonts.clone(), generated.source.clone(), images.clone(), date);
        match compile(&world) {
            Ok((pdf, pages)) => break (pdf, pages, generated.source, generated.formulas),
            Err(errors) => {
                let failing = failing_formulas(&world, &errors);
                let fresh = failing
                    .iter()
                    .copied()
                    .filter(|index| !fallback.contains(index))
                    .collect::<Vec<_>>();
                round += 1;
                if fresh.is_empty() || round > MAX_FALLBACK_ROUNDS {
                    comemo::evict(0);
                    anyhow::bail!("Typst 排版失败：{}", describe(&world, &errors));
                }
                fallback.extend(fresh);
            }
        }
    };
    comemo::evict(10);
    let source_path = root.join("article.typ");
    std::fs::write(&source_path, &source).context("无法写入 Typst 源文件")?;
    let path = root.join("article.pdf");
    let partial = root.join("article.pdf.partial");
    std::fs::write(&partial, &pdf).context("无法写入 PDF")?;
    let _ = std::fs::remove_file(&path);
    std::fs::rename(&partial, &path).context("无法发布 PDF")?;
    let mut fallbacks = fallback
        .into_iter()
        .filter_map(|index| formulas.get(index).cloned())
        .map(|latex| latex.chars().take(160).collect::<String>())
        .collect::<Vec<_>>();
    fallbacks.sort();
    Ok(Rendered {
        artifact: PdfArtifact {
            path,
            source_path,
            bytes: pdf.len() as u64,
            pages,
        },
        fallbacks,
    })
}

fn compile(world: &TypesetWorld) -> Result<(Vec<u8>, usize), Vec<SourceDiagnostic>> {
    let document = typst::compile::<PagedDocument>(world)
        .output
        .map_err(|errors| errors.to_vec())?;
    let pages = document.pages().len();
    let pdf = typst_pdf::pdf(&document, &typst_pdf::PdfOptions::default())
        .map_err(|errors| errors.to_vec())?;
    Ok((pdf, pages))
}

/// Finds `#dm(index, "…")` / `#dmb(index, "…")` calls implicated by the
/// errors, either directly or through the call trace.
fn failing_formulas(world: &TypesetWorld, errors: &[SourceDiagnostic]) -> Vec<usize> {
    let text = world.source.text();
    let mut found = Vec::new();
    for error in errors {
        let spans = std::iter::once(error.span)
            .chain(error.trace.iter().map(|point| point.span.into()));
        for span in spans {
            if span.id() != Some(world.main) {
                continue;
            }
            let Some(range) = world.range(span) else {
                continue;
            };
            // The span may start at the call name (just after `#`) or inside
            // its arguments; the containing call is the last `#dm` before it.
            let limit = (range.start + 2).min(text.len());
            let Some(start) = text.get(..limit).and_then(|prefix| prefix.rfind("#dm")) else {
                continue;
            };
            if let Some((index, end)) = formula_call(text, start)
                && range.start < end
            {
                found.push(index);
            }
        }
    }
    found.sort_unstable();
    found.dedup();
    found
}

/// Parses a generated formula call at `start` and returns its index and the
/// byte offset just past its closing parenthesis.
fn formula_call(text: &str, start: usize) -> Option<(usize, usize)> {
    static CALL: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r#"^#dmb?\((\d+), ""#).expect("static formula call regex"));
    let rest = text.get(start..)?;
    let captures = CALL.captures(rest)?;
    let index = captures[1].parse().ok()?;
    let mut escaped = false;
    for (offset, ch) in rest[captures[0].len()..].char_indices() {
        match ch {
            _ if escaped => escaped = false,
            '\\' => escaped = true,
            '"' => {
                let after_quote = start + captures[0].len() + offset + 1;
                return text[after_quote..]
                    .starts_with(')')
                    .then_some((index, after_quote + 1));
            }
            _ => {}
        }
    }
    None
}

fn describe(world: &TypesetWorld, errors: &[SourceDiagnostic]) -> String {
    errors
        .iter()
        .take(3)
        .map(|error| {
            let excerpt = world
                .range(error.span)
                .filter(|_| error.span.id() == Some(world.main))
                .and_then(|range| world.source.text().get(range))
                .map(|text| format!("（{}）", text.chars().take(80).collect::<String>()))
                .unwrap_or_default();
            format!("{}{excerpt}", error.message)
        })
        .collect::<Vec<_>>()
        .join("；")
}

// ---------------------------------------------------------------------------
// Fonts and the Typst world
// ---------------------------------------------------------------------------

static LIBRARY: LazyLock<LazyHash<Library>> = LazyLock::new(|| LazyHash::new(Library::default()));
static FONTS: OnceLock<Arc<FontStore>> = OnceLock::new();

fn fonts(config: &Config) -> Arc<FontStore> {
    FONTS
        .get_or_init(|| {
            let mut store = FontStore::new();
            store.extend(typst_kit::fonts::embedded());
            if let Some(dir) = config.bundled_font_dir() {
                store.extend(typst_kit::fonts::scan(&dir));
            }
            store.extend(typst_kit::fonts::system());
            Arc::new(store)
        })
        .clone()
}

struct TypesetWorld {
    fonts: Arc<FontStore>,
    main: FileId,
    source: Source,
    images: PathBuf,
    today: Option<Datetime>,
}

impl TypesetWorld {
    fn new(fonts: Arc<FontStore>, text: String, images: PathBuf, date: chrono::NaiveDate) -> Self {
        let main = RootedPath::new(
            VirtualRoot::Project,
            VirtualPath::new("/main.typ").expect("static main path"),
        )
        .intern();
        Self {
            fonts,
            main,
            source: Source::new(main, text),
            images,
            today: Datetime::from_ymd(date.year(), date.month() as u8, date.day() as u8),
        }
    }

    fn package_file(id: FileId) -> Option<&'static [u8]> {
        let VirtualRoot::Package(spec) = id.root() else {
            return None;
        };
        let version = (spec.version.major, spec.version.minor, spec.version.patch);
        if spec.namespace != "preview" || spec.name != "mitex" || version != MITEX_VERSION {
            return None;
        }
        let path = id.vpath().get_without_slash();
        MITEX_FILES
            .iter()
            .find(|(name, _)| *name == path)
            .map(|(_, bytes)| *bytes)
    }

    fn project_file(&self, id: FileId) -> FileResult<Bytes> {
        let path = id.vpath().get_without_slash();
        let name = path
            .strip_prefix("images/")
            .filter(|name| safe_file_name(name))
            .ok_or_else(|| FileError::NotFound(PathBuf::from(path)))?;
        let full = self.images.join(name);
        std::fs::read(&full)
            .map(Bytes::new)
            .map_err(|_| FileError::NotFound(full))
    }
}

impl World for TypesetWorld {
    fn library(&self) -> &LazyHash<Library> {
        &LIBRARY
    }

    fn book(&self) -> &LazyHash<FontBook> {
        self.fonts.book()
    }

    fn main(&self) -> FileId {
        self.main
    }

    fn source(&self, id: FileId) -> FileResult<Source> {
        if id == self.main {
            return Ok(self.source.clone());
        }
        let bytes = Self::package_file(id)
            .ok_or_else(|| FileError::NotFound(PathBuf::from(id.vpath().get_with_slash())))?;
        let text = std::str::from_utf8(bytes).map_err(|_| FileError::InvalidUtf8)?;
        Ok(Source::new(id, text.to_string()))
    }

    fn file(&self, id: FileId) -> FileResult<Bytes> {
        if id == self.main {
            return Ok(Bytes::from_string(self.source.text().to_string()));
        }
        if let Some(bytes) = Self::package_file(id) {
            return Ok(Bytes::new(bytes));
        }
        if matches!(id.root(), VirtualRoot::Project) {
            return self.project_file(id);
        }
        Err(FileError::NotFound(PathBuf::from(id.vpath().get_with_slash())))
    }

    fn font(&self, index: usize) -> Option<Font> {
        self.fonts.font(index)
    }

    fn today(&self, _offset: Option<typst::foundations::Duration>) -> Option<Datetime> {
        self.today
    }
}

fn safe_file_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
        && !name.starts_with('.')
}

// ---------------------------------------------------------------------------
// Markdown → Typst
// ---------------------------------------------------------------------------

struct Generated {
    source: String,
    formulas: Vec<String>,
}

fn generate(
    article: &ArticleInput,
    images: &Path,
    date: chrono::NaiveDate,
    fallback: &HashSet<usize>,
) -> Generated {
    let mut writer = Writer {
        images: images.to_path_buf(),
        fallback,
        formulas: Vec::new(),
        footnotes: HashMap::new(),
    };
    let arena = Arena::new();
    let mut options = Options::default();
    options.extension.table = true;
    options.extension.strikethrough = true;
    options.extension.tasklist = true;
    options.extension.autolink = true;
    options.extension.footnotes = true;
    options.extension.math_dollars = true;
    let root = comrak::parse_document(&arena, &article.markdown, &options);

    // Footnote bodies are inserted where they are referenced.
    for node in root.children() {
        if let NodeValue::FootnoteDefinition(definition) = &node.data().value {
            let name = definition.name.clone();
            let body = writer.blocks(node);
            writer.footnotes.insert(name, body);
        }
    }
    let mut body = Vec::new();
    let mut first = true;
    for node in root.children() {
        // The article title is shown in the title block; drop a leading H1
        // that repeats it, as the HTML reader does.
        if first
            && let NodeValue::Heading(heading) = &node.data().value
            && heading.level == 1
            && plain_text(node).trim() == article.title.trim()
        {
            first = false;
            continue;
        }
        first = false;
        if let Some(block) = writer.block(node) {
            body.push(block);
        }
    }

    let abstract_value = if article.excerpt.trim().is_empty() {
        "none".to_string()
    } else {
        typst_str(article.excerpt.trim())
    };
    let source = format!(
        "#let doc-title = {}\n#let doc-date = {}\n#let doc-abstract = {}\n{}\n{}\n",
        typst_str(article.title.trim()),
        typst_str(&date.format("%Y-%m-%d").to_string()),
        abstract_value,
        TEMPLATE,
        body.join("\n\n")
    );
    Generated {
        source,
        formulas: writer.formulas,
    }
}

struct Writer<'f> {
    images: PathBuf,
    fallback: &'f HashSet<usize>,
    formulas: Vec<String>,
    footnotes: HashMap<String, String>,
}

impl Writer<'_> {
    fn blocks<'a>(&mut self, node: &'a AstNode<'a>) -> String {
        node.children()
            .filter_map(|child| self.block(child))
            .collect::<Vec<_>>()
            .join("\n\n")
    }

    fn block<'a>(&mut self, node: &'a AstNode<'a>) -> Option<String> {
        let value = node.data().value.clone();
        let markup = match value {
            NodeValue::Paragraph => {
                let inline = self.inlines(node);
                if inline.is_empty() {
                    return None;
                }
                inline
            }
            NodeValue::Heading(heading) => {
                let inline = self.inlines(node);
                if inline.is_empty() {
                    return None;
                }
                format!("#heading(level: {})[{inline}]", heading.level.clamp(1, 6))
            }
            NodeValue::List(list) => {
                let items = node
                    .children()
                    .map(|item| {
                        let mut content = self.blocks(item);
                        if let NodeValue::TaskItem(mark) = item.data().value {
                            let symbol = if mark.is_some() { "☑ " } else { "☐ " };
                            content = format!("#{}{content}", typst_str(symbol));
                        }
                        format!("[{content}]")
                    })
                    .collect::<Vec<_>>()
                    .join(", ");
                if items.is_empty() {
                    return None;
                }
                match list.list_type {
                    ListType::Bullet => format!("#list(tight: {}, {items})", list.tight),
                    ListType::Ordered => format!(
                        "#enum(tight: {}, start: {}, {items})",
                        list.tight,
                        list.start.max(1)
                    ),
                }
            }
            NodeValue::BlockQuote | NodeValue::MultilineBlockQuote(_) => {
                format!("#docquote[{}]", self.blocks(node))
            }
            NodeValue::CodeBlock(code) => {
                let lang = code
                    .info
                    .split_whitespace()
                    .next()
                    .filter(|lang| {
                        !lang.is_empty()
                            && lang
                                .chars()
                                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '+' | '-' | '_'))
                    })
                    .map(|lang| format!(", lang: {}", typst_str(lang)))
                    .unwrap_or_default();
                format!(
                    "#raw(block: true{lang}, {})",
                    typst_str(code.literal.trim_end_matches('\n'))
                )
            }
            NodeValue::ThematicBreak => "#docrule()".into(),
            NodeValue::Table(table) => self.markdown_table(node, &table.alignments),
            NodeValue::HtmlBlock(html) => {
                let blocks = self.html_blocks(&html.literal);
                if blocks.is_empty() {
                    return None;
                }
                blocks.join("\n\n")
            }
            NodeValue::FootnoteDefinition(_) | NodeValue::FrontMatter(_) => return None,
            NodeValue::Item(_) | NodeValue::TaskItem(_) | NodeValue::Document => {
                self.blocks(node)
            }
            _ => {
                let inline = self.inlines(node);
                if inline.is_empty() {
                    let blocks = self.blocks(node);
                    if blocks.is_empty() {
                        return None;
                    }
                    blocks
                } else {
                    inline
                }
            }
        };
        Some(markup)
    }

    fn inlines<'a>(&mut self, node: &'a AstNode<'a>) -> String {
        let mut inline = Inline::default();
        for child in node.children() {
            self.inline(child, &mut inline);
        }
        inline.finish()
    }

    fn inline<'a>(&mut self, node: &'a AstNode<'a>, out: &mut Inline) {
        let value = node.data().value.clone();
        match value {
            NodeValue::Text(text) => out.text(&text),
            NodeValue::SoftBreak => out.soft_break(),
            NodeValue::LineBreak => out.code("#linebreak()"),
            NodeValue::Code(code) => out.code(&format!("#raw({})", typst_str(&code.literal))),
            NodeValue::Math(math) => {
                let code = self.formula(&math.literal, math.display_math);
                out.code(&code);
            }
            NodeValue::Emph => self.wrap(node, out, "emph"),
            NodeValue::Strong => self.wrap(node, out, "strong"),
            NodeValue::Strikethrough => self.wrap(node, out, "strike"),
            NodeValue::Underline => self.wrap(node, out, "underline"),
            NodeValue::Highlight => self.wrap(node, out, "highlight"),
            NodeValue::Superscript => self.wrap(node, out, "super"),
            NodeValue::Subscript => self.wrap(node, out, "sub"),
            NodeValue::Link(link) => {
                let label = self.inlines(node);
                let url = link.url.trim();
                if url.starts_with("http://") || url.starts_with("https://") || url.starts_with("mailto:") {
                    let label = if label.is_empty() {
                        format!("#{}", typst_str(url))
                    } else {
                        label
                    };
                    out.code(&format!("#link({})[{label}]", typst_str(url)));
                } else {
                    out.code(&label);
                }
            }
            NodeValue::Image(link) => {
                if let Some(image) = self.image(&link.url) {
                    out.code(&image);
                }
            }
            NodeValue::FootnoteReference(reference) => {
                match self.footnotes.get(&reference.name).cloned() {
                    Some(body) => out.code(&format!("#footnote[{body}]")),
                    None => out.code(&format!("#super[#{}]", typst_str(&reference.name))),
                }
            }
            NodeValue::HtmlInline(html) => self.html_inline(&html, out),
            NodeValue::TaskItem(_) | NodeValue::Escaped | NodeValue::SpoileredText => {
                for child in node.children() {
                    self.inline(child, out);
                }
            }
            _ => {
                for child in node.children() {
                    self.inline(child, out);
                }
            }
        }
    }

    fn wrap<'a>(&mut self, node: &'a AstNode<'a>, out: &mut Inline, function: &str) {
        let body = self.inlines(node);
        if !body.is_empty() {
            out.code(&format!("#{function}[{body}]"));
        }
    }

    fn formula(&mut self, latex: &str, display: bool) -> String {
        let latex = latex.trim();
        let index = self.formulas.len();
        self.formulas.push(latex.to_string());
        let literal = typst_str(latex);
        match (self.fallback.contains(&index), display) {
            (false, false) => format!("#dm({index}, {literal})"),
            (false, true) => format!("#dmb({index}, {literal})"),
            (true, false) => format!("#dmraw({literal})"),
            (true, true) => format!("#dmrawb({literal})"),
        }
    }

    fn image(&self, url: &str) -> Option<String> {
        let name = url.trim().strip_prefix("images/")?;
        if !safe_file_name(name) || !self.images.join(name).is_file() {
            return None;
        }
        let width = match image::image_dimensions(self.images.join(name)) {
            Ok((width, height)) if width > 0 && height > 0 => {
                // MinerU crops pages at roughly 150 dpi.
                let mut points = f64::from(width) * 72.0 / 150.0;
                points = points.min(TEXT_WIDTH_PT * 0.92);
                let scaled_height = points * f64::from(height) / f64::from(width);
                if scaled_height > MAX_IMAGE_HEIGHT_PT {
                    points *= MAX_IMAGE_HEIGHT_PT / scaled_height;
                }
                format!("{:.1}pt", points.max(24.0))
            }
            _ => "80%".into(),
        };
        Some(format!(
            "#docimage({}, {width})",
            typst_str(&format!("images/{name}"))
        ))
    }

    fn markdown_table<'a>(&mut self, node: &'a AstNode<'a>, alignments: &[TableAlignment]) -> String {
        let columns = alignments.len().max(1);
        let align = alignments
            .iter()
            .map(|alignment| match alignment {
                TableAlignment::Center => "center",
                TableAlignment::Right => "right",
                _ => "left",
            })
            .collect::<Vec<_>>()
            .join(", ");
        let mut header = Vec::new();
        let mut cells = Vec::new();
        for row in node.children() {
            let is_header = matches!(row.data().value, NodeValue::TableRow(true));
            for cell in row.children() {
                let content = format!("[{}]", self.inlines(cell));
                if is_header {
                    header.push(content);
                } else {
                    cells.push(content);
                }
            }
        }
        let header_rows = usize::from(!header.is_empty());
        let mut args = vec![
            format!("columns: {columns}"),
            format!("align: ({align},)"),
        ];
        if !header.is_empty() {
            args.push(format!("table.header({})", header.join(", ")));
        }
        args.extend(cells);
        format!("#doctable({header_rows}, {})", args.join(", "))
    }

    // -- HTML (MinerU emits tables and occasional markup as raw HTML) --------

    fn html_blocks(&mut self, html: &str) -> Vec<String> {
        let fragment = Html::parse_fragment(html);
        let mut blocks = Vec::new();
        for child in fragment.root_element().children() {
            self.html_block(child, &mut blocks);
        }
        blocks
    }

    fn html_block(&mut self, node: ego_tree::NodeRef<'_, HtmlNode>, blocks: &mut Vec<String>) {
        match node.value() {
            HtmlNode::Text(text) => {
                let mut inline = Inline::default();
                self.text_with_math(text, &mut inline);
                let markup = inline.finish();
                if !markup.is_empty() {
                    blocks.push(markup);
                }
            }
            HtmlNode::Element(_) => {
                let Some(element) = ElementRef::wrap(node) else {
                    return;
                };
                match element.value().name() {
                    "table" => {
                        if let Some(table) = self.html_table(element) {
                            blocks.push(table);
                        }
                    }
                    "img" => {
                        if let Some(image) = element.value().attr("src").and_then(|src| self.image(src)) {
                            blocks.push(image);
                        }
                    }
                    name @ ("h1" | "h2" | "h3" | "h4" | "h5" | "h6") => {
                        let level = name[1..].parse::<u8>().unwrap_or(2);
                        let inline = self.html_inlines(element);
                        if !inline.is_empty() {
                            blocks.push(format!("#heading(level: {level})[{inline}]"));
                        }
                    }
                    "ul" | "ol" => {
                        let items = element
                            .children()
                            .filter_map(ElementRef::wrap)
                            .filter(|item| item.value().name() == "li")
                            .map(|item| format!("[{}]", self.html_inlines(item)))
                            .collect::<Vec<_>>();
                        if !items.is_empty() {
                            let function = if element.value().name() == "ol" { "enum" } else { "list" };
                            blocks.push(format!("#{function}({})", items.join(", ")));
                        }
                    }
                    "blockquote" => {
                        let mut inner = Vec::new();
                        for child in node.children() {
                            self.html_block(child, &mut inner);
                        }
                        if !inner.is_empty() {
                            blocks.push(format!("#docquote[{}]", inner.join("\n\n")));
                        }
                    }
                    "figcaption" | "caption" => {
                        let inline = self.html_inlines(element);
                        if !inline.is_empty() {
                            blocks.push(format!("#doccaption[{inline}]"));
                        }
                    }
                    "br" | "hr" | "script" | "style" | "head" | "meta" | "link" => {}
                    _ => {
                        if has_block_children(element) {
                            for child in node.children() {
                                self.html_block(child, blocks);
                            }
                        } else {
                            let inline = self.html_inlines(element);
                            if !inline.is_empty() {
                                blocks.push(inline);
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }

    fn html_inlines(&mut self, element: ElementRef<'_>) -> String {
        let mut inline = Inline::default();
        for child in element.children() {
            self.html_inline_node(child, &mut inline);
        }
        inline.finish()
    }

    fn html_inline_node(&mut self, node: ego_tree::NodeRef<'_, HtmlNode>, out: &mut Inline) {
        match node.value() {
            HtmlNode::Text(text) => self.text_with_math(text, out),
            HtmlNode::Element(element) => {
                let Some(element_ref) = ElementRef::wrap(node) else {
                    return;
                };
                let function = match element.name() {
                    "br" => {
                        out.code("#linebreak()");
                        return;
                    }
                    "img" => {
                        if let Some(image) = element.attr("src").and_then(|src| self.image(src)) {
                            out.code(&image);
                        }
                        return;
                    }
                    "b" | "strong" => Some("strong"),
                    "i" | "em" => Some("emph"),
                    "sup" => Some("super"),
                    "sub" => Some("sub"),
                    "u" => Some("underline"),
                    "s" | "del" | "strike" => Some("strike"),
                    "script" | "style" => return,
                    _ => None,
                };
                match function {
                    Some(function) => {
                        let body = self.html_inlines(element_ref);
                        if !body.is_empty() {
                            out.code(&format!("#{function}[{body}]"));
                        }
                    }
                    None => {
                        for child in node.children() {
                            self.html_inline_node(child, out);
                        }
                    }
                }
            }
            _ => {}
        }
    }

    fn html_inline(&mut self, html: &str, out: &mut Inline) {
        let tag = html.trim().to_ascii_lowercase();
        if tag.starts_with("<br") {
            out.code("#linebreak()");
        } else if tag.starts_with("<img") {
            let fragment = Html::parse_fragment(html);
            if let Some(src) = fragment
                .root_element()
                .descendants()
                .filter_map(ElementRef::wrap)
                .find(|element| element.value().name() == "img")
                .and_then(|element| element.value().attr("src").map(str::to_string))
                && let Some(image) = self.image(&src)
            {
                out.code(&image);
            }
        }
        // Other inline tags (<sup>, </span>, …) are dropped; their text
        // content arrives as separate text nodes.
    }

    fn html_table(&mut self, table: ElementRef<'_>) -> Option<String> {
        struct Cell {
            content: String,
            colspan: usize,
            rowspan: usize,
        }
        let mut rows: Vec<(bool, Vec<Cell>)> = Vec::new();
        for row in table
            .descendants()
            .filter_map(ElementRef::wrap)
            .filter(|element| element.value().name() == "tr")
        {
            // Skip rows of nested tables.
            if row
                .ancestors()
                .filter_map(ElementRef::wrap)
                .find(|element| element.value().name() == "table")
                .is_some_and(|owner| owner.id() != table.id())
            {
                continue;
            }
            let in_head = row
                .ancestors()
                .filter_map(ElementRef::wrap)
                .any(|element| element.value().name() == "thead");
            let mut cells = Vec::new();
            let mut all_th = true;
            for cell in row.children().filter_map(ElementRef::wrap) {
                let name = cell.value().name();
                if name != "td" && name != "th" {
                    continue;
                }
                all_th &= name == "th";
                let span = |attr: &str| {
                    cell.value()
                        .attr(attr)
                        .and_then(|value| value.trim().parse::<usize>().ok())
                        .unwrap_or(1)
                        .clamp(1, 64)
                };
                cells.push(Cell {
                    content: self.html_inlines(cell),
                    colspan: span("colspan"),
                    rowspan: span("rowspan"),
                });
            }
            if !cells.is_empty() {
                rows.push((in_head || all_th, cells));
            }
        }
        if rows.is_empty() {
            return None;
        }
        // Column count via the same occupancy rules Typst uses for placement.
        let mut occupied: Vec<Vec<bool>> = vec![Vec::new(); rows.len()];
        let mut columns = 1;
        for (row_index, (_, cells)) in rows.iter().enumerate() {
            let mut column = 0;
            for cell in cells {
                while occupied[row_index].get(column).copied().unwrap_or(false) {
                    column += 1;
                }
                let last_row = (row_index + cell.rowspan).min(rows.len());
                for row in occupied.iter_mut().take(last_row).skip(row_index) {
                    if row.len() < column + cell.colspan {
                        row.resize(column + cell.colspan, false);
                    }
                    for slot in row.iter_mut().skip(column).take(cell.colspan) {
                        *slot = true;
                    }
                }
                column += cell.colspan;
                columns = columns.max(column);
            }
        }
        let header_rows = rows.iter().take_while(|(header, _)| *header).count();
        // A header must not have rowspans reaching into the body.
        let header_rows = if rows
            .iter()
            .take(header_rows)
            .enumerate()
            .any(|(index, (_, cells))| cells.iter().any(|cell| index + cell.rowspan > header_rows))
        {
            0
        } else {
            header_rows
        };
        let render = |cell: &Cell| {
            if cell.colspan == 1 && cell.rowspan == 1 {
                format!("[{}]", cell.content)
            } else {
                format!(
                    "table.cell(colspan: {}, rowspan: {})[{}]",
                    cell.colspan, cell.rowspan, cell.content
                )
            }
        };
        let mut args = vec![format!("columns: {columns}")];
        if header_rows > 0 {
            let header = rows
                .iter()
                .take(header_rows)
                .flat_map(|(_, cells)| cells.iter().map(render))
                .collect::<Vec<_>>();
            args.push(format!("table.header({})", header.join(", ")));
        }
        args.extend(
            rows.iter()
                .skip(header_rows)
                .flat_map(|(_, cells)| cells.iter().map(render)),
        );
        Some(format!("#doctable({header_rows}, {})", args.join(", ")))
    }

    /// Splits `$…$` / `$$…$$` math out of HTML text (MinerU table cells).
    fn text_with_math(&mut self, text: &str, out: &mut Inline) {
        static MATH: LazyLock<Regex> = LazyLock::new(|| {
            Regex::new(r"(?s)\$\$(.+?)\$\$|\$([^$\n]+?)\$").expect("static math regex")
        });
        let mut cursor = 0;
        for captures in MATH.captures_iter(text) {
            let whole = captures.get(0).expect("match");
            out.text(&collapse_whitespace(&text[cursor..whole.start()]));
            let (latex, display) = match (captures.get(1), captures.get(2)) {
                (Some(block), _) => (block.as_str(), true),
                (_, Some(inline)) => (inline.as_str(), false),
                _ => unreachable!("one alternative always matches"),
            };
            let code = self.formula(latex, display);
            out.code(&code);
            cursor = whole.end();
        }
        out.text(&collapse_whitespace(&text[cursor..]));
    }
}

fn has_block_children(element: ElementRef<'_>) -> bool {
    element.children().filter_map(ElementRef::wrap).any(|child| {
        matches!(
            child.value().name(),
            "table" | "p" | "div" | "section" | "article" | "figure" | "ul" | "ol" | "blockquote"
                | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "img" | "figcaption"
        )
    })
}

fn collapse_whitespace(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut space = false;
    for ch in text.chars() {
        if ch.is_whitespace() {
            space = true;
        } else {
            if space && !result.is_empty() {
                result.push(SOFT_BREAK);
            }
            space = false;
            result.push(ch);
        }
    }
    if space && !result.is_empty() {
        result.push(SOFT_BREAK);
    }
    result
}

fn plain_text<'a>(node: &'a AstNode<'a>) -> String {
    let mut text = String::new();
    for descendant in node.descendants() {
        match &descendant.data().value {
            NodeValue::Text(value) => text.push_str(value),
            NodeValue::Code(code) => text.push_str(&code.literal),
            NodeValue::SoftBreak | NodeValue::LineBreak => text.push(' '),
            _ => {}
        }
    }
    text
}

/// Accumulates inline content. Consecutive text is merged into a single
/// string literal; soft line breaks become spaces except next to CJK text.
#[derive(Default)]
struct Inline {
    out: String,
    pending: String,
}

impl Inline {
    fn text(&mut self, text: &str) {
        self.pending.push_str(text);
    }

    fn soft_break(&mut self) {
        self.pending.push(SOFT_BREAK);
    }

    fn code(&mut self, code: &str) {
        self.flush();
        self.out.push_str(code);
    }

    fn flush(&mut self) {
        if self.pending.is_empty() {
            return;
        }
        let resolved = resolve_soft_breaks(&self.pending);
        self.pending.clear();
        if !resolved.is_empty() {
            self.out.push('#');
            self.out.push_str(&typst_str(&resolved));
        }
    }

    fn finish(mut self) -> String {
        self.flush();
        let trimmed = self.out.trim();
        if trimmed == "#\"\"" {
            String::new()
        } else {
            trimmed.to_string()
        }
    }
}

fn resolve_soft_breaks(text: &str) -> String {
    let chars = text.chars().collect::<Vec<_>>();
    let mut result = String::with_capacity(text.len());
    for (index, ch) in chars.iter().enumerate() {
        if *ch != SOFT_BREAK {
            result.push(*ch);
            continue;
        }
        let previous = chars[..index].iter().rev().find(|ch| **ch != SOFT_BREAK);
        let next = chars[index + 1..].iter().find(|ch| **ch != SOFT_BREAK);
        let joins_cjk = previous.is_some_and(|ch| is_cjk(*ch)) || next.is_some_and(|ch| is_cjk(*ch));
        let duplicate = index > 0 && chars[index - 1] == SOFT_BREAK;
        let adjacent_space = previous.is_some_and(|ch| ch.is_whitespace())
            || next.is_some_and(|ch| ch.is_whitespace());
        // A break at the edge of this text run borders a formula or other
        // inline element: keep the word space unless the text side is CJK.
        if !joins_cjk && !duplicate && !adjacent_space {
            result.push(' ');
        }
    }
    result
}

fn is_cjk(ch: char) -> bool {
    matches!(ch as u32,
        0x2E80..=0x2FFF | 0x3000..=0x303F | 0x3040..=0x30FF | 0x3100..=0x31FF
        | 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xAC00..=0xD7AF | 0xF900..=0xFAFF
        | 0xFE30..=0xFE4F | 0xFF00..=0xFFEF | 0x20000..=0x2FA1F)
}

/// A Typst string literal. Control characters other than tab and newline are
/// dropped; everything else is escaped or kept verbatim.
fn typst_str(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            SOFT_BREAK => out.push(' '),
            ch if ch.is_control() => {}
            ch => out.push(ch),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn article(markdown: &str) -> ArticleInput {
        ArticleInput {
            title: "测试论文：Typst 排版".into(),
            excerpt: "这是一段摘要，包含 English words 与公式。".into(),
            markdown: markdown.into(),
        }
    }

    fn render_to(dir: &Path, markdown: &str) -> Rendered {
        std::fs::create_dir_all(dir.join("images")).unwrap();
        let config = Config::for_tests();
        render(&config, &article(markdown), dir).unwrap()
    }

    #[test]
    fn string_literals_cannot_escape_into_typst_code() {
        assert_eq!(typst_str("a\"b\\c\n#let x = 1"), "\"a\\\"b\\\\c\\n#let x = 1\"");
        let generated = generate(
            &article("正文 #set page(width: 1pt) [x] $y$ <label> @ref *不是强调*"),
            Path::new("images"),
            chrono::NaiveDate::from_ymd_opt(2026, 9, 11).unwrap(),
            &HashSet::new(),
        );
        let body = generated.source.split("// Title block").nth(1).unwrap();
        assert!(body.contains("#\"正文 #set page(width: 1pt) [x] \""));
        assert!(body.contains("#dm(0, \"y\")"));
        assert_eq!(generated.formulas, vec!["y"]);
    }

    #[test]
    #[ignore = "manual probe: DOCFLOW_PDF_ASSETS=<runtime>/pdf-assets"]
    fn probe_bundled_fonts() {
        let dir = PathBuf::from(std::env::var("DOCFLOW_PDF_ASSETS").unwrap()).join("fonts");
        let fonts = typst_kit::fonts::scan(&dir).collect::<Vec<_>>();
        println!("{} faces in {}", fonts.len(), dir.display());
        for (path, info) in fonts.iter().take(40) {
            println!("{:?} {} {:?}", path.path.file_name().unwrap(), info.family, info.variant);
        }
    }

    #[test]
    fn formula_calls_are_parsed_through_escaped_strings() {
        let text = r#"x #dm(3, "f(x) = \"a\\\" )") y"#;
        let start = text.find("#dm").unwrap();
        let (index, end) = formula_call(text, start).unwrap();
        assert_eq!(index, 3);
        assert_eq!(&text[end..], " y");
        assert!(formula_call("#dmraw(\"x\")", 0).is_none());
    }

    #[test]
    fn soft_breaks_join_cjk_lines_without_spaces() {
        let mut inline = Inline::default();
        inline.text("中文");
        inline.soft_break();
        inline.text("续行 and");
        inline.soft_break();
        inline.text("English is");
        inline.soft_break();
        inline.code("#dm(0, \"x\")");
        inline.text("，中文");
        inline.soft_break();
        inline.code("#dm(1, \"y\")");
        assert_eq!(
            inline.finish(),
            "#\"中文续行 and English is \"#dm(0, \"x\")#\"，中文\"#dm(1, \"y\")"
        );
    }

    #[test]
    fn html_table_spans_define_the_column_count() {
        let mut writer = Writer {
            images: PathBuf::from("images"),
            fallback: &HashSet::new(),
            formulas: Vec::new(),
            footnotes: HashMap::new(),
        };
        let blocks = writer.html_blocks(
            "<table><tr><th>方法</th><th colspan=\"2\">结果</th></tr><tr><td rowspan=\"2\">A</td><td>$x^2$</td><td>1</td></tr><tr><td>2</td><td>3</td></tr></table>",
        );
        assert_eq!(blocks.len(), 1);
        assert!(blocks[0].starts_with("#doctable(1, columns: 3, table.header("));
        assert!(blocks[0].contains("table.cell(colspan: 2, rowspan: 1)"));
        assert!(blocks[0].contains("table.cell(colspan: 1, rowspan: 2)"));
        assert!(blocks[0].contains("#dm(0, \"x^2\")"));
    }

    #[test]
    fn renders_a_complete_article_to_pdf() {
        let dir = std::env::temp_dir().join(format!("docflow-typeset-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(dir.join("images")).unwrap();
        let figure = image::RgbImage::from_fn(600, 300, |x, y| {
            image::Rgb([(x % 255) as u8, (y % 255) as u8, 180])
        });
        figure.save(dir.join("images/figure.png")).unwrap();
        let markdown = "# 测试论文：Typst 排版\n\n## 1 引言\n\n面向长篇学术文档的自动处理系统，需要同时解决结构保真与翻译并发问题。\
            吞吐量可以写为 $T=\\sum_{i=1}^{n} c_i / p_i$，其中 $c_i$ 表示分块字符数。\n\n\
            $$\n\\mathcal{L}=\\frac{1}{N}\\sum_{i=1}^{N}\\left\\|y_i-\\hat{y}_i\\right\\|_2^2+\\lambda\\Omega(\\theta)\n$$\n\n\
            ![图](images/figure.png)\n\n\
            <table><tr><th>方案</th><th>并发模型</th></tr><tr><td>串行</td><td>单队列 $O(n)$</td></tr></table>\n\n\
            | 列一 | 列二 |\n| :-- | --: |\n| a | **b** |\n\n\
            - 第一项\n- 第二项 `code`\n\n> 引用内容[^1]\n\n[^1]: 脚注正文。\n\n```rust\nfn main() {}\n```\n";
        let rendered = render_to(&dir, markdown);
        assert!(rendered.fallbacks.is_empty(), "{:?}", rendered.fallbacks);
        assert!(rendered.artifact.pages >= 1);
        let pdf = std::fs::read(&rendered.artifact.path).unwrap();
        assert!(pdf.starts_with(b"%PDF-"));
        assert!(std::fs::read_to_string(&rendered.artifact.source_path)
            .unwrap()
            .contains("#dmb(2,"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unconvertible_formulas_fall_back_to_latex_source() {
        let dir = std::env::temp_dir().join(format!("docflow-typeset-{}", uuid::Uuid::new_v4().simple()));
        let rendered = render_to(
            &dir,
            "正常公式 $a+b$，异常公式 $\\frac{1}{$ 与 $\\begin{unknownenv} x \\end{unknownenv}$。",
        );
        assert!(!rendered.fallbacks.is_empty());
        assert!(rendered.artifact.bytes > 1_000);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
