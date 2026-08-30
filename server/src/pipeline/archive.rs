use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use anyhow::{Context, Result};
use serde_json::{Value, json};
use sqlx::Row;
use tokio::io::AsyncReadExt;
use walkdir::WalkDir;

use crate::{
    db::AppState,
    events::{self, EventInput},
    models::ProcessingEvent,
    r2::R2Client,
    settings::R2Settings,
};

use super::{document_root, markdown::Article, pdf::PdfArtifact};

pub enum ArchiveInput<'a> {
    Mineru {
        source: &'a Path,
        mineru_zip: &'a Path,
        final_root: &'a Path,
        original_markdown: &'a str,
        translated_markdown: Option<&'a str>,
        translation_guidance: Option<&'a str>,
        article: &'a Article,
        pdf: &'a PdfArtifact,
    },
    Pdf2zh {
        source: &'a Path,
        final_root: &'a Path,
        mono_pdf: &'a Path,
        dual_pdf: &'a Path,
        mono_bytes: u64,
        dual_bytes: u64,
        pages: i32,
    },
}

impl ArchiveInput<'_> {
    fn processing_mode(&self) -> &'static str {
        match self {
            Self::Mineru { .. } => "mineru",
            Self::Pdf2zh { .. } => "pdf2zh",
        }
    }

    fn source(&self) -> &Path {
        match self {
            Self::Mineru { source, .. } | Self::Pdf2zh { source, .. } => source,
        }
    }
}

struct ArchivedOutputs {
    primary_path: &'static str,
    primary_bytes: u64,
    dual_bytes: Option<u64>,
    pages: Option<i32>,
    metadata: Value,
}

pub async fn archive_and_publish(
    state: &Arc<AppState>,
    id: &str,
    input: ArchiveInput<'_>,
) -> Result<()> {
    let row = sqlx::query("SELECT storage_key,processing_mode FROM documents WHERE id=$1")
        .bind(id)
        .fetch_one(&state.pool)
        .await?;
    let storage_key: String = row.get("storage_key");
    let processing_mode = input.processing_mode();
    let stored_mode: String = row.get("processing_mode");
    if stored_mode != processing_mode {
        anyhow::bail!("归档处理模式与任务快照不一致");
    }
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
        .source()
        .extension()
        .and_then(|value| value.to_str())
        .filter(|value| value.chars().all(|ch| ch.is_ascii_alphanumeric()))
        .unwrap_or("bin")
        .to_ascii_lowercase();
    let source_destination = archive_root
        .join("source")
        .join(format!("source.{source_extension}"));
    copy_atomic(input.source(), &source_destination).await?;
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

    let outputs = archive_outputs(state, id, &archive_root, input).await?;
    let mut document_metadata = load_document_metadata(state, id).await?;
    if let Some(values) = outputs.metadata.as_object() {
        for (key, value) in values {
            document_metadata[key] = value.clone();
        }
    }
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
        "processing_mode": processing_mode,
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
    let relative_pdf = format!("{relative_root}/{}", outputs.primary_path);
    let relative_dual_pdf = outputs
        .dual_bytes
        .map(|_| format!("{relative_root}/pdf2zh/dual.pdf"));
    sqlx::query("UPDATE documents SET local_archive_status='archived',local_archive_path=$2,archive_status='local_archived',archive_error=NULL,archive_manifest=$3,pdf_path=$4,pdf_size=$5,dual_pdf_path=$6,dual_pdf_size=$7,pages_processed=COALESCE($8,pages_processed),pages_total=COALESCE($8,pages_total),translated=CASE WHEN processing_mode='pdf2zh' THEN true ELSE translated END,updated_at=NOW() WHERE id=$1")
        .bind(id)
        .bind(&relative_root)
        .bind(&manifest)
        .bind(relative_pdf)
        .bind(outputs.primary_bytes as i64)
        .bind(relative_dual_pdf)
        .bind(outputs.dual_bytes.map(|bytes| bytes as i64))
        .bind(outputs.pages)
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
            message: if processing_mode == "pdf2zh" {
                "原版式中文 PDF 与双语对照 PDF 已完成，可下载本地永久归档"
            } else {
                "文章与期刊排版 PDF 已发布，本地永久归档可直接下载打包"
            },
            detail: Some(if processing_mode == "pdf2zh" {
                "源文件、单语 PDF、双语 PDF 与审计元数据均保留在 VPS 本地；此模式不生成 Markdown，下载与预览仍需文档访问权限"
            } else {
                "源文件、Markdown、PDF、HTML、WebP、MinerU 结果与审计元数据均保留在 VPS 本地；展示名与物理名已分离"
            }),
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
                            "仅删除本任务可再生的处理工作区；/data/archives 下的永久文件完全保留",
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

async fn archive_outputs(
    state: &AppState,
    id: &str,
    archive_root: &Path,
    input: ArchiveInput<'_>,
) -> Result<ArchivedOutputs> {
    match input {
        ArchiveInput::Mineru {
            mineru_zip,
            final_root,
            original_markdown,
            translated_markdown,
            translation_guidance,
            article,
            pdf,
            ..
        } => {
            copy_atomic(mineru_zip, &archive_root.join("mineru/result.zip")).await?;
            write_atomic(
                &archive_root.join("markdown/original.md"),
                original_markdown.as_bytes(),
            )
            .await?;
            if let Some(translated) = translated_markdown {
                write_atomic(
                    &archive_root.join("markdown/translated.md"),
                    translated.as_bytes(),
                )
                .await?;
            }
            if let Some(guidance) = translation_guidance {
                write_atomic(
                    &archive_root.join("translation/guidance.md"),
                    guidance.as_bytes(),
                )
                .await?;
            }
            write_atomic(
                &archive_root.join("markdown/normalized.md"),
                article.markdown.as_bytes(),
            )
            .await?;
            write_atomic(
                &archive_root.join("article/article.html"),
                article.html.as_bytes(),
            )
            .await?;
            copy_atomic(&pdf.path, &archive_root.join("article/article.pdf")).await?;
            copy_atomic(
                &pdf.print_html_path,
                &archive_root.join("article/print.html"),
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
                    message: "Markdown、PDF、HTML、翻译规划与 MinerU 结果已永久落盘",
                    detail: Some("期刊排版 PDF 和打印版 HTML 使用固定 ASCII 物理名；下载时由数据库标题生成中文展示文件名"),
                    current: None,
                    total: None,
                },
            )
            .await?;
            let images = files_below(&final_root.join("images"))?;
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
            Ok(ArchivedOutputs {
                primary_path: "article/article.pdf",
                primary_bytes: pdf.bytes,
                dual_bytes: None,
                pages: None,
                metadata: json!({
                    "journal_pdf": {
                        "path": "article/article.pdf",
                        "bytes": pdf.bytes,
                        "layout": "A4 academic journal",
                        "renderer": "Chromium",
                        "math": "KaTeX",
                    },
                    "pdf_variants": {
                        "journal": { "path": "article/article.pdf", "bytes": pdf.bytes },
                    },
                }),
            })
        }
        ArchiveInput::Pdf2zh {
            final_root,
            mono_pdf,
            dual_pdf,
            mono_bytes,
            dual_bytes,
            pages,
            ..
        } => {
            let outputs = write_native_outputs(
                archive_root,
                final_root,
                mono_pdf,
                dual_pdf,
                mono_bytes,
                dual_bytes,
                pages,
            )
            .await?;
            events::append(
                &state.pool,
                id,
                EventInput {
                    stage: "local_archive_pdf2zh",
                    state: "completed",
                    level: "success",
                    progress: 97,
                    message: "原版式中文 PDF 与双语对照 PDF 已永久落盘",
                    detail: Some("两份 PDF 均已校验并使用固定 ASCII 物理名；临时配置和工作文件不进入归档，此模式不生成 Markdown"),
                    current: Some(2),
                    total: Some(2),
                },
            )
            .await?;
            Ok(outputs)
        }
    }
}

async fn write_native_outputs(
    archive_root: &Path,
    final_root: &Path,
    mono_pdf: &Path,
    dual_pdf: &Path,
    mono_bytes: u64,
    dual_bytes: u64,
    pages: i32,
) -> Result<ArchivedOutputs> {
    if pages <= 0 {
        anyhow::bail!("原版式 PDF 页数无效");
    }
    let final_root = tokio::fs::canonicalize(final_root)
        .await
        .context("原版式输出目录不存在")?;
    // Validate both artifacts before copying either. Never archive arbitrary
    // files named by a subprocess, or its complete working/config directory.
    let mono = verified_native_pdf(&final_root, mono_pdf, mono_bytes).await?;
    let dual = verified_native_pdf(&final_root, dual_pdf, dual_bytes).await?;
    if mono == dual {
        anyhow::bail!("单语 PDF 与双语 PDF 必须是独立文件");
    }
    copy_atomic(&mono, &archive_root.join("pdf2zh/mono.pdf")).await?;
    copy_atomic(&dual, &archive_root.join("pdf2zh/dual.pdf")).await?;
    Ok(ArchivedOutputs {
        primary_path: "pdf2zh/mono.pdf",
        primary_bytes: mono_bytes,
        dual_bytes: Some(dual_bytes),
        pages: Some(pages),
        metadata: json!({
            "translated": true,
            "pages_processed": pages,
            "pages_total": pages,
            "native_pdf": { "engine": "pdf2zh", "layout": "native", "pages": pages },
            "pdf_variants": {
                "mono": { "path": "pdf2zh/mono.pdf", "bytes": mono_bytes },
                "dual": { "path": "pdf2zh/dual.pdf", "bytes": dual_bytes },
            },
        }),
    })
}

async fn verified_native_pdf(
    final_root: &Path,
    path: &Path,
    expected_bytes: u64,
) -> Result<PathBuf> {
    let metadata = tokio::fs::symlink_metadata(path)
        .await
        .context("原版式 PDF 输出不存在")?;
    if !metadata.file_type().is_file() || expected_bytes < 5 || metadata.len() != expected_bytes {
        anyhow::bail!("原版式 PDF 输出类型或大小校验失败");
    }
    let canonical = tokio::fs::canonicalize(path).await?;
    if !canonical.starts_with(final_root) || canonical == final_root {
        anyhow::bail!("原版式 PDF 输出越过任务目录");
    }
    let mut prefix = Vec::with_capacity(1024);
    tokio::fs::File::open(&canonical)
        .await?
        .take(1024)
        .read_to_end(&mut prefix)
        .await?;
    if !prefix.windows(5).any(|window| window == b"%PDF-") {
        anyhow::bail!("原版式输出不是 PDF 文件");
    }
    Ok(canonical)
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
    let article_key = archive_root
        .join("markdown/normalized.md")
        .is_file()
        .then(|| format!("{prefix}/markdown/normalized.md"));
    let mineru_key = archive_root
        .join("mineru/result.zip")
        .is_file()
        .then(|| format!("{prefix}/mineru/result.zip"));
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
    let row = sqlx::query("SELECT id,title,original_filename,display_filename,storage_key,source_size,mime_type,processing_mode,upload_sha256,translate_requested,translation_provider,translation_tier,translation_guidance,translated,is_public,created_at FROM documents WHERE id=$1")
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
        "processing_mode": row.get::<String, _>("processing_mode"),
        "upload_sha256": row.get::<Option<String>, _>("upload_sha256"),
        "translate_requested": row.get::<bool, _>("translate_requested"),
        "translation_provider": row.get::<String, _>("translation_provider"),
        "translation_tier": row.get::<i16, _>("translation_tier"),
        "translation_guidance_available": row.get::<Option<String>, _>("translation_guidance").is_some(),
        "translated": row.get::<bool, _>("translated"),
        "is_public": row.get::<bool, _>("is_public"),
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

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "docflow-native-archive-test-{}",
                uuid::Uuid::new_v4().simple()
            ));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    const MONO_PDF: &[u8] = b"%PDF-1.7\nmono fixture\n%%EOF\n";
    const DUAL_PDF: &[u8] = b"%PDF-1.7\ndual fixture with source\n%%EOF\n";

    #[tokio::test]
    async fn native_archive_copies_only_verified_mono_and_dual_outputs() {
        let temporary = TestDirectory::new();
        let final_root = temporary.0.join("final");
        let archive_root = temporary.0.join("archive");
        tokio::fs::create_dir(&final_root).await.unwrap();
        let mono = final_root.join("mono.pdf");
        let dual = final_root.join("dual.pdf");
        tokio::fs::write(&mono, MONO_PDF).await.unwrap();
        tokio::fs::write(&dual, DUAL_PDF).await.unwrap();
        tokio::fs::write(
            final_root.join("worker-config.json"),
            b"private runtime configuration",
        )
        .await
        .unwrap();
        tokio::fs::write(final_root.join("result.md"), b"not a declared output")
            .await
            .unwrap();
        let result = write_native_outputs(
            &archive_root,
            &final_root,
            &mono,
            &dual,
            MONO_PDF.len() as u64,
            DUAL_PDF.len() as u64,
            1,
        )
        .await
        .unwrap();
        assert_eq!(result.primary_path, "pdf2zh/mono.pdf");
        assert_eq!(result.primary_bytes, MONO_PDF.len() as u64);
        assert_eq!(result.dual_bytes, Some(DUAL_PDF.len() as u64));
        assert_eq!(result.pages, Some(1));
        assert_eq!(
            tokio::fs::read(archive_root.join("pdf2zh/mono.pdf"))
                .await
                .unwrap(),
            MONO_PDF
        );
        assert_eq!(
            tokio::fs::read(archive_root.join("pdf2zh/dual.pdf"))
                .await
                .unwrap(),
            DUAL_PDF
        );
        assert_eq!(files_below(&archive_root).unwrap().len(), 2);
        assert!(!archive_root.join("worker-config.json").exists());
        assert!(!archive_root.join("markdown").exists());
        assert!(!archive_root.join("article").exists());
        assert!(result.metadata.get("journal_pdf").is_none());
        assert_eq!(result.metadata["translated"], true);
        assert_eq!(result.metadata["native_pdf"]["pages"], 1);
    }

    #[tokio::test]
    async fn native_archive_validates_both_files_before_publishing_either() {
        let temporary = TestDirectory::new();
        let final_root = temporary.0.join("final");
        let archive_root = temporary.0.join("archive");
        tokio::fs::create_dir(&final_root).await.unwrap();
        let mono = final_root.join("mono.pdf");
        let dual = final_root.join("dual.pdf");
        tokio::fs::write(&mono, MONO_PDF).await.unwrap();
        tokio::fs::write(&dual, b"not a PDF").await.unwrap();
        assert!(
            write_native_outputs(
                &archive_root,
                &final_root,
                &mono,
                &dual,
                MONO_PDF.len() as u64,
                9,
                1,
            )
            .await
            .is_err()
        );
        assert!(!archive_root.exists());
        tokio::fs::write(&dual, DUAL_PDF).await.unwrap();
        assert!(
            write_native_outputs(
                &archive_root,
                &final_root,
                &mono,
                &dual,
                MONO_PDF.len() as u64,
                DUAL_PDF.len() as u64 + 1,
                1,
            )
            .await
            .is_err()
        );
        assert!(!archive_root.exists());
        assert!(
            write_native_outputs(
                &archive_root,
                &final_root,
                &mono,
                &mono,
                MONO_PDF.len() as u64,
                MONO_PDF.len() as u64,
                1,
            )
            .await
            .is_err()
        );
        assert!(!archive_root.exists());
        assert!(
            write_native_outputs(
                &archive_root,
                &final_root,
                &mono,
                &dual,
                MONO_PDF.len() as u64,
                DUAL_PDF.len() as u64,
                0,
            )
            .await
            .is_err()
        );
        assert!(!archive_root.exists());
    }

    #[tokio::test]
    async fn native_output_paths_cannot_escape_the_final_directory() {
        let temporary = TestDirectory::new();
        let final_root = temporary.0.join("final");
        tokio::fs::create_dir(&final_root).await.unwrap();
        let final_root = tokio::fs::canonicalize(final_root).await.unwrap();
        let outside = temporary.0.join("outside.pdf");
        tokio::fs::write(&outside, MONO_PDF).await.unwrap();
        assert!(
            verified_native_pdf(&final_root, &outside, MONO_PDF.len() as u64)
                .await
                .is_err()
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn native_output_symlinks_are_not_archived() {
        let temporary = TestDirectory::new();
        let final_root = tokio::fs::canonicalize(&temporary.0).await.unwrap();
        let target = final_root.join("real.pdf");
        let link = final_root.join("linked.pdf");
        tokio::fs::write(&target, MONO_PDF).await.unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(
            verified_native_pdf(&final_root, &link, MONO_PDF.len() as u64)
                .await
                .is_err()
        );
    }
}
