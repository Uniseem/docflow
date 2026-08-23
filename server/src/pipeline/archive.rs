use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use anyhow::{Context, Result};
use serde_json::{Value, json};
use sqlx::Row;
use walkdir::WalkDir;

use crate::{
    db::AppState,
    events::{self, EventInput},
    models::ProcessingEvent,
    r2::R2Client,
    settings::R2Settings,
};

use super::{document_root, markdown::Article};

pub struct ArchiveInput<'a> {
    pub source: &'a Path,
    pub mineru_zip: &'a Path,
    pub final_root: &'a Path,
    pub original_markdown: &'a str,
    pub translated_markdown: Option<&'a str>,
    pub article: &'a Article,
}

pub async fn archive_and_publish(
    state: &Arc<AppState>,
    id: &str,
    input: ArchiveInput<'_>,
) -> Result<()> {
    let storage_key: String = sqlx::query_scalar("SELECT storage_key FROM documents WHERE id=$1")
        .bind(id)
        .fetch_one(&state.pool)
        .await?;
    let archive_root = archive_root(state, &storage_key)?;
    let relative_root = format!("archives/{storage_key}");

    events::progress(
        &state.pool,
        id,
        "local_archive_starting",
        94,
        "开始写入 VPS 本地永久归档",
        Some(&format!(
            "物理目录只使用内部存储键 {storage_key}；展示标题与下载文件名仅保存在 PostgreSQL"
        )),
    )
    .await?;

    let source_extension = input
        .source
        .extension()
        .and_then(|value| value.to_str())
        .filter(|value| value.chars().all(|ch| ch.is_ascii_alphanumeric()))
        .unwrap_or("bin")
        .to_ascii_lowercase();
    let source_destination = archive_root
        .join("source")
        .join(format!("source.{source_extension}"));
    copy_atomic(input.source, &source_destination).await?;
    let source_bytes = tokio::fs::metadata(&source_destination).await?.len() as i64;
    events::append(
        &state.pool,
        id,
        EventInput {
            stage: "local_archive_source",
            state: "completed",
            level: "success",
            progress: 95,
            message: "源文件已进入本地永久目录",
            detail: Some(&format!(
                "物理文件 {relative_root}/source/source.{source_extension}；重命名不会改动此路径"
            )),
            current: Some(source_bytes),
            total: Some(source_bytes),
        },
    )
    .await?;

    copy_atomic(input.mineru_zip, &archive_root.join("mineru/result.zip")).await?;
    write_atomic(
        &archive_root.join("markdown/original.md"),
        input.original_markdown.as_bytes(),
    )
    .await?;
    if let Some(translated) = input.translated_markdown {
        write_atomic(
            &archive_root.join("markdown/translated.md"),
            translated.as_bytes(),
        )
        .await?;
    }
    write_atomic(
        &archive_root.join("markdown/normalized.md"),
        input.article.markdown.as_bytes(),
    )
    .await?;
    write_atomic(
        &archive_root.join("article/article.html"),
        input.article.html.as_bytes(),
    )
    .await?;
    events::append(
        &state.pool,
        id,
        EventInput {
            stage: "local_archive_text",
            state: "completed",
            level: "success",
            progress: 96,
            message: "Markdown、HTML 与 MinerU 结果已永久落盘",
            detail: Some(
                "原稿、译稿、规范化稿分别使用固定 ASCII 文件名，打包时通过元数据还原展示名称",
            ),
            current: None,
            total: None,
        },
    )
    .await?;

    let images = files_below(&input.final_root.join("images"))?;
    for (index, image) in images.iter().enumerate() {
        let name = image.file_name().context("WebP 文件缺少名称")?;
        copy_atomic(image, &archive_root.join("images").join(name)).await?;
        events::append(
            &state.pool,
            id,
            EventInput {
                stage: "local_archive_image",
                state: "completed",
                level: "success",
                progress: 96 + (((index + 1) * 2 / images.len().max(1)) as i32),
                message: &format!("本地图片归档 {}/{}", index + 1, images.len()),
                detail: Some(&format!(
                    "{} 已作为 WebP 写入永久目录；原图片格式不进入归档",
                    name.to_string_lossy()
                )),
                current: Some((index + 1) as i64),
                total: Some(images.len() as i64),
            },
        )
        .await?;
    }

    let document_metadata = load_document_metadata(state, id).await?;
    write_atomic(
        &archive_root.join("metadata/document.json"),
        &serde_json::to_vec_pretty(&document_metadata)?,
    )
    .await?;
    write_current_events(state, id, &archive_root).await?;

    let objects = local_objects(&archive_root)?;
    let manifest = json!({
        "schema": "docflow-local-archive-v2",
        "document_id": id,
        "storage_key": storage_key,
        "created_at": chrono::Utc::now(),
        "retention": "permanent-no-delete-api",
        "naming": "physical-ascii-database-display-name",
        "objects": objects,
    });
    write_atomic(
        &archive_root.join("metadata/manifest.json"),
        &serde_json::to_vec_pretty(&manifest)?,
    )
    .await?;
    sqlx::query("UPDATE documents SET local_archive_status='archived',local_archive_path=$2,archive_status='local_archived',archive_error=NULL,archive_manifest=$3,updated_at=NOW() WHERE id=$1")
        .bind(id)
        .bind(&relative_root)
        .bind(&manifest)
        .execute(&state.pool)
        .await?;
    let object_count = manifest["objects"].as_array().map_or(0, Vec::len) as i64;
    events::append(
        &state.pool,
        id,
        EventInput {
            stage: "local_archive_verified",
            state: "completed",
            level: "success",
            progress: 98,
            message: "本地永久归档清单已生成",
            detail: Some(&format!(
                "{object_count} 个文件已登记；本地存储是主副本，R2 仅作为可选镜像"
            )),
            current: Some(object_count),
            total: Some(object_count),
        },
    )
    .await?;

    let r2_result = match R2Settings::load(&state.pool, &state.config.secret_key).await? {
        Some(config) => mirror_r2(state, id, &archive_root, &source_extension, config).await,
        None => {
            sqlx::query(
                "UPDATE documents SET r2_mirror_status='disabled',r2_mirror_error=NULL WHERE id=$1",
            )
            .bind(id)
            .execute(&state.pool)
            .await?;
            events::append(
                &state.pool,
                id,
                EventInput {
                    stage: "r2_mirror_skipped",
                    state: "completed",
                    level: "info",
                    progress: 99,
                    message: "未配置 R2，按本地永久归档模式发布",
                    detail: Some("这不会阻止任务完成；以后配置 R2 也不会改变本地文件的主副本地位"),
                    current: None,
                    total: None,
                },
            )
            .await?;
            Ok(())
        }
    };
    if let Err(error) = r2_result {
        let detail = format!("{error:#}");
        sqlx::query(
            "UPDATE documents SET r2_mirror_status='failed',r2_mirror_error=$2 WHERE id=$1",
        )
        .bind(id)
        .bind(detail.chars().take(2000).collect::<String>())
        .execute(&state.pool)
        .await?;
        events::append(
            &state.pool,
            id,
            EventInput {
                stage: "r2_mirror_failed",
                state: "warning",
                level: "warning",
                progress: 99,
                message: "R2 可选镜像未完成，本地归档不受影响",
                detail: Some(&detail),
                current: None,
                total: None,
            },
        )
        .await?;
    }

    sqlx::query("UPDATE documents SET status='completed',stage='completed',progress=100,failure_reason=NULL,completed_at=NOW(),updated_at=NOW(),queue_locked_at=NULL,queue_locked_by=NULL WHERE id=$1")
        .bind(id)
        .execute(&state.pool)
        .await?;
    events::append(
        &state.pool,
        id,
        EventInput {
            stage: "completed",
            state: "completed",
            level: "success",
            progress: 100,
            message: "文章已发布，本地永久归档可直接下载打包",
            detail: Some(
                "源文件、Markdown、HTML、WebP、MinerU 结果与审计元数据均保留在 VPS 本地；展示名与物理名已分离",
            ),
            current: Some(100),
            total: Some(100),
        },
    )
    .await?;

    let work_root = document_root(&state.config.work_root, id)?;
    if work_root.exists() {
        match tokio::fs::remove_dir_all(&work_root).await {
            Ok(()) => {
                events::append(
                    &state.pool,
                    id,
                    EventInput {
                        stage: "work_cleanup",
                        state: "completed",
                        level: "success",
                        progress: 100,
                        message: "可再生工作区已清理",
                        detail: Some(
                            "仅删除 MinerU 解压等临时中间目录；/data/archives 下的永久文件完全保留",
                        ),
                        current: None,
                        total: None,
                    },
                )
                .await?;
            }
            Err(error) => {
                events::append(
                    &state.pool,
                    id,
                    EventInput {
                        stage: "work_cleanup_warning",
                        state: "warning",
                        level: "warning",
                        progress: 100,
                        message: "永久归档已完成，但临时工作区清理失败",
                        detail: Some(&error.to_string()),
                        current: None,
                        total: None,
                    },
                )
                .await?;
            }
        }
    }
    write_current_events(state, id, &archive_root).await?;
    Ok(())
}

async fn mirror_r2(
    state: &AppState,
    id: &str,
    archive_root: &Path,
    source_extension: &str,
    config: R2Settings,
) -> Result<()> {
    let r2 = R2Client::new(config).await;
    r2.validate().await?;
    let prefix = format!("documents/{id}");
    let files = files_below(archive_root)?;
    sqlx::query(
        "UPDATE documents SET r2_mirror_status='mirroring',r2_mirror_error=NULL WHERE id=$1",
    )
    .bind(id)
    .execute(&state.pool)
    .await?;
    events::progress(
        &state.pool,
        id,
        "r2_mirror_starting",
        99,
        "开始写入可选 R2 镜像",
        Some(&format!("本地归档已经完成；将镜像 {} 个对象", files.len())),
    )
    .await?;
    for (index, path) in files.iter().enumerate() {
        let relative = path
            .strip_prefix(archive_root)?
            .to_string_lossy()
            .replace('\\', "/");
        let key = format!("{prefix}/{relative}");
        let mime = mime_guess::from_path(path)
            .first_or_octet_stream()
            .to_string();
        r2.put_file(&key, path, &mime).await?;
        events::append(
            &state.pool,
            id,
            EventInput {
                stage: "r2_mirror_object",
                state: "completed",
                level: "success",
                progress: 99,
                message: &format!("R2 镜像 {}/{}", index + 1, files.len()),
                detail: Some(&format!("{relative} 已上传并通过 HEAD 校验")),
                current: Some((index + 1) as i64),
                total: Some(files.len() as i64),
            },
        )
        .await?;
    }
    let source_key = format!("{prefix}/source/source.{source_extension}");
    let article_key = format!("{prefix}/markdown/normalized.md");
    let mineru_key = format!("{prefix}/mineru/result.zip");
    sqlx::query("UPDATE documents SET r2_mirror_status='archived',r2_mirror_error=NULL,r2_prefix=$2,source_r2_key=$3,article_r2_key=$4,mineru_r2_key=$5 WHERE id=$1")
        .bind(id)
        .bind(&prefix)
        .bind(&source_key)
        .bind(&article_key)
        .bind(&mineru_key)
        .execute(&state.pool)
        .await?;
    events::append(
        &state.pool,
        id,
        EventInput {
            stage: "r2_mirror_verified",
            state: "completed",
            level: "success",
            progress: 99,
            message: "R2 可选镜像全部校验完成",
            detail: Some(&format!("对象前缀 {prefix}；本地永久副本仍完整保留")),
            current: Some(files.len() as i64),
            total: Some(files.len() as i64),
        },
    )
    .await?;
    Ok(())
}

fn archive_root(state: &AppState, storage_key: &str) -> Result<PathBuf> {
    if storage_key.len() < 16 || !storage_key.chars().all(|ch| ch.is_ascii_alphanumeric()) {
        anyhow::bail!("内部存储键格式错误");
    }
    let root = state.config.archive_root.join(storage_key);
    if root.parent() != Some(state.config.archive_root.as_path()) {
        anyhow::bail!("永久归档目录越界");
    }
    Ok(root)
}

fn files_below(root: &Path) -> Result<Vec<PathBuf>> {
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut files = WalkDir::new(root)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| entry.into_path())
        .collect::<Vec<_>>();
    files.sort();
    Ok(files)
}

fn local_objects(root: &Path) -> Result<Vec<Value>> {
    files_below(root)?
        .into_iter()
        .map(|path| {
            let relative = path
                .strip_prefix(root)?
                .to_string_lossy()
                .replace('\\', "/");
            Ok(json!({"path": relative, "bytes": std::fs::metadata(path)?.len()}))
        })
        .collect()
}

async fn copy_atomic(source: &Path, destination: &Path) -> Result<()> {
    if let Some(parent) = destination.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    if source == destination {
        return Ok(());
    }
    let partial = destination.with_extension("partial");
    tokio::fs::copy(source, &partial).await?;
    tokio::fs::rename(partial, destination).await?;
    Ok(())
}

async fn write_atomic(destination: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = destination.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let partial = destination.with_extension("partial");
    tokio::fs::write(&partial, bytes).await?;
    tokio::fs::rename(partial, destination).await?;
    Ok(())
}

async fn load_document_metadata(state: &AppState, id: &str) -> Result<Value> {
    let row = sqlx::query("SELECT id,title,original_filename,display_filename,storage_key,source_size,mime_type,upload_sha256,translate_requested,translated,created_at FROM documents WHERE id=$1")
        .bind(id)
        .fetch_one(&state.pool)
        .await?;
    Ok(json!({
        "document_id": row.get::<String, _>("id"),
        "title": row.get::<String, _>("title"),
        "original_filename": row.get::<String, _>("original_filename"),
        "display_filename": row.get::<String, _>("display_filename"),
        "storage_key": row.get::<String, _>("storage_key"),
        "source_size": row.get::<i32, _>("source_size"),
        "mime_type": row.get::<Option<String>, _>("mime_type"),
        "upload_sha256": row.get::<Option<String>, _>("upload_sha256"),
        "translate_requested": row.get::<bool, _>("translate_requested"),
        "translated": row.get::<bool, _>("translated"),
        "created_at": row.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
        "physical_names_are_internal": true,
    }))
}

async fn write_current_events(state: &AppState, id: &str, archive_root: &Path) -> Result<()> {
    let current_events = sqlx::query_as::<_, ProcessingEvent>("SELECT id,document_id,stage,state,level,progress,message,detail,current,total,created_at FROM processing_events WHERE document_id=$1 ORDER BY id")
        .bind(id)
        .fetch_all(&state.pool)
        .await?;
    write_atomic(
        &archive_root.join("metadata/events.json"),
        &serde_json::to_vec_pretty(&current_events)?,
    )
    .await
}
