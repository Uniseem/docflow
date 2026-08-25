use std::{
    convert::Infallible,
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use anyhow::Context;
use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, Multipart, Path as AxumPath, Query, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    middleware,
    response::{
        Html, IntoResponse, Response, Sse,
        sse::{Event, KeepAlive},
    },
    routing::{get, patch, post, put},
};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::Row;
use tokio::{fs, io::AsyncWriteExt};
use tokio_util::io::ReaderStream;
use tower_http::{
    cors::{Any, CorsLayer},
    trace::TraceLayer,
};
use uuid::Uuid;

use crate::{
    db::AppState,
    events::{self, EventInput},
    models::{
        Document, DocumentList, EventList, LoginRequest, ProcessingEvent, PublicConfig,
        RegisterRequest, TokenResponse,
    },
    r2::R2Client,
    security,
    settings::{self, AdminSettingsResponse, R2Settings},
};

pub const ACCEPTED_EXTENSIONS: &[&str] = &[
    ".pdf", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", ".png", ".jpg", ".jpeg", ".jp2",
    ".webp", ".gif", ".bmp", ".html", ".htm",
];

#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    pub fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, message)
    }
    pub fn unauthorized(message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, message)
    }
    fn not_found(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, message)
    }
    fn internal(error: impl std::fmt::Display) -> Self {
        tracing::error!(%error, "api error");
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "服务器处理请求失败")
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({"detail": self.message}))).into_response()
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(value: sqlx::Error) -> Self {
        Self::internal(value)
    }
}
impl From<anyhow::Error> for ApiError {
    fn from(value: anyhow::Error) -> Self {
        Self::internal(value)
    }
}

pub async fn serve(state: Arc<AppState>) -> anyhow::Result<()> {
    let admin = Router::new()
        .route("/session", post(admin_session))
        .route("/settings", get(admin_settings))
        .route("/settings/mineru", put(save_mineru))
        .route("/settings/deepseek", put(save_deepseek))
        .route("/settings/translation", put(save_translation_provider))
        .route("/settings/r2", put(save_r2))
        .route("/documents", get(admin_list_documents))
        .route("/documents/{id}/names", patch(update_document_names))
        .route(
            "/documents/{id}/visibility",
            patch(update_document_visibility),
        )
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            security::require_admin,
        ));

    let common = Router::new()
        .route("/health", get(health))
        .route("/config/public", get(public_config))
        .route("/admin/status", get(admin_status))
        .route("/admin/register", post(admin_register))
        .route("/admin/login", post(admin_login))
        .route("/admin/logout", post(admin_logout))
        .nest("/admin", admin)
        .route("/documents", get(list_documents).post(create_document))
        .route("/documents/{id}", get(get_document))
        .route("/documents/{id}/events", get(list_events))
        .route("/documents/{id}/events/stream", get(stream_events))
        .route("/documents/{id}/download", get(download_source))
        .route("/documents/{id}/bundle", get(download_bundle))
        .route("/documents/{id}/markdown", get(get_markdown))
        .route("/documents/{id}/assets/{name}", get(get_asset));

    let v1 = Router::new()
        .route("/jobs", get(list_documents).post(create_document))
        .route("/jobs/{id}", get(get_document))
        .route("/jobs/{id}/events", get(list_events))
        .route("/jobs/{id}/events/stream", get(stream_events))
        .route("/jobs/{id}/source", get(download_source))
        .route("/jobs/{id}/bundle", get(download_bundle))
        .route("/jobs/{id}/markdown", get(get_markdown))
        .route("/jobs/{id}/assets/{name}", get(get_asset));

    let app = Router::new()
        .nest("/api", common)
        .nest("/api/v1", v1)
        .route("/api/openapi.json", get(openapi))
        .route("/api/docs", get(api_docs))
        .layer(DefaultBodyLimit::max(
            state.config.max_upload_bytes as usize + 1024 * 1024,
        ))
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any)
                .expose_headers([header::CONTENT_DISPOSITION]),
        )
        .layer(TraceLayer::new_for_http())
        .with_state(state.clone());

    let listener = tokio::net::TcpListener::bind("0.0.0.0:8000").await?;
    tracing::info!(address=%listener.local_addr()?, "Rust API listening");
    axum::serve(listener, app).await?;
    Ok(())
}

async fn health() -> Json<serde_json::Value> {
    Json(json!({"status":"ok","runtime":"rust","version":"2.0.0"}))
}

async fn public_config(State(state): State<Arc<AppState>>) -> Result<Json<PublicConfig>, ApiError> {
    let secret = &state.config.secret_key;
    let mineru = settings::configured(&state.pool, secret, settings::MINERU_API_KEY).await;
    let deepseek = settings::configured(&state.pool, secret, settings::DEEPSEEK_API_KEY).await
        && settings::configured(&state.pool, secret, settings::DEEPSEEK_MODEL).await;
    let r2 = R2Settings::load(&state.pool, secret).await?.is_some();
    let configured_tier = settings::translation_tier(&state.pool, secret).await?;
    let translation_tier = if configured_tier > 1 && !deepseek {
        1
    } else {
        configured_tier
    };
    Ok(Json(PublicConfig {
        app_name: state.config.app_name.clone(),
        mineru_configured: mineru,
        translation_available: true,
        default_translate: true,
        translation_provider: settings::translation_provider_for_tier(translation_tier).into(),
        translation_tier,
        deepseek_configured: deepseek,
        documents_public_by_default: false,
        r2_configured: r2,
        accepting_uploads: mineru,
        max_upload_mb: state.config.max_upload_mb(),
        accepted_extensions: ACCEPTED_EXTENSIONS.to_vec(),
        api_version: "v1",
        api_docs: "/api/docs",
    }))
}

async fn admin_status(
    State(state): State<Arc<AppState>>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let initialized: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM admin_users WHERE id=1)")
            .fetch_one(&state.pool)
            .await?;
    Ok(Json(json!({"initialized": initialized})))
}

fn clean_username(value: &str) -> Result<String, ApiError> {
    let value = value.trim();
    if value.chars().count() < 2
        || value.len() > 128
        || value
            .chars()
            .any(|ch| ch == '\0' || ch == '\r' || ch == '\n' || ch == '\t')
    {
        return Err(ApiError::bad_request("管理员名称格式不正确"));
    }
    Ok(value.to_string())
}

fn admin_cookie(token: &str, max_age: i64) -> Result<HeaderValue, ApiError> {
    HeaderValue::from_str(&format!(
        "docflow_admin={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}"
    ))
    .map_err(ApiError::internal)
}

async fn admin_register(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<RegisterRequest>,
) -> Result<Response, ApiError> {
    if payload.password.chars().count() < 10 {
        return Err(ApiError::bad_request("管理员密码至少需要 10 个字符"));
    }
    let username = clean_username(&payload.username)?;
    let hash = security::hash_password(&payload.password).map_err(ApiError::internal)?;
    let inserted = sqlx::query("INSERT INTO admin_users(id,username,password_hash,created_at) VALUES(1,$1,$2,NOW()) ON CONFLICT DO NOTHING")
        .bind(&username).bind(hash).execute(&state.pool).await?;
    if inserted.rows_affected() != 1 {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "管理员已经注册，请直接登录",
        ));
    }
    let token =
        security::create_token(&state.config.secret_key, &username).map_err(ApiError::internal)?;
    let cookie = admin_cookie(&token, 12 * 60 * 60)?;
    Ok((
        StatusCode::CREATED,
        [(header::SET_COOKIE, cookie)],
        Json(TokenResponse { token }),
    )
        .into_response())
}

async fn admin_login(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<LoginRequest>,
) -> Result<Response, ApiError> {
    let username = clean_username(&payload.username)?;
    let row = sqlx::query("SELECT username,password_hash FROM admin_users WHERE id=1")
        .fetch_optional(&state.pool)
        .await?;
    let Some(row) = row else {
        return Err(ApiError::new(StatusCode::CONFLICT, "系统尚未注册管理员"));
    };
    let stored: String = row.try_get("username")?;
    let hash: String = row.try_get("password_hash")?;
    if stored.as_bytes() != username.as_bytes()
        || !security::verify_password(&payload.password, &hash)
    {
        return Err(ApiError::unauthorized("管理员名称或密码错误"));
    }
    let token =
        security::create_token(&state.config.secret_key, &stored).map_err(ApiError::internal)?;
    let cookie = admin_cookie(&token, 12 * 60 * 60)?;
    Ok((
        [(header::SET_COOKIE, cookie)],
        Json(TokenResponse { token }),
    )
        .into_response())
}

async fn admin_session(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let token = security::admin_token(&headers)
        .filter(|value| security::validate_token(&state.config.secret_key, value))
        .ok_or_else(|| ApiError::unauthorized("需要有效的管理员登录"))?;
    Ok((
        StatusCode::NO_CONTENT,
        [(header::SET_COOKIE, admin_cookie(&token, 12 * 60 * 60)?)],
    )
        .into_response())
}

async fn admin_logout() -> Result<Response, ApiError> {
    Ok((
        StatusCode::NO_CONTENT,
        [(header::SET_COOKIE, admin_cookie("", 0)?)],
    )
        .into_response())
}

async fn load_admin_settings(state: &AppState) -> Result<AdminSettingsResponse, ApiError> {
    let pool = &state.pool;
    let secret = &state.config.secret_key;
    let mineru_key = settings::get(pool, secret, settings::MINERU_API_KEY).await?;
    let deepseek_key = settings::get(pool, secret, settings::DEEPSEEK_API_KEY).await?;
    let deepseek_model = settings::get(pool, secret, settings::DEEPSEEK_MODEL)
        .await?
        .unwrap_or_else(|| "deepseek-chat".into());
    let deepseek_configured = deepseek_key.as_ref().is_some_and(|v| !v.trim().is_empty())
        && !deepseek_model.trim().is_empty();
    let configured_tier = settings::translation_tier(pool, secret).await?;
    let translation_tier = if configured_tier > 1 && !deepseek_configured {
        1
    } else {
        configured_tier
    };
    let r2_access = settings::get(pool, secret, settings::R2_ACCESS_KEY_ID).await?;
    let r2_secret = settings::get(pool, secret, settings::R2_SECRET_ACCESS_KEY).await?;
    Ok(AdminSettingsResponse {
        mineru_configured: mineru_key.as_ref().is_some_and(|v| !v.is_empty()),
        mineru_api_key_masked: settings::mask(mineru_key.as_deref()),
        mineru_model: settings::get(pool, secret, settings::MINERU_MODEL)
            .await?
            .unwrap_or_else(|| "vlm".into()),
        deepseek_configured,
        deepseek_api_key_masked: settings::mask(deepseek_key.as_deref()),
        deepseek_model,
        translation_provider: settings::translation_provider_for_tier(translation_tier).into(),
        translation_tier,
        r2_configured: R2Settings::load(pool, secret).await?.is_some(),
        r2_account_id: settings::get(pool, secret, settings::R2_ACCOUNT_ID)
            .await?
            .unwrap_or_default(),
        r2_access_key_id_masked: settings::mask(r2_access.as_deref()),
        r2_secret_access_key_masked: settings::mask(r2_secret.as_deref()),
        r2_bucket: settings::get(pool, secret, settings::R2_BUCKET)
            .await?
            .unwrap_or_default(),
        r2_public_base_url: settings::get(pool, secret, settings::R2_PUBLIC_BASE_URL)
            .await?
            .unwrap_or_default(),
    })
}

async fn admin_settings(
    State(state): State<Arc<AppState>>,
) -> Result<Json<AdminSettingsResponse>, ApiError> {
    Ok(Json(load_admin_settings(&state).await?))
}

#[derive(Deserialize)]
struct MinerUInput {
    api_key: String,
    model: String,
}
async fn save_mineru(
    State(state): State<Arc<AppState>>,
    Json(input): Json<MinerUInput>,
) -> Result<Json<AdminSettingsResponse>, ApiError> {
    let key = input.api_key.trim();
    if key.len() < 8 || !["vlm", "pipeline"].contains(&input.model.as_str()) {
        return Err(ApiError::bad_request("MinerU 配置格式不正确"));
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(25))
        .no_proxy()
        .build()
        .map_err(ApiError::internal)?;
    let response = client
        .get("https://mineru.net/api/v4/extract/task/00000000-0000-0000-0000-000000000000")
        .bearer_auth(key)
        .send()
        .await
        .map_err(|e| ApiError::bad_request(format!("无法连接 MinerU：{e}")))?;
    if matches!(response.status().as_u16(), 401 | 403) {
        return Err(ApiError::bad_request("MinerU API Key 无效或无权限"));
    }
    settings::set(
        &state.pool,
        &state.config.secret_key,
        settings::MINERU_API_KEY,
        key,
        true,
    )
    .await?;
    settings::set(
        &state.pool,
        &state.config.secret_key,
        settings::MINERU_MODEL,
        &input.model,
        false,
    )
    .await?;
    Ok(Json(load_admin_settings(&state).await?))
}

#[derive(Deserialize)]
struct DeepSeekInput {
    api_key: String,
    model: String,
}
async fn save_deepseek(
    State(state): State<Arc<AppState>>,
    Json(input): Json<DeepSeekInput>,
) -> Result<Json<AdminSettingsResponse>, ApiError> {
    let key = input.api_key.trim();
    let model = input.model.trim();
    if key.len() < 8 || model.is_empty() {
        return Err(ApiError::bad_request("DeepSeek 配置格式不正确"));
    }
    let response = reqwest::Client::builder().timeout(Duration::from_secs(45)).no_proxy().build().map_err(ApiError::internal)?
        .post("https://api.deepseek.com/chat/completions").bearer_auth(key)
        .json(&json!({"model":model,"messages":[{"role":"user","content":"只回复：好"}],"max_tokens":8,"stream":false}))
        .send().await.map_err(|e| ApiError::bad_request(format!("无法连接 DeepSeek：{e}")))?;
    if !response.status().is_success() {
        return Err(ApiError::bad_request(format!(
            "DeepSeek 配置验证失败（HTTP {}）",
            response.status()
        )));
    }
    settings::set(
        &state.pool,
        &state.config.secret_key,
        settings::DEEPSEEK_API_KEY,
        key,
        true,
    )
    .await?;
    settings::set(
        &state.pool,
        &state.config.secret_key,
        settings::DEEPSEEK_MODEL,
        model,
        false,
    )
    .await?;
    Ok(Json(load_admin_settings(&state).await?))
}

#[derive(Deserialize)]
struct TranslationProviderInput {
    #[serde(default)]
    tier: Option<i16>,
    #[serde(default)]
    provider: Option<String>,
}

async fn save_translation_provider(
    State(state): State<Arc<AppState>>,
    Json(input): Json<TranslationProviderInput>,
) -> Result<Json<AdminSettingsResponse>, ApiError> {
    let tier = input.tier.unwrap_or_else(|| {
        if input.provider.as_deref() == Some("deepseek") {
            2
        } else {
            1
        }
    });
    if !(1..=4).contains(&tier) {
        return Err(ApiError::bad_request("翻译质量档位只能是 1、2、3 或 4"));
    }
    if tier > 1
        && !(settings::configured(
            &state.pool,
            &state.config.secret_key,
            settings::DEEPSEEK_API_KEY,
        )
        .await
            && settings::configured(
                &state.pool,
                &state.config.secret_key,
                settings::DEEPSEEK_MODEL,
            )
            .await)
    {
        return Err(ApiError::bad_request(
            "请先保存并验证 DeepSeek API Key 与模型名称",
        ));
    }
    settings::set(
        &state.pool,
        &state.config.secret_key,
        settings::TRANSLATION_TIER,
        &tier.to_string(),
        false,
    )
    .await?;
    settings::set(
        &state.pool,
        &state.config.secret_key,
        settings::TRANSLATION_PROVIDER,
        settings::translation_provider_for_tier(tier),
        false,
    )
    .await?;
    Ok(Json(load_admin_settings(&state).await?))
}

#[derive(Deserialize)]
struct R2Input {
    account_id: String,
    access_key_id: String,
    secret_access_key: String,
    bucket: String,
    #[serde(default)]
    public_base_url: String,
}
async fn save_r2(
    State(state): State<Arc<AppState>>,
    Json(input): Json<R2Input>,
) -> Result<Json<AdminSettingsResponse>, ApiError> {
    let candidate = R2Settings {
        account_id: input.account_id.trim().to_string(),
        access_key_id: input.access_key_id.trim().to_string(),
        secret_access_key: input.secret_access_key.trim().to_string(),
        bucket: input.bucket.trim().to_string(),
        public_base_url: (!input.public_base_url.trim().is_empty()).then(|| {
            input
                .public_base_url
                .trim()
                .trim_end_matches('/')
                .to_string()
        }),
    };
    if candidate.account_id.is_empty()
        || candidate.access_key_id.is_empty()
        || candidate.secret_access_key.is_empty()
        || candidate.bucket.is_empty()
    {
        return Err(ApiError::bad_request(
            "R2 账号 ID、Access Key、Secret Key 和存储桶均不能为空",
        ));
    }
    R2Client::new(candidate.clone())
        .await
        .validate()
        .await
        .map_err(|e| ApiError::bad_request(format!("R2 配置验证失败：{e}")))?;
    let secret = &state.config.secret_key;
    settings::set(
        &state.pool,
        secret,
        settings::R2_ACCOUNT_ID,
        &candidate.account_id,
        false,
    )
    .await?;
    settings::set(
        &state.pool,
        secret,
        settings::R2_ACCESS_KEY_ID,
        &candidate.access_key_id,
        true,
    )
    .await?;
    settings::set(
        &state.pool,
        secret,
        settings::R2_SECRET_ACCESS_KEY,
        &candidate.secret_access_key,
        true,
    )
    .await?;
    settings::set(
        &state.pool,
        secret,
        settings::R2_BUCKET,
        &candidate.bucket,
        false,
    )
    .await?;
    settings::set(
        &state.pool,
        secret,
        settings::R2_PUBLIC_BASE_URL,
        candidate.public_base_url.as_deref().unwrap_or(""),
        false,
    )
    .await?;
    Ok(Json(load_admin_settings(&state).await?))
}

fn document_columns() -> &'static str {
    "id,title,original_filename,display_filename,storage_key,title_custom,source_path,source_size,mime_type,status,stage,progress,failure_reason,translate_requested,translation_provider,translation_tier,translation_guidance,translated,is_public,access_token_hash,mineru_task_id,mineru_model,pages_processed,pages_total,image_count,content_html,excerpt,created_at,updated_at,completed_at,markdown_original,markdown_translated,markdown_normalized,upload_sha256,queue_attempts,archive_status,archive_error,local_archive_status,local_archive_path,r2_mirror_status,r2_mirror_error,r2_prefix,source_r2_key,api_version"
}

#[derive(Deserialize)]
struct ListQuery {
    #[serde(default = "one")]
    page: i64,
    #[serde(default = "twelve")]
    page_size: i64,
    #[serde(default)]
    q: String,
}
fn one() -> i64 {
    1
}
fn twelve() -> i64 {
    12
}
async fn list_documents(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ListQuery>,
) -> Result<Json<DocumentList>, ApiError> {
    let page = query.page.clamp(1, 1_000_000);
    let size = query.page_size.clamp(1, 100);
    let pattern = format!("%{}%", query.q.trim());
    let total: i64=sqlx::query_scalar("SELECT count(*) FROM documents WHERE is_public=true AND ($1='' OR title ILIKE $2 OR original_filename ILIKE $2 OR display_filename ILIKE $2)").bind(query.q.trim()).bind(&pattern).fetch_one(&state.pool).await?;
    let sql = format!(
        "SELECT {} FROM documents WHERE is_public=true AND ($1='' OR title ILIKE $2 OR original_filename ILIKE $2 OR display_filename ILIKE $2) ORDER BY created_at DESC LIMIT $3 OFFSET $4",
        document_columns()
    );
    let items = sqlx::query_as::<_, Document>(&sql)
        .bind(query.q.trim())
        .bind(pattern)
        .bind(size)
        .bind((page - 1) * size)
        .fetch_all(&state.pool)
        .await?;
    Ok(Json(DocumentList {
        items,
        total,
        page,
        page_size: size,
    }))
}

async fn admin_list_documents(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ListQuery>,
) -> Result<Json<DocumentList>, ApiError> {
    let page = query.page.clamp(1, 1_000_000);
    let size = query.page_size.clamp(1, 100);
    let pattern = format!("%{}%", query.q.trim());
    let total: i64=sqlx::query_scalar("SELECT count(*) FROM documents WHERE $1='' OR title ILIKE $2 OR original_filename ILIKE $2 OR display_filename ILIKE $2").bind(query.q.trim()).bind(&pattern).fetch_one(&state.pool).await?;
    let sql = format!(
        "SELECT {} FROM documents WHERE $1='' OR title ILIKE $2 OR original_filename ILIKE $2 OR display_filename ILIKE $2 ORDER BY created_at DESC LIMIT $3 OFFSET $4",
        document_columns()
    );
    let items = sqlx::query_as::<_, Document>(&sql)
        .bind(query.q.trim())
        .bind(pattern)
        .bind(size)
        .bind((page - 1) * size)
        .fetch_all(&state.pool)
        .await?;
    Ok(Json(DocumentList {
        items,
        total,
        page,
        page_size: size,
    }))
}

async fn find_document(pool: &sqlx::PgPool, id: &str) -> Result<Document, ApiError> {
    let sql = format!("SELECT {} FROM documents WHERE id=$1", document_columns());
    sqlx::query_as::<_, Document>(&sql)
        .bind(id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| ApiError::not_found("文档不存在"))
}

fn document_cookie_name(id: &str) -> Result<String, ApiError> {
    let id = Uuid::parse_str(id).map_err(|_| ApiError::not_found("文档不存在"))?;
    Ok(format!("docflow_access_{}", id.simple()))
}

fn document_access_cookie(id: &str, token: &str) -> Result<HeaderValue, ApiError> {
    HeaderValue::from_str(&format!(
        "{}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=315360000",
        document_cookie_name(id)?
    ))
    .map_err(ApiError::internal)
}

fn request_can_access_document(state: &AppState, headers: &HeaderMap, doc: &Document) -> bool {
    doc.is_public
        || security::request_is_admin(&state.config.secret_key, headers)
        || doc.access_token_hash.as_deref().is_some_and(|expected| {
            document_cookie_name(&doc.id)
                .ok()
                .and_then(|name| security::cookie_value(headers, &name))
                .is_some_and(|token| security::verify_document_access_token(&token, expected))
        })
}

async fn find_accessible_document(
    state: &AppState,
    headers: &HeaderMap,
    id: &str,
) -> Result<Document, ApiError> {
    let doc = find_document(&state.pool, id).await?;
    if !request_can_access_document(state, headers, &doc) {
        return Err(ApiError::not_found("文档不存在"));
    }
    Ok(doc)
}

async fn get_document(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let doc = find_accessible_document(&state, &headers, &id).await?;
    let mut value = serde_json::to_value(&doc).map_err(ApiError::internal)?;
    value["content_html"] = serde_json::to_value(&doc.content_html).unwrap();
    value["markdown_available"] = json!({"original":doc.markdown_original.is_some(),"translated":doc.markdown_translated.is_some(),"normalized":doc.markdown_normalized.is_some()});
    Ok(Json(value))
}

#[derive(Deserialize)]
struct DocumentVisibilityInput {
    is_public: bool,
}

async fn update_document_visibility(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    Json(input): Json<DocumentVisibilityInput>,
) -> Result<Json<Document>, ApiError> {
    let result = sqlx::query("UPDATE documents SET is_public=$2,updated_at=NOW() WHERE id=$1")
        .bind(&id)
        .bind(input.is_public)
        .execute(&state.pool)
        .await?;
    if result.rows_affected() != 1 {
        return Err(ApiError::not_found("文档不存在"));
    }
    Ok(Json(find_document(&state.pool, &id).await?))
}

#[derive(Deserialize)]
struct DocumentNamesInput {
    title: String,
    display_filename: String,
}

fn clean_title(value: &str) -> Result<String, ApiError> {
    let title = value.trim();
    if title.is_empty()
        || title.chars().count() > 512
        || title
            .chars()
            .any(|ch| matches!(ch, '\0' | '\r' | '\n' | '\t'))
    {
        return Err(ApiError::bad_request("展示标题格式不正确"));
    }
    Ok(title.to_string())
}

fn clean_display_filename(value: &str, original: &str) -> Result<String, ApiError> {
    let cleaned = clean_filename(value);
    if cleaned.chars().count() > 512 || cleaned == "." || cleaned == ".." {
        return Err(ApiError::bad_request("下载文件名格式不正确"));
    }
    let original_extension = Path::new(original)
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("");
    let requested_extension = Path::new(&cleaned)
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("");
    if !requested_extension.eq_ignore_ascii_case(original_extension) {
        return Err(ApiError::bad_request(format!(
            "下载文件名必须保留 .{original_extension} 扩展名"
        )));
    }
    Ok(cleaned)
}

async fn update_document_names(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    Json(input): Json<DocumentNamesInput>,
) -> Result<Json<Document>, ApiError> {
    let current = find_document(&state.pool, &id).await?;
    let title = clean_title(&input.title)?;
    let display_filename =
        clean_display_filename(&input.display_filename, &current.original_filename)?;
    sqlx::query("UPDATE documents SET title=$2,display_filename=$3,title_custom=true,updated_at=NOW() WHERE id=$1")
        .bind(&id)
        .bind(title)
        .bind(display_filename)
        .execute(&state.pool)
        .await?;
    Ok(Json(find_document(&state.pool, &id).await?))
}

fn clean_filename(value: &str) -> String {
    let normalized = value.replace('\\', "/");
    let base = Path::new(&normalized)
        .file_name()
        .and_then(|v| v.to_str())
        .unwrap_or("document");
    let value: String = base
        .chars()
        .filter(|ch| !matches!(ch, '\0' | '\r' | '\n'))
        .take(500)
        .collect();
    if value.trim().is_empty() {
        "document".into()
    } else {
        value.trim().into()
    }
}

async fn create_document(
    State(state): State<Arc<AppState>>,
    mut multipart: Multipart,
) -> Result<Response, ApiError> {
    if !settings::configured(
        &state.pool,
        &state.config.secret_key,
        settings::MINERU_API_KEY,
    )
    .await
    {
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "管理员尚未配置 MinerU",
        ));
    }
    let id = Uuid::new_v4().to_string();
    let storage_key = Uuid::new_v4().simple().to_string();
    let root = state.config.archive_root.join(&storage_key);
    let source_dir = root.join("source");
    fs::create_dir_all(&source_dir)
        .await
        .map_err(ApiError::internal)?;
    let mut title: Option<String> = None;
    let mut requested_translation_tier: Option<String> = None;
    let mut saved: Option<(String, PathBuf, u64, String, String)> = None;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| ApiError::bad_request(format!("上传表单无效：{e}")))?
    {
        let name = field.name().unwrap_or("").to_string();
        if name == "translate" {
            // 兼容旧客户端；当前所有任务均会翻译。
            let _ = field.text().await;
            continue;
        }
        if name == "translation_tier" {
            requested_translation_tier = Some(field.text().await.unwrap_or_default());
            continue;
        }
        if name == "title" {
            title = Some(field.text().await.unwrap_or_default());
            continue;
        }
        if name != "file" || saved.is_some() {
            continue;
        }
        let filename = clean_filename(field.file_name().unwrap_or("document"));
        let extension = Path::new(&filename)
            .extension()
            .and_then(|v| v.to_str())
            .map(|v| format!(".{}", v.to_lowercase()))
            .unwrap_or_default();
        if !ACCEPTED_EXTENSIONS.contains(&extension.as_str()) {
            return Err(ApiError::new(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                format!(
                    "不支持 {} 文件",
                    if extension.is_empty() {
                        "无扩展名"
                    } else {
                        &extension
                    }
                ),
            ));
        }
        let mime = field.content_type().map(str::to_string).unwrap_or_else(|| {
            mime_guess::from_path(&filename)
                .first_or_octet_stream()
                .to_string()
        });
        let physical_name = format!("source{extension}");
        let partial = source_dir.join(format!(".{physical_name}.uploading"));
        let final_path = source_dir.join(physical_name);
        let mut output = fs::File::create(&partial)
            .await
            .map_err(ApiError::internal)?;
        let mut size = 0u64;
        let mut sha = Sha256::new();
        let mut stream = field;
        while let Some(chunk) = stream
            .chunk()
            .await
            .map_err(|e| ApiError::bad_request(format!("上传中断：{e}")))?
        {
            size += chunk.len() as u64;
            if size > state.config.max_upload_bytes {
                let _ = fs::remove_dir_all(&root).await;
                return Err(ApiError::new(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    format!("文件不能超过 {} MB", state.config.max_upload_mb()),
                ));
            }
            sha.update(&chunk);
            output.write_all(&chunk).await.map_err(ApiError::internal)?;
        }
        output.flush().await.map_err(ApiError::internal)?;
        drop(output);
        if size == 0 {
            let _ = fs::remove_dir_all(&root).await;
            return Err(ApiError::bad_request("文件为空"));
        }
        fs::rename(&partial, &final_path)
            .await
            .map_err(ApiError::internal)?;
        saved = Some((
            filename,
            final_path,
            size,
            mime,
            hex::encode(sha.finalize()),
        ));
    }
    let Some((filename, path, size, mime, sha)) = saved else {
        let _ = fs::remove_dir_all(&root).await;
        return Err(ApiError::bad_request("缺少文件字段"));
    };
    let configured_tier = settings::translation_tier(&state.pool, &state.config.secret_key).await?;
    let requested_translation_tier = match requested_translation_tier {
        Some(value) => match parse_translation_tier(&value) {
            Ok(tier) => Some(tier),
            Err(message) => {
                let _ = fs::remove_dir_all(&root).await;
                return Err(ApiError::bad_request(message));
            }
        },
        None => None,
    };
    let deepseek_ready = settings::configured(
        &state.pool,
        &state.config.secret_key,
        settings::DEEPSEEK_API_KEY,
    )
    .await
        && settings::configured(
            &state.pool,
            &state.config.secret_key,
            settings::DEEPSEEK_MODEL,
        )
        .await;
    if requested_translation_tier.is_some_and(|tier| tier > 1) && !deepseek_ready {
        let _ = fs::remove_dir_all(&root).await;
        return Err(ApiError::bad_request(
            "所选第 2–4 档需要管理员先配置并验证 DeepSeek API Key 与模型",
        ));
    }
    let translation_tier = requested_translation_tier.unwrap_or({
        if configured_tier > 1 && !deepseek_ready {
            1
        } else {
            configured_tier
        }
    });
    let translation_provider = settings::translation_provider_for_tier(translation_tier);
    let access_token = security::create_document_access_token();
    let access_token_hash = security::hash_document_access_token(&access_token);
    let custom_title = title.as_ref().is_some_and(|value| !value.trim().is_empty());
    let display = title.filter(|v| !v.trim().is_empty()).unwrap_or_else(|| {
        Path::new(&filename)
            .file_stem()
            .and_then(|v| v.to_str())
            .unwrap_or("未命名文档")
            .into()
    });
    let source_path = path
        .strip_prefix(&state.config.data_root)
        .unwrap_or(&path)
        .to_string_lossy()
        .replace('\\', "/");
    let model = settings::get(
        &state.pool,
        &state.config.secret_key,
        settings::MINERU_MODEL,
    )
    .await?
    .unwrap_or_else(|| "vlm".into());
    let sql = format!(
        "INSERT INTO documents(id,title,original_filename,display_filename,storage_key,title_custom,source_path,source_size,mime_type,status,stage,progress,failure_reason,translate_requested,translation_provider,translation_tier,translation_guidance,translated,is_public,access_token_hash,mineru_task_id,mineru_model,pages_processed,pages_total,image_count,content_html,excerpt,created_at,updated_at,completed_at,markdown_original,markdown_translated,markdown_normalized,upload_sha256,queue_attempts,archive_status,archive_error,archive_manifest,local_archive_status,local_archive_path,r2_mirror_status,r2_mirror_error,r2_prefix,source_r2_key,article_r2_key,mineru_r2_key,api_version,queue_available_at) VALUES($1,$2,$3,$3,$4,$5,$6,$7,$8,'queued','queued',2,NULL,true,$9,$10,NULL,false,false,$11,NULL,$12,NULL,NULL,0,NULL,NULL,NOW(),NOW(),NULL,NULL,NULL,NULL,$13,0,'source_local',NULL,NULL,'source_saved',$14,'disabled',NULL,NULL,NULL,NULL,NULL,'v2',NOW()) RETURNING {}",
        document_columns()
    );
    let doc = sqlx::query_as::<_, Document>(&sql)
        .bind(&id)
        .bind(display.trim().chars().take(512).collect::<String>())
        .bind(&filename)
        .bind(&storage_key)
        .bind(custom_title)
        .bind(source_path)
        .bind(size as i32)
        .bind(mime)
        .bind(translation_provider)
        .bind(translation_tier)
        .bind(access_token_hash)
        .bind(model)
        .bind(sha)
        .bind(format!("archives/{storage_key}"))
        .fetch_one(&state.pool)
        .await?;
    events::append(
        &state.pool,
        &id,
        EventInput {
            stage: "source_saved",
            state: "completed",
            level: "success",
            progress: 1,
            message: "源文件已完整写入本地永久目录",
            detail: Some(
                "已计算 SHA-256；磁盘使用随机内部存储键和固定 ASCII 文件名，展示名仅记录在数据库",
            ),
            current: Some(size as i64),
            total: Some(size as i64),
        },
    )
    .await
    .map_err(ApiError::internal)?;
    events::append(
        &state.pool,
        &id,
        EventInput {
            stage: "queued",
            state: "running",
            level: "info",
            progress: 2,
            message: "任务已写入 PostgreSQL 持久队列",
            detail: Some(&format!(
                "文档默认私有；当前浏览器已取得独立访问凭证；并发 Worker 将使用 SKIP LOCKED 原子领取；本次选择的翻译档位已快照为第 {} 档（{}）",
                translation_tier,
                match translation_tier {
                    1 => "极速 · Google 免费翻译",
                    2 => "标准 · DeepSeek 直接翻译",
                    3 => "精细 · 全文速览约束",
                    _ => "Agent · 通读后逐段翻译",
                }
            )),
            current: None,
            total: None,
        },
    )
    .await
    .map_err(ApiError::internal)?;
    Ok((
        StatusCode::ACCEPTED,
        [(
            header::SET_COOKIE,
            document_access_cookie(&id, &access_token)?,
        )],
        Json(doc),
    )
        .into_response())
}

#[derive(Deserialize)]
struct EventsQuery {
    #[serde(default)]
    after_id: i64,
    #[serde(default = "five_hundred")]
    limit: i64,
}
fn five_hundred() -> i64 {
    500
}
async fn list_events(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Query(q): Query<EventsQuery>,
) -> Result<Json<EventList>, ApiError> {
    find_accessible_document(&state, &headers, &id).await?;
    let limit = q.limit.clamp(1, 1000);
    let items=sqlx::query_as::<_,ProcessingEvent>("SELECT id,document_id,stage,state,level,progress,message,detail,current,total,created_at FROM processing_events WHERE document_id=$1 AND id>$2 ORDER BY id LIMIT $3").bind(&id).bind(q.after_id).bind(limit).fetch_all(&state.pool).await?;
    let total: i64 =
        sqlx::query_scalar("SELECT count(*) FROM processing_events WHERE document_id=$1")
            .bind(&id)
            .fetch_one(&state.pool)
            .await?;
    let next = items.last().map(|v| v.id).unwrap_or(q.after_id);
    let more: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM processing_events WHERE document_id=$1 AND id>$2)",
    )
    .bind(&id)
    .bind(next)
    .fetch_one(&state.pool)
    .await?;
    Ok(Json(EventList {
        items,
        total,
        next_after_id: next,
        has_more: more,
    }))
}

async fn stream_events(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Query(q): Query<EventsQuery>,
) -> Result<Sse<impl futures::Stream<Item = Result<Event, Infallible>>>, ApiError> {
    find_accessible_document(&state, &headers, &id).await?;
    let pool = state.pool.clone();
    let stream = async_stream::stream! {
      let mut cursor=q.after_id;
      loop {
        match sqlx::query_as::<_,ProcessingEvent>("SELECT id,document_id,stage,state,level,progress,message,detail,current,total,created_at FROM processing_events WHERE document_id=$1 AND id>$2 ORDER BY id LIMIT 100").bind(&id).bind(cursor).fetch_all(&pool).await {
            Ok(rows) => {
                for row in rows {
                    cursor=row.id;
                    yield Ok(Event::default().id(row.id.to_string()).event("progress").json_data(&row).unwrap_or_else(|_|Event::default().event("error").data("serialization")));
                }
            }
            Err(error) => {
                tracing::warn!(%error,"SSE query failed");
                yield Ok(Event::default().event("error").data("temporary database error"));
            }
        }
        let done:bool=sqlx::query_scalar("SELECT status IN ('completed','failed') FROM documents WHERE id=$1").bind(&id).fetch_one(&pool).await.unwrap_or(true);
        if done {
            yield Ok(Event::default().event("end").data("complete"));
            break;
        }
        tokio::time::sleep(Duration::from_millis(650)).await;
      }
    };
    Ok(Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(12))
            .text("heartbeat"),
    ))
}

#[derive(Deserialize)]
struct MarkdownQuery {
    #[serde(default = "normalized")]
    variant: String,
}
fn normalized() -> String {
    "normalized".into()
}
async fn get_markdown(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Query(q): Query<MarkdownQuery>,
) -> Result<Response, ApiError> {
    let doc = find_accessible_document(&state, &headers, &id).await?;
    let text = match q.variant.as_str() {
        "original" => doc.markdown_original,
        "translated" => doc.markdown_translated,
        "normalized" => doc.markdown_normalized,
        _ => {
            return Err(ApiError::bad_request(
                "variant 只能是 original、translated 或 normalized",
            ));
        }
    }
    .ok_or_else(|| ApiError::not_found("该版本 Markdown 尚不可用"))?;
    Ok((
        [(header::CONTENT_TYPE, "text/markdown; charset=utf-8")],
        text,
    )
        .into_response())
}

async fn r2_for(state: &AppState) -> Result<R2Client, ApiError> {
    let settings = R2Settings::load(&state.pool, &state.config.secret_key)
        .await?
        .ok_or_else(|| ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "R2 尚未配置"))?;
    Ok(R2Client::new(settings).await)
}

fn attachment_header(name: &str) -> Option<HeaderValue> {
    let safe = name.replace(['\r', '\n', '"'], "_");
    HeaderValue::from_str(&format!(
        "attachment; filename*=UTF-8''{}",
        url::form_urlencoded::byte_serialize(safe.as_bytes()).collect::<String>()
    ))
    .ok()
}

async fn r2_response(
    state: &AppState,
    key: &str,
    download_name: Option<&str>,
) -> Result<Response, ApiError> {
    let object = r2_for(state).await?.get(key).await?;
    let content_type = object
        .content_type
        .unwrap_or_else(|| "application/octet-stream".into());
    let stream = ReaderStream::new(object.body.into_async_read());
    let mut response = Response::new(Body::from_stream(stream));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(&content_type)
            .unwrap_or(HeaderValue::from_static("application/octet-stream")),
    );
    if let Some(name) = download_name
        && let Some(value) = attachment_header(name)
    {
        response
            .headers_mut()
            .insert(header::CONTENT_DISPOSITION, value);
    }
    Ok(response)
}

async fn download_bundle(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Result<Response, ApiError> {
    let doc = find_accessible_document(&state, &headers, &id).await?;
    let events = sqlx::query_as::<_, ProcessingEvent>("SELECT id,document_id,stage,state,level,progress,message,detail,current,total,created_at FROM processing_events WHERE document_id=$1 ORDER BY id")
        .bind(&id)
        .fetch_all(&state.pool)
        .await?;
    let export_root = state.config.work_root.join("exports");
    fs::create_dir_all(&export_root)
        .await
        .map_err(ApiError::internal)?;
    let output = export_root.join(format!("{}.zip", Uuid::new_v4().simple()));
    let build_output = output.clone();
    let data_root = state.config.data_root.clone();
    let download_name = bundle_download_name(&doc.title);
    tokio::task::spawn_blocking(move || build_bundle(&build_output, &data_root, &doc, &events))
        .await
        .map_err(ApiError::internal)?
        .map_err(ApiError::internal)?;
    let file = fs::File::open(&output).await.map_err(ApiError::internal)?;
    let _ = fs::remove_file(&output).await;
    let mut response = Response::new(Body::from_stream(ReaderStream::new(file)));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/zip"),
    );
    if let Some(value) = attachment_header(&download_name) {
        response
            .headers_mut()
            .insert(header::CONTENT_DISPOSITION, value);
    }
    Ok(response)
}

fn build_bundle(
    output: &Path,
    data_root: &Path,
    doc: &Document,
    events: &[ProcessingEvent],
) -> anyhow::Result<()> {
    use std::collections::HashSet;
    use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

    let file = std::fs::File::create(output)?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o644);
    let mut names = HashSet::new();

    if let Some(relative) = doc.local_archive_path.as_deref()
        && let Some(root) = safe_data_path(data_root, relative)
        && root.is_dir()
    {
        let mut paths = walkdir::WalkDir::new(&root)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().is_file())
            .map(|entry| entry.into_path())
            .collect::<Vec<_>>();
        paths.sort();
        for path in paths {
            let name = path
                .strip_prefix(&root)?
                .to_string_lossy()
                .replace('\\', "/");
            if name.ends_with(".partial")
                || matches!(
                    name.as_str(),
                    "metadata/document.json" | "metadata/events.json"
                )
                || !valid_zip_name(&name)
            {
                continue;
            }
            add_disk_file(&mut zip, options, &path, &name)?;
            names.insert(name);
        }
    }

    if !names.iter().any(|name| name.starts_with("source/")) {
        let source = safe_data_path(data_root, &doc.source_path)
            .filter(|path| path.is_file())
            .context("本地源文件不可用，无法生成完整归档包")?;
        let extension = Path::new(&doc.original_filename)
            .extension()
            .and_then(|value| value.to_str())
            .filter(|value| value.chars().all(|ch| ch.is_ascii_alphanumeric()))
            .unwrap_or("bin")
            .to_ascii_lowercase();
        let name = format!("source/source.{extension}");
        add_disk_file(&mut zip, options, &source, &name)?;
        names.insert(name);
    }

    for (name, value) in [
        ("markdown/original.md", doc.markdown_original.as_deref()),
        ("markdown/translated.md", doc.markdown_translated.as_deref()),
        (
            "translation/guidance.md",
            doc.translation_guidance.as_deref(),
        ),
        ("markdown/normalized.md", doc.markdown_normalized.as_deref()),
        ("article/article.html", doc.content_html.as_deref()),
    ] {
        if !names.contains(name)
            && let Some(value) = value
        {
            add_bytes(&mut zip, options, name, value.as_bytes())?;
            names.insert(name.to_string());
        }
    }

    let storage_mapping_consistent = doc.local_archive_path.as_deref().is_some_and(|relative| {
        Path::new(relative)
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value == doc.storage_key)
    });
    let metadata = json!({
        "schema": "docflow-export-v2",
        "document_id": doc.id,
        "title": doc.title,
        "display_filename": doc.display_filename,
        "original_filename": doc.original_filename,
        "source_size": doc.source_size,
        "mime_type": doc.mime_type,
        "sha256": doc.upload_sha256,
        "status": doc.status,
        "local_archive_status": doc.local_archive_status,
        "r2_mirror_status": doc.r2_mirror_status,
        "translation_provider": doc.translation_provider,
        "translation_tier": doc.translation_tier,
        "translation_guidance_available": doc.translation_guidance.is_some(),
        "translated": doc.translated,
        "is_public": doc.is_public,
        "created_at": doc.created_at,
        "completed_at": doc.completed_at,
        "custom_display_title": doc.title_custom,
        "storage_mapping_consistent": storage_mapping_consistent,
        "naming_note": "展示名称来自数据库；ZIP 内部及服务器物理文件只使用 ASCII 稳定名称。",
    });
    add_bytes(
        &mut zip,
        options,
        "metadata/document.json",
        &serde_json::to_vec_pretty(&metadata)?,
    )?;
    add_bytes(
        &mut zip,
        options,
        "metadata/events.json",
        &serde_json::to_vec_pretty(events)?,
    )?;
    add_bytes(
        &mut zip,
        options,
        "README.txt",
        "文流本地永久归档包\n\nsource/：原始文件（固定 ASCII 物理名）\nmarkdown/：MinerU 原稿、中文译稿和规范化稿\nimages/：已本地化的 WebP 图片\narticle/：安全渲染后的 HTML\nmetadata/：当前展示名称、校验信息和完整处理事件\n\n文件展示名与服务器物理名分离，重命名不会改动归档内容。\n".as_bytes(),
    )?;
    zip.finish()?;
    Ok(())
}

fn add_disk_file(
    zip: &mut zip::ZipWriter<std::fs::File>,
    options: zip::write::SimpleFileOptions,
    path: &Path,
    name: &str,
) -> anyhow::Result<()> {
    zip.start_file(name, options)?;
    let mut source = std::fs::File::open(path)?;
    std::io::copy(&mut source, zip)?;
    Ok(())
}

fn add_bytes(
    zip: &mut zip::ZipWriter<std::fs::File>,
    options: zip::write::SimpleFileOptions,
    name: &str,
    bytes: &[u8],
) -> anyhow::Result<()> {
    zip.start_file(name, options)?;
    zip.write_all(bytes)?;
    Ok(())
}

fn valid_zip_name(name: &str) -> bool {
    !name.is_empty()
        && name.is_ascii()
        && !name.starts_with('/')
        && !name.split('/').any(|part| matches!(part, "" | "." | ".."))
}

fn parse_translation_tier(value: &str) -> Result<i16, &'static str> {
    match value.trim().parse::<i16>() {
        Ok(tier @ 1..=4) => Ok(tier),
        _ => Err("翻译质量档位只能是 1、2、3 或 4"),
    }
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

fn bundle_download_name(title: &str) -> String {
    let base = title
        .replace(['/', '\\', '\r', '\n', '\0'], "_")
        .trim()
        .chars()
        .take(120)
        .collect::<String>();
    format!(
        "{}-完整归档.zip",
        if base.is_empty() { "document" } else { &base }
    )
}

async fn download_source(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Result<Response, ApiError> {
    let doc = find_accessible_document(&state, &headers, &id).await?;
    let path = safe_data_path(&state.config.data_root, &doc.source_path);
    let Some(path) = path.filter(|path| path.is_file()) else {
        if let Some(key) = doc.source_r2_key.as_deref() {
            return r2_response(&state, key, Some(&doc.display_filename)).await;
        }
        return Err(ApiError::not_found("本地永久源文件不可用"));
    };
    let file = fs::File::open(path).await.map_err(ApiError::internal)?;
    let mut response = Response::new(Body::from_stream(ReaderStream::new(file)));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(
            doc.mime_type
                .as_deref()
                .unwrap_or("application/octet-stream"),
        )
        .unwrap(),
    );
    if let Some(value) = attachment_header(&doc.display_filename) {
        response
            .headers_mut()
            .insert(header::CONTENT_DISPOSITION, value);
    }
    Ok(response)
}

async fn get_asset(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    AxumPath((id, name)): AxumPath<(String, String)>,
) -> Result<Response, ApiError> {
    if name.contains('/') || name.contains('\\') || name.contains("..") || !name.ends_with(".webp")
    {
        return Err(ApiError::bad_request("图片名称无效"));
    }
    let doc = find_accessible_document(&state, &headers, &id).await?;
    if let Some(relative) = doc.local_archive_path.as_deref()
        && let Some(root) = safe_data_path(&state.config.data_root, relative)
    {
        let path = root.join("images").join(&name);
        if path.is_file() {
            let file = fs::File::open(path).await.map_err(ApiError::internal)?;
            return Ok((
                [(header::CONTENT_TYPE, "image/webp")],
                Body::from_stream(ReaderStream::new(file)),
            )
                .into_response());
        }
    }
    let prefix = doc
        .r2_prefix
        .ok_or_else(|| ApiError::not_found("本地和 R2 均没有该图片"))?;
    r2_response(&state, &format!("{prefix}/images/{name}"), None).await
}

async fn openapi(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let server_url = if state.config.public_origin.is_empty() {
        "/api/v1".to_string()
    } else {
        format!("{}/api/v1", state.config.public_origin)
    };
    Json(json!({
        "openapi":"3.1.0","info":{"title":format!("{} Open API",state.config.app_name),"version":"1.2.0","description":"文档解析、四档中文翻译、永久归档与实时进度 API。管理员设置默认档位，上传者可为本次任务选择已开放档位。新任务默认私有；上传响应设置当前浏览器专属 HttpOnly 访问 Cookie，管理员可改为公开。没有删除接口。"},
        "servers":[{"url":server_url}],
        "paths":{
          "/jobs":{"get":{"summary":"管理员主动公开的任务列表"},"post":{"summary":"上传文档并创建默认私有任务","description":"translation_tier 可选 1–4；不传时使用管理员默认档位，第 2–4 档仅在 DeepSeek 已配置时可用。选定档位在任务创建时快照；响应通过 Set-Cookie 赋予当前浏览器文档访问权。","requestBody":{"required":true,"content":{"multipart/form-data":{"schema":{"type":"object","required":["file"],"properties":{"file":{"type":"string","format":"binary"},"title":{"type":"string"},"translation_tier":{"type":"integer","minimum":1,"maximum":4}}}}}}}},
          "/jobs/{id}":{"get":{"summary":"任务状态与文章"}},
          "/jobs/{id}/events":{"get":{"summary":"增量读取永久进度事件"}},
          "/jobs/{id}/events/stream":{"get":{"summary":"SSE 实时进度流"}},
          "/jobs/{id}/markdown":{"get":{"summary":"读取永久 Markdown","parameters":[{"name":"variant","in":"query","schema":{"enum":["original","translated","normalized"]}}]}},
          "/jobs/{id}/source":{"get":{"summary":"按数据库展示名下载原始文件"}},
          "/jobs/{id}/bundle":{"get":{"summary":"下载包含源文件、Markdown、WebP 与元数据的完整 ZIP"}}
        }
    }))
}

async fn api_docs() -> Html<&'static str> {
    Html(
        r#"<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>文流 Open API</title><style>body{font:16px/1.7 system-ui;max-width:920px;margin:48px auto;padding:0 24px;color:#17201d}code,pre{background:#f3f5f3;border-radius:8px}code{padding:2px 6px}pre{padding:18px;overflow:auto}a{color:#176b4d}</style></head><body><p><a href="/">← 返回文流</a></p><h1>文流 Open API v1</h1><p>上传无需登录，但新任务默认私有。上传响应设置当前客户端专属访问 Cookie；后续查询、SSE 与下载必须携带它。管理员可在后台公开文档。管理员设置默认翻译档位，上传者可为本次任务选择已开放档位；源文件与处理结果永久保存在 VPS 本地，R2 是可选镜像。</p><h2>创建私有任务并保存访问 Cookie</h2><pre>curl -c docflow.cookies -F "file=@paper.pdf" -F "title=文档标题" -F "translation_tier=3" http://你的服务器IP:38100/api/v1/jobs</pre><h2>实时进度</h2><pre>curl -b docflow.cookies -N http://你的服务器IP:38100/api/v1/jobs/{id}/events/stream?after_id=0</pre><h2>完整打包</h2><pre>curl -b docflow.cookies -OJ http://你的服务器IP:38100/api/v1/jobs/{id}/bundle</pre><h2>机器可读规范</h2><p><a href="/api/openapi.json">OpenAPI 3.1 JSON</a></p></body></html>"#,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filename_cleanup_drops_paths_and_control_characters() {
        assert_eq!(clean_filename("../folder/report\r\n.pdf"), "report.pdf");
        assert_eq!(clean_filename("..\\中文目录\\论文.pdf"), "论文.pdf");
        assert_eq!(clean_filename(""), "document");
    }

    #[test]
    fn display_filename_keeps_original_extension_without_using_paths() {
        assert_eq!(
            clean_display_filename("目录\\新的 下载名.PDF", "original.pdf").unwrap(),
            "新的 下载名.PDF"
        );
        assert!(clean_display_filename("renamed.docx", "original.pdf").is_err());
    }

    #[test]
    fn data_paths_and_zip_entries_reject_traversal() {
        assert!(safe_data_path(Path::new("/data"), "archives/abc/source.pdf").is_some());
        assert!(safe_data_path(Path::new("/data"), "../secret").is_none());
        assert!(valid_zip_name("markdown/normalized.md"));
        assert!(!valid_zip_name("../escape.md"));
        assert!(!valid_zip_name("中文/文件.md"));
    }

    #[test]
    fn accepted_extensions_cover_office_and_pdf() {
        for extension in [".pdf", ".docx", ".pptx", ".xlsx"] {
            assert!(ACCEPTED_EXTENSIONS.contains(&extension));
        }
    }

    #[test]
    fn translation_tier_accepts_only_four_public_choices() {
        for tier in 1..=4 {
            assert_eq!(parse_translation_tier(&tier.to_string()).unwrap(), tier);
        }
        for invalid in ["", "0", "5", "2.5", "agent"] {
            assert!(parse_translation_tier(invalid).is_err());
        }
    }
}
