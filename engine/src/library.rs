//! Document library operations requested by the host application.

use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::{
    events::{self, EventInput},
    models::{
        DOCUMENT_COLUMNS, Document, DocumentFiles, DocumentList, DocumentView, EventList,
        ProcessingEvent, StatusCounts,
    },
    now,
    pipeline::document_root,
    providers,
    secrets::{self, MINERU},
    settings::{self, TranslatorChoice},
    state::AppState,
};

pub const MINERU_EXTENSIONS: &[&str] = &[
    ".pdf", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", ".png", ".jpg", ".jpeg", ".jp2",
    ".webp", ".gif", ".bmp", ".html", ".htm",
];
pub const PDF2ZH_EXTENSIONS: &[&str] = &[".pdf"];

/// A user-facing error: shown as-is by the host.
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct UserError(pub String);

fn user(message: impl Into<String>) -> anyhow::Error {
    UserError(message.into()).into()
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateInput {
    pub path: PathBuf,
    #[serde(default)]
    pub title: Option<String>,
    pub mode: String,
    pub translator: TranslatorChoice,
}

pub fn extensions_for(mode: &str) -> &'static [&'static str] {
    if mode == "pdf2zh" { PDF2ZH_EXTENSIONS } else { MINERU_EXTENSIONS }
}

fn extension_of(path: &Path) -> String {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{}", value.to_ascii_lowercase()))
        .unwrap_or_default()
}

pub async fn create(state: &Arc<AppState>, input: CreateInput) -> Result<DocumentView> {
    let mode = input.mode.trim();
    if mode != "mineru" && mode != "pdf2zh" {
        return Err(user("处理方式只能是 MinerU 解析翻译或 PDF 原生翻译"));
    }
    let translator_label = translator_label(state, &input.translator).await?;
    if mode == "mineru"
        && !state.secrets.configured(MINERU)
        && state.config.fake_mineru_zip.is_none()
    {
        return Err(user("MinerU 解析翻译需要先在设置中填写 MinerU API Key"));
    }
    if mode == "pdf2zh" && !state.config.pdf2zh_available() {
        return Err(user("PDF 原生翻译运行环境未安装或不完整，请重新安装应用"));
    }

    let source = input.path;
    let metadata = tokio::fs::metadata(&source)
        .await
        .map_err(|_| user(format!("无法读取文件：{}", source.display())))?;
    if !metadata.is_file() {
        return Err(user("请选择一个文件，而不是文件夹"));
    }
    if metadata.len() == 0 {
        return Err(user("文件为空"));
    }
    if metadata.len() > state.config.max_upload_bytes {
        return Err(user(format!(
            "文件不能超过 {} MB",
            state.config.max_upload_mb()
        )));
    }
    let extension = extension_of(&source);
    if !extensions_for(mode).contains(&extension.as_str()) {
        return Err(user(if mode == "pdf2zh" {
            "PDF 原生翻译只支持 .pdf 文件；其他格式请使用 MinerU 解析翻译".to_string()
        } else {
            format!(
                "不支持 {} 文件",
                if extension.is_empty() { "无扩展名" } else { &extension }
            )
        }));
    }
    if mode == "pdf2zh" {
        let mut prefix = Vec::with_capacity(1024);
        tokio::fs::File::open(&source)
            .await?
            .take(1024)
            .read_to_end(&mut prefix)
            .await?;
        if !prefix.windows(5).any(|window| window == b"%PDF-") {
            return Err(user("这不是有效的 PDF 文件；扫描件或其他格式请使用 MinerU 解析翻译"));
        }
    }

    let original_filename = source
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "document".into());
    let custom_title = input
        .title
        .as_deref()
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .map(clean_title)
        .transpose()?;
    let title = custom_title.clone().unwrap_or_else(|| {
        Path::new(&original_filename)
            .file_stem()
            .map(|stem| stem.to_string_lossy().into_owned())
            .filter(|stem| !stem.trim().is_empty())
            .unwrap_or_else(|| "未命名文档".into())
    });

    let id = uuid::Uuid::new_v4().to_string();
    let storage_key = uuid::Uuid::new_v4().simple().to_string();
    tokio::fs::create_dir_all(&state.config.archive_root).await?;
    let root = state.config.archive_root.join(&storage_key);
    // create_dir (not _all) proves this call owns the directory it may clean up.
    tokio::fs::create_dir(&root).await?;
    let translator = (&input.translator, translator_label.as_str());
    let result = import(state, &id, &storage_key, &root, &source, &extension, &original_filename, &title, custom_title.is_some(), mode, translator).await;
    if result.is_err() {
        let _ = tokio::fs::remove_dir_all(&root).await;
    }
    result?;
    state.wake.notify_one();
    events::document_changed(&id);
    get(state, &id).await
}

#[allow(clippy::too_many_arguments)]
async fn import(
    state: &Arc<AppState>,
    id: &str,
    storage_key: &str,
    root: &Path,
    source: &Path,
    extension: &str,
    original_filename: &str,
    title: &str,
    title_custom: bool,
    mode: &str,
    (translator, translator_label): (&TranslatorChoice, &str),
) -> Result<()> {
    let source_dir = root.join("source");
    tokio::fs::create_dir_all(&source_dir).await?;
    let destination = source_dir.join(format!("source{extension}"));
    let partial = source_dir.join(format!(".source{extension}.importing"));
    let (size, sha256) = copy_with_digest(source, &partial).await?;
    tokio::fs::rename(&partial, &destination).await?;
    let relative_source = format!("archives/{storage_key}/source/source{extension}");
    let mime = if mode == "pdf2zh" {
        "application/pdf".to_string()
    } else {
        mime_guess::from_path(original_filename)
            .first_or_octet_stream()
            .to_string()
    };
    let preferences = settings::load_preferences(&state.pool).await?;
    let runtime = settings::load_translation_runtime(&state.pool).await?;
    // translation_tier stays for older documents: 1 Google, 2 large model.
    let tier = if matches!(translator, TranslatorChoice::Google) { 1 } else { 2 };
    sqlx::query(concat!(
        "INSERT INTO documents (id,title,title_custom,original_filename,storage_key,source_path,source_size,source_sha256,mime_type,processing_mode,translation_tier,translation_runtime_snapshot,mineru_model,translator,translator_label,status,stage,progress,queue_available_at,created_at,updated_at) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'queued','queued',2,",
        now!(),
        ",",
        now!(),
        ",",
        now!(),
        ")"
    ))
    .bind(id)
    .bind(title.chars().take(512).collect::<String>())
    .bind(title_custom)
    .bind(original_filename)
    .bind(storage_key)
    .bind(&relative_source)
    .bind(size as i64)
    .bind(&sha256)
    .bind(mime)
    .bind(mode)
    .bind(tier)
    .bind(serde_json::to_string(&runtime)?)
    .bind(&preferences.mineru_model)
    .bind(serde_json::to_string(translator)?)
    .bind(translator_label)
    .execute(&state.pool)
    .await?;
    events::append(
        &state.pool,
        id,
        EventInput {
            stage: "source_saved",
            state: "completed",
            level: "success",
            progress: 1,
            message: "源文件已复制到文档库",
            detail: Some(&format!("SHA-256 {sha256}；原文件不会被修改")),
            current: Some(size as i64),
            total: Some(size as i64),
        },
    )
    .await?;
    events::append(
        &state.pool,
        id,
        EventInput {
            stage: "queued",
            state: "running",
            level: "info",
            progress: 2,
            message: "任务已加入处理队列",
            detail: Some(&format!(
                "处理方式：{}；翻译服务：{translator_label}；翻译参数与提示词已固定为本任务快照，自动重试保持一致",
                if mode == "pdf2zh" { "PDF 原生翻译" } else { "MinerU 解析翻译" }
            )),
            current: None,
            total: None,
        },
    )
    .await?;
    Ok(())
}

async fn copy_with_digest(source: &Path, destination: &Path) -> Result<(u64, String)> {
    let mut input = tokio::fs::File::open(source)
        .await
        .with_context(|| format!("无法打开 {}", source.display()))?;
    let mut output = tokio::fs::File::create(destination).await?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    let mut total = 0_u64;
    loop {
        let read = input.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        output.write_all(&buffer[..read]).await?;
        total += read as u64;
    }
    output.flush().await?;
    output.sync_all().await?;
    Ok((total, hex::encode(hasher.finalize())))
}

/// Checks the chosen translation service and returns its display name.
async fn translator_label(state: &AppState, choice: &TranslatorChoice) -> Result<String> {
    choice.validate().map_err(|error| user(error.to_string()))?;
    let (provider_id, model) = match choice {
        TranslatorChoice::Google => return Ok("Google 翻译（免费）".into()),
        TranslatorChoice::Llm { provider_id, model } => (provider_id, model),
    };
    let provider = providers::load(&state.pool)
        .await?
        .into_iter()
        .find(|provider| &provider.id == provider_id)
        .ok_or_else(|| user("所选的大模型服务商不存在，请在设置中添加"))?;
    if !provider.enabled {
        return Err(user(format!("大模型服务商“{}”已停用", provider.name)));
    }
    if !provider.models.iter().any(|candidate| &candidate.id == model) {
        return Err(user(format!("“{}”的模型列表中没有 {model}，请先在设置中添加这个模型", provider.name)));
    }
    if !state.config.fake_providers
        && !provider.key_optional()
        && !state.secrets.configured(&secrets::provider_secret(&provider.id))
    {
        return Err(user(format!("请先在设置中填写“{}”的 API Key", provider.name)));
    }
    Ok(provider.model_label(model))
}

pub fn document_translator_label(document: &Document) -> String {
    document.translator_label.clone().unwrap_or_else(|| match document.translation_tier {
        1 => "Google 翻译".into(),
        _ => "DeepSeek".into(),
    })
}

fn clean_title(value: &str) -> Result<String> {
    let title = value.trim();
    if title.is_empty()
        || title.chars().count() > 512
        || title.chars().any(|ch| matches!(ch, '\0' | '\r' | '\n' | '\t'))
    {
        return Err(user("标题不能为空、不能换行，且不超过 512 个字符"));
    }
    Ok(title.to_string())
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ListInput {
    #[serde(default)]
    pub filter: Option<String>,
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub limit: Option<i64>,
    #[serde(default)]
    pub offset: Option<i64>,
}

pub async fn list(state: &AppState, input: ListInput) -> Result<DocumentList> {
    let filter = match input.filter.as_deref().unwrap_or("all") {
        "all" => "1=1",
        "active" => "status IN ('queued','processing','retrying')",
        "completed" => "status='completed'",
        "failed" => "status IN ('failed','cancelled')",
        other => return Err(user(format!("未知的筛选条件：{other}"))),
    };
    let query = input.query.unwrap_or_default().trim().to_string();
    let pattern = format!(
        "%{}%",
        query.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
    );
    let limit = input.limit.unwrap_or(500).clamp(1, 5_000);
    let offset = input.offset.unwrap_or(0).max(0);
    let search = "(title LIKE $1 ESCAPE '\\' OR original_filename LIKE $1 ESCAPE '\\')";
    let items = sqlx::query_as::<_, Document>(&format!(
        "SELECT {DOCUMENT_COLUMNS} FROM documents WHERE {filter} AND {search} ORDER BY created_at DESC LIMIT $2 OFFSET $3"
    ))
    .bind(&pattern)
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.pool)
    .await?;
    let total: i64 = sqlx::query_scalar(&format!(
        "SELECT COUNT(*) FROM documents WHERE {filter} AND {search}"
    ))
    .bind(&pattern)
    .fetch_one(&state.pool)
    .await?;
    let rows: Vec<(String, i64)> =
        sqlx::query_as("SELECT status, COUNT(*) FROM documents GROUP BY status")
            .fetch_all(&state.pool)
            .await?;
    let mut counts = StatusCounts::default();
    for (status, count) in rows {
        counts.all += count;
        match status.as_str() {
            "queued" | "processing" | "retrying" => counts.active += count,
            "completed" => counts.completed += count,
            "failed" | "cancelled" => counts.failed += count,
            _ => {}
        }
    }
    Ok(DocumentList {
        items,
        total,
        counts,
    })
}

pub async fn find(state: &AppState, id: &str) -> Result<Document> {
    sqlx::query_as::<_, Document>(&format!(
        "SELECT {DOCUMENT_COLUMNS} FROM documents WHERE id=$1"
    ))
    .bind(id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| user("文档不存在或已被删除"))
}

pub async fn get(state: &AppState, id: &str) -> Result<DocumentView> {
    let document = find(state, id).await?;
    let files = files(state, &document);
    Ok(DocumentView { document, files })
}

fn existing(path: PathBuf) -> Option<String> {
    path.is_file().then(|| path.to_string_lossy().into_owned())
}

/// Joins a stored `a/b/c` path onto the data root with native separators.
fn data_path(root: &Path, relative: &str) -> PathBuf {
    relative
        .split('/')
        .filter(|part| !part.is_empty())
        .fold(root.to_path_buf(), |path, part| path.join(part))
}

fn files(state: &AppState, document: &Document) -> DocumentFiles {
    let data = &state.config.data_root;
    let archive = data_path(
        data,
        &document
            .archive_path
            .clone()
            .unwrap_or_else(|| format!("archives/{}", document.storage_key)),
    );
    let pdf = document.pdf_path.as_ref().map(|path| data_path(data, path));
    let native = document.processing_mode == "pdf2zh";
    DocumentFiles {
        source: existing(data_path(data, &document.source_path)),
        archive_dir: archive
            .is_dir()
            .then(|| archive.to_string_lossy().into_owned()),
        journal_pdf: pdf.clone().filter(|_| !native).and_then(existing),
        mono_pdf: pdf.filter(|_| native).and_then(existing),
        dual_pdf: document
            .dual_pdf_path
            .as_ref()
            .map(|path| data_path(data, path))
            .and_then(existing),
        markdown: existing(archive.join("article").join("article.md")),
        markdown_original: existing(archive.join("markdown").join("original.md")),
        markdown_translated: existing(archive.join("markdown").join("translated.md")),
        reader_html: existing(archive.join("article").join("reader.html")),
    }
}

/// File names for "Save as…" dialogs, derived from the display title.
#[derive(Debug, Serialize)]
pub struct SuggestedNames {
    pub journal_pdf: String,
    pub mono_pdf: String,
    pub dual_pdf: String,
    pub markdown: String,
    pub bundle: String,
    pub source: String,
}

pub fn suggested_names(document: &Document) -> SuggestedNames {
    let stem = safe_file_stem(&document.title);
    SuggestedNames {
        journal_pdf: format!("{stem}.pdf"),
        mono_pdf: format!("{stem}-中文译文.pdf"),
        dual_pdf: format!("{stem}-双语对照.pdf"),
        markdown: format!("{stem}.md"),
        bundle: format!("{stem}-完整文件.zip"),
        source: document.original_filename.clone(),
    }
}

pub fn safe_file_stem(title: &str) -> String {
    let cleaned = title
        .chars()
        .map(|ch| {
            if ch.is_control() || matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
                '_'
            } else {
                ch
            }
        })
        .take(120)
        .collect::<String>();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    if trimmed.is_empty() {
        "文档".into()
    } else {
        trimmed.to_string()
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EventsInput {
    pub id: String,
    #[serde(default)]
    pub after_id: i64,
    #[serde(default)]
    pub limit: Option<i64>,
}

pub async fn events(state: &AppState, input: EventsInput) -> Result<EventList> {
    find(state, &input.id).await?;
    let limit = input.limit.unwrap_or(1_000).clamp(1, 5_000);
    let items = sqlx::query_as::<_, ProcessingEvent>("SELECT id,document_id,stage,state,level,progress,message,detail,current,total,created_at FROM processing_events WHERE document_id=$1 AND id>$2 ORDER BY id LIMIT $3")
        .bind(&input.id)
        .bind(input.after_id)
        .bind(limit + 1)
        .fetch_all(&state.pool)
        .await?;
    let has_more = items.len() as i64 > limit;
    let items = items.into_iter().take(limit as usize).collect::<Vec<_>>();
    let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM processing_events WHERE document_id=$1")
        .bind(&input.id)
        .fetch_one(&state.pool)
        .await?;
    Ok(EventList {
        next_after_id: items.last().map_or(input.after_id, |event| event.id),
        items,
        total,
        has_more,
    })
}

pub async fn rename(state: &AppState, id: &str, title: &str) -> Result<DocumentView> {
    let title = clean_title(title)?;
    let updated = sqlx::query(concat!(
        "UPDATE documents SET title=$2,title_custom=1,updated_at=",
        now!(),
        " WHERE id=$1"
    ))
    .bind(id)
    .bind(title)
    .execute(&state.pool)
    .await?;
    if updated.rows_affected() == 0 {
        return Err(user("文档不存在或已被删除"));
    }
    events::document_changed(id);
    get(state, id).await
}

pub async fn retry(state: &Arc<AppState>, id: &str) -> Result<DocumentView> {
    let current = find(state, id).await?;
    if !matches!(current.status.as_str(), "failed" | "cancelled") {
        return Err(user("只有失败或已取消的任务才能重新处理"));
    }
    let runtime = settings::load_translation_runtime(&state.pool).await?;
    let updated = sqlx::query(concat!(
        "UPDATE documents SET status='queued',stage='manual_retry_queued',failure_reason=NULL,queue_attempts=0,queue_available_at=",
        now!(),
        ",completed_at=NULL,updated_at=",
        now!(),
        ",translation_runtime_snapshot=$2 WHERE id=$1 AND status IN ('failed','cancelled')"
    ))
    .bind(id)
    .bind(serde_json::to_string(&runtime)?)
    .execute(&state.pool)
    .await?;
    if updated.rows_affected() != 1 {
        return Err(user("任务状态已经变化，请刷新后重试"));
    }
    events::append(
        &state.pool,
        id,
        EventInput {
            stage: "manual_retry_queued",
            state: "warning",
            level: "warning",
            progress: current.progress as i32,
            message: "任务已重新加入处理队列",
            detail: Some("自动重试次数已重置；使用当前设置中的翻译参数与提示词；与本次参数一致的已校验翻译断点会被复用"),
            current: Some(0),
            total: Some(3),
        },
    )
    .await?;
    state.wake.notify_one();
    events::document_changed(id);
    get(state, id).await
}

pub async fn cancel(state: &Arc<AppState>, id: &str) -> Result<DocumentView> {
    let current = find(state, id).await?;
    let updated = sqlx::query(concat!(
        "UPDATE documents SET status='cancelled',stage='cancelled',failure_reason='已由用户取消',updated_at=",
        now!(),
        " WHERE id=$1 AND status IN ('queued','processing','retrying')"
    ))
    .bind(id)
    .execute(&state.pool)
    .await?;
    if updated.rows_affected() != 1 {
        return Err(user("任务已经结束，无法取消"));
    }
    state.abort_job(id);
    events::append(
        &state.pool,
        id,
        EventInput {
            stage: "cancelled",
            state: "failed",
            level: "warning",
            progress: current.progress as i32,
            message: "任务已取消",
            detail: Some("正在进行的解析、翻译或排版已停止；源文件和已校验的翻译断点仍保留，可随时重新处理"),
            current: None,
            total: None,
        },
    )
    .await?;
    state.wake.notify_one();
    events::document_changed(id);
    get(state, id).await
}

pub async fn delete(state: &Arc<AppState>, id: &str) -> Result<()> {
    let document = find(state, id).await?;
    if state.abort_job(id) {
        // Give the aborted task a moment to drop its child process and files.
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
    let archive = crate::pipeline::archive_root_in(&state.config.archive_root, &document.storage_key)?;
    let work = document_root(&state.config.work_root, id)?;
    let native_work = document_root(&state.config.native_work_root, id)?;
    for directory in [archive, work, native_work] {
        remove_dir_with_retry(&directory).await?;
    }
    sqlx::query("DELETE FROM documents WHERE id=$1")
        .bind(id)
        .execute(&state.pool)
        .await?;
    events::document_removed(id);
    Ok(())
}

async fn remove_dir_with_retry(directory: &Path) -> Result<()> {
    for attempt in 0..10 {
        match tokio::fs::remove_dir_all(directory).await {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            // Windows keeps files locked for a moment after a process exits.
            Err(_) if attempt < 9 => tokio::time::sleep(Duration::from_millis(300)).await,
            Err(error) => {
                return Err(error).with_context(|| {
                    format!("无法删除 {}，文件可能正被其他程序打开", directory.display())
                });
            }
        }
    }
    Ok(())
}

pub async fn export_bundle(state: &AppState, id: &str, destination: &Path) -> Result<u64> {
    let document = find(state, id).await?;
    let events = crate::pipeline::load_events(&state.pool, id).await?;
    let archive = crate::pipeline::archive_root_in(&state.config.archive_root, &document.storage_key)?;
    anyhow::ensure!(archive.is_dir(), "文档目录不存在");
    let destination = destination.to_path_buf();
    let partial = destination.with_extension("zip.partial");
    let build_partial = partial.clone();
    tokio::task::spawn_blocking(move || build_bundle(&build_partial, &archive, &document, &events))
        .await
        .context("打包线程异常退出")??;
    let _ = tokio::fs::remove_file(&destination).await;
    tokio::fs::rename(&partial, &destination)
        .await
        .with_context(|| format!("无法写入 {}", destination.display()))?;
    Ok(tokio::fs::metadata(&destination).await?.len())
}

fn build_bundle(
    output: &Path,
    archive: &Path,
    document: &Document,
    events: &[ProcessingEvent],
) -> Result<()> {
    use std::io::Write;
    use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

    let file = std::fs::File::create(output)
        .with_context(|| format!("无法创建 {}", output.display()))?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o644);
    let mut names = HashSet::new();
    for path in crate::pipeline::files_below(archive)? {
        let name = path
            .strip_prefix(archive)?
            .to_string_lossy()
            .replace('\\', "/");
        if name.ends_with(".partial") || name == "metadata/events.json" {
            continue;
        }
        zip.start_file(&name, options)?;
        std::io::copy(&mut std::fs::File::open(&path)?, &mut zip)?;
        names.insert(name);
    }
    zip.start_file("metadata/events.json", options)?;
    zip.write_all(&serde_json::to_vec_pretty(events)?)?;
    zip.start_file("README.txt", options)?;
    zip.write_all(
        format!(
            "DocFlow 导出\r\n标题：{}\r\n原始文件：{}\r\n处理方式：{}\r\n翻译服务：{}\r\n状态：{}\r\n",
            document.title,
            document.original_filename,
            if document.processing_mode == "pdf2zh" {
                "PDF 原生翻译"
            } else {
                "MinerU 解析翻译"
            },
            document_translator_label(document),
            document.status
        )
        .as_bytes(),
    )?;
    zip.finish()?;
    Ok(())
}

/// Called once at startup: jobs interrupted by quitting the app resume from
/// their checkpoints (MinerU batch id, translation caches).
pub async fn resume_interrupted(state: &AppState) -> Result<()> {
    let ids: Vec<(String, i64)> =
        sqlx::query_as("SELECT id, progress FROM documents WHERE status='processing'")
            .fetch_all(&state.pool)
            .await?;
    for (id, progress) in ids {
        sqlx::query(concat!(
            "UPDATE documents SET status='queued',stage='resumed_after_restart',queue_available_at=",
            now!(),
            ",updated_at=",
            now!(),
            " WHERE id=$1 AND status='processing'"
        ))
        .bind(&id)
        .execute(&state.pool)
        .await?;
        events::append(
            &state.pool,
            &id,
            EventInput {
                stage: "resumed_after_restart",
                state: "warning",
                level: "info",
                progress: progress as i32,
                message: "应用上次退出时任务仍在处理，现已重新排队",
                detail: Some("会复用已创建的 MinerU 批次和已校验的翻译断点，不会从头重复付费请求"),
                current: None,
                total: None,
            },
        )
        .await?;
    }
    Ok(())
}

pub fn is_permanent_input_error(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| cause.is::<UserError>())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;

    async fn state() -> Arc<AppState> {
        let config = Config::for_tests();
        std::fs::create_dir_all(&config.data_root).unwrap();
        AppState::for_tests(config).await
    }

    #[test]
    fn download_names_are_safe_on_every_platform() {
        assert_eq!(safe_file_stem("a/b\\c:d*e?f\"g<h>i|j"), "a_b_c_d_e_f_g_h_i_j");
        assert_eq!(safe_file_stem("  ..  "), "文档");
        assert_eq!(safe_file_stem("论文 标题."), "论文 标题");
    }

    #[tokio::test]
    async fn import_validates_mode_specific_formats_and_copies_the_source() {
        let state = state().await;
        let docx = state.config.data_root.join("paper.docx");
        std::fs::write(&docx, b"not really a document").unwrap();
        let error = create(
            &state,
            CreateInput {
                path: docx.clone(),
                title: None,
                mode: "pdf2zh".into(),
                translator: TranslatorChoice::Google,
            },
        )
        .await
        .unwrap_err();
        assert!(is_permanent_input_error(&error), "{error:#}");

        let mut tests_config = Config::for_tests();
        tests_config.fake_mineru_zip = Some(PathBuf::from("fixture.zip"));
        let state = AppState::for_tests(tests_config).await;
        std::fs::create_dir_all(&state.config.data_root).unwrap();
        let source = state.config.data_root.join("论文.docx");
        std::fs::write(&source, b"docx bytes").unwrap();
        create(
            &state,
            CreateInput {
                path: source.clone(),
                title: Some("  自定义标题 ".into()),
                mode: "mineru".into(),
                translator: TranslatorChoice::Llm {
                    provider_id: "missing".into(),
                    model: "m".into(),
                },
            },
        )
        .await
        .unwrap_err()
        .to_string()
        .contains("服务商不存在")
        .then_some(())
        .expect("an unknown provider is rejected");
        crate::providers::upsert(
            &state.pool,
            serde_json::from_value(serde_json::json!({
                "id": "local", "name": "本机模型", "type": "openai",
                "base_url": "http://localhost:11434/v1", "models": [{"id": "qwen3"}]
            }))
            .unwrap(),
        )
        .await
        .unwrap();
        let view = create(
            &state,
            CreateInput {
                path: source.clone(),
                title: Some("  自定义标题 ".into()),
                mode: "mineru".into(),
                translator: TranslatorChoice::Llm {
                    provider_id: "local".into(),
                    model: "qwen3".into(),
                },
            },
        )
        .await
        .unwrap();
        assert_eq!(view.document.translator_label.as_deref(), Some("本机模型 · qwen3"));
        let unlisted = translator_label(
            &state,
            &TranslatorChoice::Llm {
                provider_id: "local".into(),
                model: "llama".into(),
            },
        )
        .await
        .unwrap_err();
        assert!(unlisted.to_string().contains("模型列表中没有 llama"));
        assert_eq!(view.document.title, "自定义标题");
        assert_eq!(view.document.status, "queued");
        assert_eq!(view.document.original_filename, "论文.docx");
        let copied = std::fs::read(view.files.source.as_ref().unwrap()).unwrap();
        assert_eq!(copied, b"docx bytes");
        assert!(view.files.source.as_ref().unwrap().ends_with("source.docx"));
        let list = list(&state, ListInput::default()).await.unwrap();
        assert_eq!(list.total, 1);
        assert_eq!(list.counts.active, 1);

        let cancelled = cancel(&state, &view.document.id).await.unwrap();
        assert_eq!(cancelled.document.status, "cancelled");
        let retried = retry(&state, &view.document.id).await.unwrap();
        assert_eq!(retried.document.status, "queued");
        let renamed = rename(&state, &view.document.id, "新标题").await.unwrap();
        assert_eq!(renamed.document.title, "新标题");
        let events = events(
            &state,
            EventsInput {
                id: view.document.id.clone(),
                after_id: 0,
                limit: None,
            },
        )
        .await
        .unwrap();
        assert!(events.items.iter().any(|event| event.stage == "cancelled"));
        delete(&state, &view.document.id).await.unwrap();
        assert!(!Path::new(view.files.source.as_ref().unwrap()).exists());
        assert!(find(&state, &view.document.id).await.is_err());
        let _ = std::fs::remove_dir_all(&state.config.data_root);
    }
}
