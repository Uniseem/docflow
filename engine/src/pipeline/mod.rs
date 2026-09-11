mod archive;
pub(crate) mod markdown;
mod mineru;
mod pdf2zh;
mod processing;
pub(crate) mod translate;
pub(crate) mod typeset;

use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use anyhow::{Context, Result};
use sqlx::Row;

use crate::{
    events, providers, reader,
    secrets::{self, MINERU},
    settings::TranslatorChoice,
    state::AppState,
    translation_pool::LlmTarget,
};

pub use archive::{archive_root_in, files_below, load_events, verify_pdf};

/// An error that retrying cannot fix (missing credentials, a scanned PDF for
/// the native route, …). The worker fails such jobs immediately instead of
/// spending the automatic retries.
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct PermanentFailure(pub String);

pub fn permanent(message: impl Into<String>) -> anyhow::Error {
    PermanentFailure(message.into()).into()
}

pub fn is_permanent(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| cause.is::<PermanentFailure>())
}

pub async fn process(state: Arc<AppState>, id: &str) -> Result<()> {
    let row = sqlx::query("SELECT source_path,translation_tier,translator,mineru_model,mineru_task_id,processing_mode FROM documents WHERE id=$1")
        .bind(id).fetch_one(&state.pool).await?;
    let source_path: String = row.get("source_path");
    let source = state.config.data_root.join(&source_path);
    if !source.is_file() {
        return Err(permanent(format!(
            "源文件不存在：{}（可能已被移动或删除）",
            source.display()
        )));
    }
    let actual = tokio::fs::metadata(&source).await?.len();
    events::progress(
        &state.pool,
        id,
        "source_verified",
        4,
        "源文件完整性检查通过",
        Some(&format!(
            "文档库中的源文件 {actual} 字节；重命名只修改显示名称，不改动存储路径"
        )),
    )
    .await?;

    let tier: i64 = row.get("translation_tier");
    let choice: Option<String> = row.get("translator");
    let translator = translator_for(&state, choice.as_deref(), tier).await?;
    let processing_mode: String = row.get("processing_mode");
    if processing_mode == "pdf2zh" {
        return pdf2zh::process(&state, id, &source, translator).await;
    }
    anyhow::ensure!(processing_mode == "mineru", "任务处理方式无效");

    let work_root = document_root(&state.config.work_root, id)?;
    let mineru_zip = work_root.join("mineru-result.zip");
    let extracted = work_root.join("mineru-extracted");
    let final_root = work_root.join("final");
    // A retry must never mix images or articles from a previous attempt.
    for stale in [&extracted, &final_root] {
        if stale.exists() {
            tokio::fs::remove_dir_all(stale).await?;
        }
    }
    tokio::fs::create_dir_all(&final_root).await?;

    if let Some(fixture) = state.config.fake_mineru_zip.clone() {
        events::progress(
            &state.pool,
            id,
            "mineru_done",
            52,
            "使用本地 MinerU 测试结果",
            Some("DOCFLOW_FAKE_MINERU_ZIP 已设置；不会上传文件或访问 MinerU"),
        )
        .await?;
        tokio::fs::copy(&fixture, &mineru_zip)
            .await
            .with_context(|| format!("无法读取测试结果 {}", fixture.display()))?;
    } else {
        let mineru_key = state.secrets.get(MINERU).ok_or_else(|| {
            permanent("尚未配置 MinerU API Key，请在设置中填写后重试")
        })?;
        let model: String = row.get("mineru_model");
        let existing_task: Option<String> = row.get("mineru_task_id");
        let zip_url = mineru::parse(
            &state,
            id,
            &source,
            &mineru_key,
            &model,
            existing_task.as_deref(),
        )
        .await?;
        processing::download_public(&state, id, &zip_url, &mineru_zip, 1024 * 1024 * 1024)
            .await?;
    }
    let extraction =
        processing::extract_and_localize(&state, id, &mineru_zip, &extracted, &final_root).await?;
    tokio::fs::write(final_root.join("original.md"), &extraction.original_markdown).await?;
    sqlx::query("UPDATE documents SET image_count=$2 WHERE id=$1")
        .bind(id)
        .bind(extraction.image_count as i64)
        .execute(&state.pool)
        .await?;

    let output = translate::translate(&state, id, &extraction.localized_markdown, &translator).await?;
    tokio::fs::write(final_root.join("translated.md"), &output.markdown).await?;

    let current_title: String = sqlx::query_scalar("SELECT title FROM documents WHERE id=$1")
        .bind(id)
        .fetch_one(&state.pool)
        .await?;
    let article =
        markdown::normalize_and_render(&state, id, &output.markdown, &current_title).await?;
    sqlx::query("UPDATE documents SET title=CASE WHEN title_custom THEN title ELSE $2 END,excerpt=$3,translated=1 WHERE id=$1")
        .bind(id)
        .bind(&article.title)
        .bind(&article.excerpt)
        .execute(&state.pool)
        .await?;
    events::document_changed(id);
    tokio::fs::write(final_root.join("article.md"), &article.markdown).await?;
    tokio::fs::write(final_root.join("article.html"), &article.html).await?;
    reader::write_reader_html(&final_root, &article).await?;
    let pdf = typeset::render_journal_pdf(&state, id, &article, &final_root).await?;

    archive::archive_and_publish(
        &state,
        id,
        archive::ArchiveInput::Mineru {
            source: &source,
            mineru_zip: &mineru_zip,
            final_root: &final_root,
            pdf: &pdf,
        },
    )
    .await?;
    Ok(())
}

/// The document's translation service with its current configuration and
/// keys. Missing providers or keys stop the job with a clear message.
async fn translator_for(state: &AppState, choice: Option<&str>, tier: i64) -> Result<translate::Translator> {
    let choice = match choice {
        Some(json) => serde_json::from_str::<TranslatorChoice>(json).context("任务的翻译服务设置无效")?,
        // Documents from before providers existed: tier 1 was Google.
        None if tier <= 1 => TranslatorChoice::Google,
        None => return Err(permanent("这是旧版本创建的任务，请删除后重新选择翻译服务提交")),
    };
    let (provider_id, model) = match choice {
        TranslatorChoice::Google => return Ok(translate::Translator::Google),
        TranslatorChoice::Llm { provider_id, model } => (provider_id, model),
    };
    let provider = providers::load(&state.pool)
        .await?
        .into_iter()
        .find(|provider| provider.id == provider_id)
        .ok_or_else(|| permanent("所选的大模型服务商已被删除，请在设置中重新添加，或换一个翻译服务后重新处理"))?;
    if !provider.enabled {
        return Err(permanent(format!("大模型服务商“{}”已停用，请在设置中启用后重新处理", provider.name)));
    }
    let keys = state.secrets.keys(&secrets::provider_secret(&provider.id));
    if keys.is_empty() && !provider.key_optional() && !state.config.fake_providers {
        return Err(permanent(format!("尚未填写“{}”的 API Key，请在设置中填写后重新处理", provider.name)));
    }
    Ok(translate::Translator::Llm(Arc::new(LlmTarget {
        provider_id: provider.id.clone(),
        provider_name: provider.name.clone(),
        endpoint: provider.endpoint(),
        model,
        keys,
        concurrency: provider.concurrency,
    })))
}

pub fn document_root(work_root: &Path, id: &str) -> Result<PathBuf> {
    let parsed = uuid::Uuid::parse_str(id).context("文档 ID 不是 UUID")?;
    let root = work_root.join(parsed.to_string());
    if root.parent() != Some(work_root) {
        anyhow::bail!("工作目录越界");
    }
    Ok(root)
}
