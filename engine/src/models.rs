use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::FromRow;

pub const DOCUMENT_COLUMNS: &str = "id,title,original_filename,storage_key,source_path,source_size,source_sha256,mime_type,processing_mode,translation_tier,translator_label,mineru_model,status,stage,progress,failure_reason,queue_attempts,pages_processed,pages_total,image_count,excerpt,translated,archive_path,pdf_path,pdf_size,dual_pdf_path,dual_pdf_size,created_at,updated_at,started_at,completed_at";

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct Document {
    pub id: String,
    pub title: String,
    pub original_filename: String,
    #[serde(skip_serializing)]
    pub storage_key: String,
    #[serde(skip_serializing)]
    pub source_path: String,
    pub source_size: i64,
    pub source_sha256: String,
    pub mime_type: Option<String>,
    pub processing_mode: String,
    pub translation_tier: i64,
    /// "Google 翻译（免费）" or "服务商 · 模型"; absent for older documents.
    pub translator_label: Option<String>,
    pub mineru_model: String,
    pub status: String,
    pub stage: String,
    pub progress: i64,
    pub failure_reason: Option<String>,
    pub queue_attempts: i64,
    pub pages_processed: Option<i64>,
    pub pages_total: Option<i64>,
    pub image_count: i64,
    pub excerpt: Option<String>,
    pub translated: bool,
    #[serde(skip_serializing)]
    pub archive_path: Option<String>,
    #[serde(skip_serializing)]
    pub pdf_path: Option<String>,
    pub pdf_size: Option<i64>,
    #[serde(skip_serializing)]
    pub dual_pdf_path: Option<String>,
    pub dual_pdf_size: Option<i64>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub started_at: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
}

/// Absolute paths of the files the host may open, preview or copy. Only
/// files that currently exist are listed.
#[derive(Debug, Clone, Default, Serialize)]
pub struct DocumentFiles {
    pub source: Option<String>,
    pub archive_dir: Option<String>,
    pub journal_pdf: Option<String>,
    pub mono_pdf: Option<String>,
    pub dual_pdf: Option<String>,
    pub markdown: Option<String>,
    pub markdown_original: Option<String>,
    pub markdown_translated: Option<String>,
    pub reader_html: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DocumentView {
    #[serde(flatten)]
    pub document: Document,
    pub files: DocumentFiles,
}

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct ProcessingEvent {
    pub id: i64,
    pub document_id: String,
    pub stage: String,
    pub state: String,
    pub level: String,
    pub progress: i64,
    pub message: String,
    pub detail: Option<String>,
    pub current: Option<i64>,
    pub total: Option<i64>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct DocumentList {
    pub items: Vec<Document>,
    pub total: i64,
    pub counts: StatusCounts,
}

#[derive(Debug, Default, Serialize)]
pub struct StatusCounts {
    pub all: i64,
    pub active: i64,
    pub completed: i64,
    pub failed: i64,
}

#[derive(Debug, Serialize)]
pub struct EventList {
    pub items: Vec<ProcessingEvent>,
    pub total: i64,
    pub next_after_id: i64,
    pub has_more: bool,
}
