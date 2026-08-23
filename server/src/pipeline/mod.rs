mod archive;
mod markdown;
mod mineru;
mod processing;
mod translate;

use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use anyhow::{Context, Result};
use sqlx::Row;

use crate::{db::AppState, events, settings};

pub async fn process(state: Arc<AppState>, id: &str) -> Result<()> {
    let row = sqlx::query("SELECT source_path,original_filename,mime_type,translate_requested,mineru_model,mineru_task_id FROM documents WHERE id=$1")
        .bind(id).fetch_one(&state.pool).await?;
    let source_path: String = row.get("source_path");
    let source = Path::new("/data").join(&source_path);
    if !source.is_file() {
        anyhow::bail!("本地源文件不存在：{}", source.display());
    }
    let actual = tokio::fs::metadata(&source).await?.len();
    events::progress(
        &state.pool,
        id,
        "source_verified",
        4,
        "源文件完整性检查通过",
        Some(&format!(
            "本地永久源文件 {} 字节；后续重命名只更新数据库展示名，不改动物理路径",
            actual
        )),
    )
    .await?;

    let mineru_key = settings::get(
        &state.pool,
        &state.config.secret_key,
        settings::MINERU_API_KEY,
    )
    .await?
    .context("MinerU API Key 未配置")?;
    let model: String = row.get("mineru_model");
    let existing_task: Option<String> = row.get("mineru_task_id");
    let work_root = state.config.work_root.join(id);
    let mineru_zip = work_root.join("mineru-result.zip");
    let extracted = work_root.join("mineru-extracted");
    let final_root = work_root.join("final");
    tokio::fs::create_dir_all(&final_root).await?;

    let zip_url = mineru::parse(
        &state,
        id,
        &source,
        &mineru_key,
        &model,
        existing_task.as_deref(),
    )
    .await?;
    processing::download_public(&state, id, &zip_url, &mineru_zip, 1024 * 1024 * 1024).await?;
    let extraction =
        processing::extract_and_localize(&state, id, &mineru_zip, &extracted, &final_root).await?;
    sqlx::query(
        "UPDATE documents SET markdown_original=$2,image_count=$3,updated_at=NOW() WHERE id=$1",
    )
    .bind(id)
    .bind(&extraction.original_markdown)
    .bind(extraction.image_count as i32)
    .execute(&state.pool)
    .await?;

    let translate_requested: bool = row.get("translate_requested");
    let (translated_markdown, translated) = if translate_requested {
        let key = settings::get(
            &state.pool,
            &state.config.secret_key,
            settings::DEEPSEEK_API_KEY,
        )
        .await?
        .context("已选择翻译，但 DeepSeek API Key 不可用")?;
        let model = settings::get(
            &state.pool,
            &state.config.secret_key,
            settings::DEEPSEEK_MODEL,
        )
        .await?
        .unwrap_or_else(|| "deepseek-chat".into());
        (
            translate::translate(&state, id, &extraction.localized_markdown, &key, &model).await?,
            true,
        )
    } else {
        events::progress(
            &state.pool,
            id,
            "translation_skipped",
            82,
            "未选择中文翻译，跳过 DeepSeek",
            None,
        )
        .await?;
        (extraction.localized_markdown.clone(), false)
    };
    if translated {
        sqlx::query("UPDATE documents SET markdown_translated=$2,updated_at=NOW() WHERE id=$1")
            .bind(id)
            .bind(&translated_markdown)
            .execute(&state.pool)
            .await?;
    }

    let article = markdown::normalize_and_render(&state, id, &translated_markdown).await?;
    sqlx::query("UPDATE documents SET title=CASE WHEN title_custom THEN title ELSE $2 END,excerpt=$3,markdown_normalized=$4,content_html=$5,translated=$6,updated_at=NOW() WHERE id=$1")
        .bind(id).bind(&article.title).bind(&article.excerpt).bind(&article.markdown).bind(&article.html).bind(translated).execute(&state.pool).await?;
    tokio::fs::write(final_root.join("article.md"), &article.markdown).await?;
    tokio::fs::write(final_root.join("article.html"), &article.html).await?;

    archive::archive_and_publish(
        &state,
        id,
        archive::ArchiveInput {
            source: &source,
            mineru_zip: &mineru_zip,
            final_root: &final_root,
            original_markdown: &extraction.original_markdown,
            translated_markdown: translated.then_some(translated_markdown.as_str()),
            article: &article,
        },
    )
    .await?;
    Ok(())
}

pub fn document_root(work_root: &Path, id: &str) -> Result<PathBuf> {
    let parsed = uuid::Uuid::parse_str(id).context("文档 ID 不是 UUID")?;
    let root = work_root.join(parsed.to_string());
    if root.parent() != Some(work_root) {
        anyhow::bail!("工作目录越界");
    }
    Ok(root)
}
