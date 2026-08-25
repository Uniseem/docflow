mod api;
mod bootstrap;
mod config;
mod db;
mod events;
mod local_backfill;
mod models;
mod pipeline;
mod r2;
mod security;
mod settings;
mod translation_pool;
mod worker;

use std::sync::Arc;

use anyhow::{Context, Result};
use config::Config;
use db::AppState;
use sqlx::postgres::PgPoolOptions;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "docflow_server=info,tower_http=info".into()),
        )
        .init();

    let mode = std::env::args().nth(1).unwrap_or_else(|| "api".to_string());
    let config = Arc::new(Config::from_env()?);
    if mode == "healthcheck" {
        let response = reqwest::Client::builder()
            .no_proxy()
            .build()?
            .get("http://127.0.0.1:8000/api/health")
            .send()
            .await?;
        if !response.status().is_success() {
            anyhow::bail!("API health returned {}", response.status());
        }
        return Ok(());
    }
    tokio::fs::create_dir_all(&config.work_root).await?;
    tokio::fs::create_dir_all(&config.archive_root).await?;
    let pool = PgPoolOptions::new()
        .max_connections(config.database_pool_size)
        .connect(&config.database_url)
        .await
        .context("连接 PostgreSQL 失败")?;

    if mode == "migrate" {
        bootstrap::ensure_legacy_schema(&pool).await?;
        sqlx::migrate!("./migrations").run(&pool).await?;
        local_backfill::run(&pool, &config).await?;
        tracing::info!("database migrations completed");
        return Ok(());
    }

    let translation_pools = (mode == "worker")
        .then(|| translation_pool::TranslationPools::new(&config))
        .transpose()?;
    let state = Arc::new(AppState {
        pool,
        config,
        translation_pools,
    });
    if mode == "compat-check" {
        let password_hash: Option<String> =
            sqlx::query_scalar("SELECT password_hash FROM admin_users WHERE id=1")
                .fetch_optional(&state.pool)
                .await?;
        if password_hash
            .as_deref()
            .is_some_and(|value| !security::password_hash_is_supported(value))
        {
            anyhow::bail!("现有管理员密码哈希格式不受支持");
        }
        let encrypted_keys: Vec<String> =
            sqlx::query_scalar("SELECT key FROM app_settings WHERE encrypted=true ORDER BY key")
                .fetch_all(&state.pool)
                .await?;
        for key in &encrypted_keys {
            settings::get(&state.pool, &state.config.secret_key, key)
                .await?
                .with_context(|| format!("加密配置 {key} 没有值"))?;
        }
        tracing::info!(
            admin_hash = password_hash.is_some(),
            encrypted_settings = encrypted_keys.len(),
            keys = ?encrypted_keys,
            "legacy compatibility check passed"
        );
        return Ok(());
    }
    match mode.as_str() {
        "api" => api::serve(state).await,
        "worker" => worker::run(state).await,
        other => anyhow::bail!(
            "未知运行模式：{other}（应为 api、worker、migrate、compat-check 或 healthcheck）"
        ),
    }
}
