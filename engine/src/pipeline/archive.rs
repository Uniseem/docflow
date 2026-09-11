use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use anyhow::{Context, Result};
use serde_json::{Value, json};
use sqlx::Row;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use walkdir::WalkDir;

use crate::{
    events::{self, EventInput},
    models::ProcessingEvent,
    now,
    state::AppState,
};

use super::{document_root, typeset::PdfArtifact};

pub enum ArchiveInput<'a> {
    Mineru {
        source: &'a Path,
        mineru_zip: &'a Path,
        /// Holds `images/`, `article.md`, `article.html`, `reader.html`,
        /// `original.md`, `translated.md` and the typeset PDF.
        final_root: &'a Path,
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
}

struct ArchivedOutputs {
    primary_path: &'static str,
    primary_bytes: u64,
    dual_bytes: Option<u64>,
    pages: Option<i32>,
    metadata: Value,
}

/// Archive layout, relative to `archives/<storage_key>/`:
///
/// ```text
/// source/source.<ext>            the imported file (written at import time)
/// mineru/result.zip              MinerU route only
/// markdown/original.md           MinerU route only
/// markdown/translated.md         MinerU route only
/// article/article.md|html|pdf    MinerU route: normalized article + journal PDF
/// article/reader.html            in-app reading view
/// article/images/*.webp          images referenced as images/<name>
/// pdf2zh/mono.pdf, dual.pdf      native route only
/// metadata/*.json                document, events and manifest
/// ```
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
        "开始写入文档库",
        Some(&format!(
            "存储目录只使用内部存储键 {storage_key}；显示标题只保存在数据库中"
        )),
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
        "schema": "docflow-desktop-archive-v1",
        "document_id": id,
        "storage_key": storage_key,
        "processing_mode": processing_mode,
        "created_at": chrono::Utc::now(),
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
    sqlx::query(concat!(
        "UPDATE documents SET archive_path=$2,pdf_path=$3,pdf_size=$4,dual_pdf_path=$5,dual_pdf_size=$6,\
         pages_processed=COALESCE($7,pages_processed),pages_total=COALESCE($7,pages_total),translated=1,updated_at=",
        now!(),
        " WHERE id=$1"
    ))
    .bind(id)
    .bind(&relative_root)
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
            message: "文档库清单已生成",
            detail: Some(&format!("{object_count} 个文件已登记")),
            current: Some(object_count),
            total: Some(object_count),
        },
    )
    .await?;

    let completed = sqlx::query(concat!(
        "UPDATE documents SET status='completed',stage='completed',progress=100,failure_reason=NULL,completed_at=",
        now!(),
        ",updated_at=",
        now!(),
        " WHERE id=$1 AND status='processing'"
    ))
    .bind(id)
    .execute(&state.pool)
    .await?;
    anyhow::ensure!(completed.rows_affected() == 1, "任务状态已被用户更改，未标记为完成");
    events::append(
        &state.pool,
        id,
        EventInput {
            stage: "completed",
            state: "completed",
            level: "success",
            progress: 100,
            message: if processing_mode == "pdf2zh" {
                "原版式中文 PDF 与双语对照 PDF 已完成"
            } else {
                "译文与期刊排版 PDF 已完成"
            },
            detail: Some(if processing_mode == "pdf2zh" {
                "源文件、中文 PDF、双语 PDF 与处理记录均保存在本机文档库"
            } else {
                "源文件、Markdown、PDF、图片、MinerU 结果与处理记录均保存在本机文档库"
            }),
            current: Some(100),
            total: Some(100),
        },
    )
    .await?;
    events::document_changed(id);

    for root in [&state.config.work_root, &state.config.native_work_root] {
        let work_root = document_root(root, id)?;
        if work_root.exists()
            && let Err(error) = tokio::fs::remove_dir_all(&work_root).await
        {
            tracing::warn!(document_id = id, %error, "临时工作区清理失败");
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
            source,
            mineru_zip,
            final_root,
            pdf,
        } => {
            ensure_source(source, archive_root).await?;
            copy_atomic(mineru_zip, &archive_root.join("mineru/result.zip")).await?;
            for (from, to) in [
                ("original.md", "markdown/original.md"),
                ("translated.md", "markdown/translated.md"),
                ("article.md", "article/article.md"),
                ("article.html", "article/article.html"),
                ("reader.html", "article/reader.html"),
            ] {
                copy_atomic(&final_root.join(from), &archive_root.join(to)).await?;
            }
            copy_atomic(&pdf.path, &archive_root.join("article/article.pdf")).await?;
            copy_atomic(&pdf.source_path, &archive_root.join("article/article.typ")).await?;
            events::append(
                &state.pool,
                id,
                EventInput {
                    stage: "local_archive_text",
                    state: "completed",
                    level: "success",
                    progress: 96,
                    message: "Markdown、PDF、阅读视图与 MinerU 结果已保存",
                    detail: Some("文件使用固定的 ASCII 名称；导出时按文档标题命名"),
                    current: None,
                    total: None,
                },
            )
            .await?;
            let images = files_below(&final_root.join("images"))?;
            for (index, image) in images.iter().enumerate() {
                let name = image.file_name().context("WebP 文件缺少名称")?;
                copy_atomic(image, &archive_root.join("article/images").join(name)).await?;
                if index + 1 == images.len() || (index + 1) % 20 == 0 {
                    events::append(
                        &state.pool,
                        id,
                        EventInput {
                            stage: "local_archive_image",
                            state: "completed",
                            level: "success",
                            progress: 96 + (((index + 1) * 2 / images.len().max(1)) as i32),
                            message: &format!("图片已保存 {}/{}", index + 1, images.len()),
                            detail: None,
                            current: Some((index + 1) as i64),
                            total: Some(images.len() as i64),
                        },
                    )
                    .await?;
                }
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
                        "pages": pdf.pages,
                        "layout": "A4 academic journal",
                        "renderer": "Typst",
                        "math": "MiTeX",
                    },
                }),
            })
        }
        ArchiveInput::Pdf2zh {
            source,
            final_root,
            mono_pdf,
            dual_pdf,
            mono_bytes,
            dual_bytes,
            pages,
        } => {
            ensure_source(source, archive_root).await?;
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
                    message: "原版式中文 PDF 与双语对照 PDF 已保存",
                    detail: Some("两份 PDF 均已校验；临时配置和工作文件不进入文档库，此模式不生成 Markdown"),
                    current: Some(2),
                    total: Some(2),
                },
            )
            .await?;
            Ok(outputs)
        }
    }
}

/// Imports write the source straight into the archive; this only re-checks it.
async fn ensure_source(source: &Path, archive_root: &Path) -> Result<()> {
    let source = tokio::fs::canonicalize(source)
        .await
        .context("源文件不存在")?;
    let expected = tokio::fs::canonicalize(archive_root.join("source")).await?;
    anyhow::ensure!(source.starts_with(&expected), "源文件不在文档目录中");
    Ok(())
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

pub async fn verify_pdf(path: &Path) -> Result<()> {
    let metadata = tokio::fs::metadata(path)
        .await
        .context("没有生成 PDF 输出文件")?;
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

pub fn archive_root(state: &AppState, storage_key: &str) -> Result<PathBuf> {
    archive_root_in(&state.config.archive_root, storage_key)
}

pub fn archive_root_in(archives: &Path, storage_key: &str) -> Result<PathBuf> {
    if storage_key.len() < 16 || !storage_key.chars().all(|ch| ch.is_ascii_alphanumeric()) {
        anyhow::bail!("内部存储键格式错误");
    }
    let root = archives.join(storage_key);
    if root.parent() != Some(archives) {
        anyhow::bail!("文档目录越界");
    }
    Ok(root)
}

pub fn files_below(root: &Path) -> Result<Vec<PathBuf>> {
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
    tokio::fs::copy(source, &partial)
        .await
        .with_context(|| format!("无法复制 {}", source.display()))?;
    replace_file(&partial, destination).await
}

async fn write_atomic(destination: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = destination.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let partial = destination.with_extension("partial");
    tokio::fs::write(&partial, bytes).await?;
    replace_file(&partial, destination).await
}

/// `rename` over an existing file fails on Windows when the target is open
/// in a viewer; fall back to remove-then-rename.
async fn replace_file(partial: &Path, destination: &Path) -> Result<()> {
    if tokio::fs::rename(partial, destination).await.is_ok() {
        return Ok(());
    }
    let _ = tokio::fs::remove_file(destination).await;
    tokio::fs::rename(partial, destination)
        .await
        .with_context(|| format!("无法写入 {}", destination.display()))
}

async fn load_document_metadata(state: &AppState, id: &str) -> Result<Value> {
    let row = sqlx::query("SELECT id,title,original_filename,storage_key,source_size,source_sha256,mime_type,processing_mode,translation_tier,translator,translator_label,created_at FROM documents WHERE id=$1")
        .bind(id)
        .fetch_one(&state.pool)
        .await?;
    let tier = row.get::<i64, _>("translation_tier");
    Ok(json!({
        "document_id": row.get::<String, _>("id"),
        "title": row.get::<String, _>("title"),
        "original_filename": row.get::<String, _>("original_filename"),
        "storage_key": row.get::<String, _>("storage_key"),
        "source_size": row.get::<i64, _>("source_size"),
        "source_sha256": row.get::<String, _>("source_sha256"),
        "mime_type": row.get::<Option<String>, _>("mime_type"),
        "processing_mode": row.get::<String, _>("processing_mode"),
        "translation_tier": tier,
        "translator": row
            .get::<Option<String>, _>("translator")
            .and_then(|value| serde_json::from_str::<Value>(&value).ok()),
        "translator_label": row.get::<Option<String>, _>("translator_label"),
        "created_at": row.get::<chrono::DateTime<chrono::Utc>, _>("created_at"),
    }))
}

pub async fn load_events(pool: &sqlx::SqlitePool, id: &str) -> Result<Vec<ProcessingEvent>> {
    Ok(sqlx::query_as::<_, ProcessingEvent>("SELECT id,document_id,stage,state,level,progress,message,detail,current,total,created_at FROM processing_events WHERE document_id=$1 ORDER BY id")
        .bind(id)
        .fetch_all(pool)
        .await?)
}

async fn write_current_events(state: &AppState, id: &str, archive_root: &Path) -> Result<()> {
    let current_events = load_events(&state.pool, id).await?;
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
