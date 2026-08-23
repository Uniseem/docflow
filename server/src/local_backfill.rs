use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde_json::json;
use sqlx::{FromRow, PgPool};
use walkdir::WalkDir;

use crate::{config::Config, models::ProcessingEvent};

#[derive(FromRow)]
struct BackfillDocument {
    id: String,
    title: String,
    original_filename: String,
    display_filename: String,
    storage_key: String,
    source_path: String,
    source_size: i32,
    mime_type: Option<String>,
    status: String,
    local_archive_path: Option<String>,
    markdown_original: Option<String>,
    markdown_translated: Option<String>,
    markdown_normalized: Option<String>,
    content_html: Option<String>,
}

pub async fn run(pool: &PgPool, config: &Config) -> Result<()> {
    let documents = sqlx::query_as::<_, BackfillDocument>(
        "SELECT id,title,original_filename,display_filename,storage_key,source_path,source_size,mime_type,status,local_archive_path,markdown_original,markdown_translated,markdown_normalized,content_html FROM documents ORDER BY created_at",
    )
    .fetch_all(pool)
    .await?;
    for document in documents {
        if let Err(error) = backfill_document(pool, config, &document).await {
            tracing::warn!(document_id=%document.id, %error, "local archive backfill skipped");
        }
    }
    Ok(())
}

async fn backfill_document(
    pool: &PgPool,
    config: &Config,
    document: &BackfillDocument,
) -> Result<()> {
    if document.storage_key.len() < 16
        || !document
            .storage_key
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
    {
        anyhow::bail!("内部存储键格式错误");
    }
    let archive_root = config.archive_root.join(&document.storage_key);
    let source = safe_data_path(&config.data_root, &document.source_path)
        .filter(|path| path.is_file())
        .context("历史源文件不存在")?;
    let extension = Path::new(&document.original_filename)
        .extension()
        .and_then(|value| value.to_str())
        .filter(|value| {
            value
                .chars()
                .all(|character| character.is_ascii_alphanumeric())
        })
        .unwrap_or("bin")
        .to_ascii_lowercase();
    let destination_source = archive_root
        .join("source")
        .join(format!("source.{extension}"));
    copy_if_missing(&source, &destination_source).await?;

    if let Some(previous_root) = document
        .local_archive_path
        .as_deref()
        .and_then(|relative| safe_data_path(&config.data_root, relative))
    {
        let previous_images = previous_root.join("images");
        if previous_images.is_dir() {
            for path in files_below(&previous_images) {
                let name = path.file_name().context("历史图片缺少文件名")?;
                if name
                    .to_str()
                    .is_some_and(|value| value.is_ascii() && value.ends_with(".webp"))
                {
                    copy_if_missing(&path, &archive_root.join("images").join(name)).await?;
                }
            }
        }
    }

    for (path, value) in [
        (
            archive_root.join("markdown/original.md"),
            document.markdown_original.as_deref(),
        ),
        (
            archive_root.join("markdown/translated.md"),
            document.markdown_translated.as_deref(),
        ),
        (
            archive_root.join("markdown/normalized.md"),
            document.markdown_normalized.as_deref(),
        ),
        (
            archive_root.join("article/article.html"),
            document.content_html.as_deref(),
        ),
    ] {
        if let Some(value) = value {
            write_if_missing(&path, value.as_bytes()).await?;
        }
    }

    let events = sqlx::query_as::<_, ProcessingEvent>("SELECT id,document_id,stage,state,level,progress,message,detail,current,total,created_at FROM processing_events WHERE document_id=$1 ORDER BY id")
        .bind(&document.id)
        .fetch_all(pool)
        .await?;
    write_if_missing(
        &archive_root.join("metadata/events.json"),
        &serde_json::to_vec_pretty(&events)?,
    )
    .await?;
    let metadata = json!({
        "schema": "docflow-local-backfill-v2",
        "document_id": document.id,
        "title": document.title,
        "original_filename": document.original_filename,
        "display_filename": document.display_filename,
        "source_size": document.source_size,
        "mime_type": document.mime_type,
        "physical_names_are_internal": true,
    });
    write_if_missing(
        &archive_root.join("metadata/document.json"),
        &serde_json::to_vec_pretty(&metadata)?,
    )
    .await?;
    let manifest = json!({
        "schema": "docflow-local-archive-v2",
        "document_id": document.id,
        "storage_key": document.storage_key,
        "retention": "permanent-no-delete-api",
        "backfilled": true,
        "objects": files_below(&archive_root).into_iter().filter_map(|path| {
            let relative = path.strip_prefix(&archive_root).ok()?.to_string_lossy().replace('\\', "/");
            let bytes = std::fs::metadata(path).ok()?.len();
            Some(json!({"path": relative, "bytes": bytes}))
        }).collect::<Vec<_>>(),
    });
    write_if_missing(
        &archive_root.join("metadata/manifest.json"),
        &serde_json::to_vec_pretty(&manifest)?,
    )
    .await?;

    let relative_root = format!("archives/{}", document.storage_key);
    let relative_source = format!("{relative_root}/source/source.{extension}");
    let local_status = if document.status == "completed" {
        "archived"
    } else {
        "source_saved"
    };
    let archive_status = if document.status == "completed" {
        "local_archived"
    } else {
        "source_local"
    };
    sqlx::query("UPDATE documents SET source_path=$2,local_archive_path=$3,local_archive_status=$4,archive_status=$5,archive_manifest=COALESCE(archive_manifest,$6),updated_at=NOW() WHERE id=$1")
        .bind(&document.id)
        .bind(relative_source)
        .bind(relative_root)
        .bind(local_status)
        .bind(archive_status)
        .bind(manifest)
        .execute(pool)
        .await?;
    tracing::info!(document_id=%document.id, storage_key=%document.storage_key, "local archive backfill ready");
    Ok(())
}

async fn copy_if_missing(source: &Path, destination: &Path) -> Result<()> {
    if destination.is_file() || source == destination {
        return Ok(());
    }
    if let Some(parent) = destination.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let partial = destination.with_extension("backfill-partial");
    tokio::fs::copy(source, &partial).await?;
    tokio::fs::rename(partial, destination).await?;
    Ok(())
}

async fn write_if_missing(destination: &Path, bytes: &[u8]) -> Result<()> {
    if destination.is_file() {
        return Ok(());
    }
    if let Some(parent) = destination.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let partial = destination.with_extension("backfill-partial");
    tokio::fs::write(&partial, bytes).await?;
    tokio::fs::rename(partial, destination).await?;
    Ok(())
}

fn safe_data_path(data_root: &Path, relative: &str) -> Option<PathBuf> {
    let relative = Path::new(relative);
    if relative.is_absolute()
        || !relative
            .components()
            .all(|component| matches!(component, std::path::Component::Normal(_)))
    {
        return None;
    }
    Some(data_root.join(relative))
}

fn files_below(root: &Path) -> Vec<PathBuf> {
    if !root.exists() {
        return Vec::new();
    }
    let mut files = WalkDir::new(root)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| entry.into_path())
        .collect::<Vec<_>>();
    files.sort();
    files
}
