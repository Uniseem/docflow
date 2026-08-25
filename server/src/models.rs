use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct Document {
    pub id: String,
    pub title: String,
    pub original_filename: String,
    pub display_filename: String,
    #[serde(skip_serializing)]
    pub storage_key: String,
    #[serde(skip_serializing)]
    pub title_custom: bool,
    #[serde(skip_serializing)]
    pub source_path: String,
    pub source_size: i32,
    pub mime_type: Option<String>,
    pub status: String,
    pub stage: String,
    pub progress: i32,
    pub failure_reason: Option<String>,
    pub translate_requested: bool,
    pub translation_provider: String,
    pub translation_tier: i16,
    #[serde(skip_serializing)]
    pub translation_guidance: Option<String>,
    pub translated: bool,
    pub is_public: bool,
    #[serde(skip_serializing)]
    pub access_token_hash: Option<String>,
    pub mineru_task_id: Option<String>,
    pub mineru_model: String,
    pub pages_processed: Option<i32>,
    pub pages_total: Option<i32>,
    pub image_count: i32,
    #[serde(skip_serializing)]
    pub content_html: Option<String>,
    pub excerpt: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub completed_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing)]
    pub markdown_original: Option<String>,
    #[serde(skip_serializing)]
    pub markdown_translated: Option<String>,
    #[serde(skip_serializing)]
    pub markdown_normalized: Option<String>,
    pub upload_sha256: Option<String>,
    pub queue_attempts: i32,
    pub archive_status: String,
    pub archive_error: Option<String>,
    pub local_archive_status: String,
    #[serde(skip_serializing)]
    pub local_archive_path: Option<String>,
    pub r2_mirror_status: String,
    pub r2_mirror_error: Option<String>,
    #[serde(skip_serializing)]
    pub r2_prefix: Option<String>,
    #[serde(skip_serializing)]
    pub source_r2_key: Option<String>,
    pub api_version: String,
}

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct ProcessingEvent {
    pub id: i64,
    pub document_id: String,
    pub stage: String,
    pub state: String,
    pub level: String,
    pub progress: i32,
    pub message: String,
    pub detail: Option<String>,
    pub current: Option<i64>,
    pub total: Option<i64>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Deserialize)]
pub struct RegisterRequest {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Serialize)]
pub struct TokenResponse {
    pub token: String,
}

#[derive(Debug, Serialize)]
pub struct DocumentList {
    pub items: Vec<Document>,
    pub total: i64,
    pub page: i64,
    pub page_size: i64,
}

#[derive(Debug, Serialize)]
pub struct EventList {
    pub items: Vec<ProcessingEvent>,
    pub total: i64,
    pub next_after_id: i64,
    pub has_more: bool,
}

#[derive(Debug, Serialize)]
pub struct PublicConfig {
    pub app_name: String,
    pub mineru_configured: bool,
    pub translation_available: bool,
    pub default_translate: bool,
    pub translation_provider: String,
    pub translation_tier: i16,
    pub deepseek_configured: bool,
    pub documents_public_by_default: bool,
    pub r2_configured: bool,
    pub accepting_uploads: bool,
    pub max_upload_mb: u64,
    pub accepted_extensions: Vec<&'static str>,
    pub api_version: &'static str,
    pub api_docs: &'static str,
}
