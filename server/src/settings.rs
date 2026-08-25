use anyhow::Result;
use serde::Serialize;
use sqlx::PgPool;

use crate::security::{decrypt_secret, encrypt_secret};

pub const MINERU_API_KEY: &str = "mineru_api_key";
pub const MINERU_MODEL: &str = "mineru_model";
pub const DEEPSEEK_API_KEY: &str = "deepseek_api_key";
pub const DEEPSEEK_MODEL: &str = "deepseek_model";
pub const TRANSLATION_PROVIDER: &str = "translation_provider";
pub const R2_ACCOUNT_ID: &str = "r2_account_id";
pub const R2_ACCESS_KEY_ID: &str = "r2_access_key_id";
pub const R2_SECRET_ACCESS_KEY: &str = "r2_secret_access_key";
pub const R2_BUCKET: &str = "r2_bucket";
pub const R2_PUBLIC_BASE_URL: &str = "r2_public_base_url";

pub async fn get(pool: &PgPool, secret_key: &str, key: &str) -> Result<Option<String>> {
    let row = sqlx::query_as::<_, (String, bool)>(
        "SELECT value, encrypted FROM app_settings WHERE key = $1",
    )
    .bind(key)
    .fetch_optional(pool)
    .await?;
    row.map(|(value, encrypted)| {
        if encrypted {
            decrypt_secret(secret_key, &value)
        } else {
            Ok(value)
        }
    })
    .transpose()
}

pub async fn set(
    pool: &PgPool,
    secret_key: &str,
    key: &str,
    value: &str,
    encrypted: bool,
) -> Result<()> {
    let stored = if encrypted {
        encrypt_secret(secret_key, value)?
    } else {
        value.to_string()
    };
    sqlx::query(
        "INSERT INTO app_settings (key, value, encrypted, updated_at) VALUES ($1, $2, $3, NOW()) \
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, encrypted = EXCLUDED.encrypted, updated_at = NOW()"
    ).bind(key).bind(stored).bind(encrypted).execute(pool).await?;
    Ok(())
}

pub async fn configured(pool: &PgPool, secret_key: &str, key: &str) -> bool {
    get(pool, secret_key, key)
        .await
        .ok()
        .flatten()
        .is_some_and(|value| !value.trim().is_empty())
}

pub async fn translation_provider(pool: &PgPool, secret_key: &str) -> Result<String> {
    Ok(match get(pool, secret_key, TRANSLATION_PROVIDER)
        .await?
        .as_deref()
    {
        Some("deepseek") => "deepseek",
        _ => "google",
    }
    .to_string())
}

pub fn mask(value: Option<&str>) -> Option<String> {
    value.filter(|v| !v.is_empty()).map(|value| {
        let suffix: String = value
            .chars()
            .rev()
            .take(4)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        format!("••••••••{suffix}")
    })
}

#[derive(Debug, Clone)]
pub struct R2Settings {
    pub account_id: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    pub bucket: String,
    pub public_base_url: Option<String>,
}

impl R2Settings {
    pub async fn load(pool: &PgPool, secret_key: &str) -> Result<Option<Self>> {
        let account_id = get(pool, secret_key, R2_ACCOUNT_ID).await?;
        let access_key_id = get(pool, secret_key, R2_ACCESS_KEY_ID).await?;
        let secret_access_key = get(pool, secret_key, R2_SECRET_ACCESS_KEY).await?;
        let bucket = get(pool, secret_key, R2_BUCKET).await?;
        match (account_id, access_key_id, secret_access_key, bucket) {
            (Some(account_id), Some(access_key_id), Some(secret_access_key), Some(bucket))
                if !account_id.is_empty()
                    && !access_key_id.is_empty()
                    && !secret_access_key.is_empty()
                    && !bucket.is_empty() =>
            {
                Ok(Some(Self {
                    account_id,
                    access_key_id,
                    secret_access_key,
                    bucket,
                    public_base_url: get(pool, secret_key, R2_PUBLIC_BASE_URL)
                        .await?
                        .filter(|v| !v.trim().is_empty()),
                }))
            }
            _ => Ok(None),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct AdminSettingsResponse {
    pub mineru_configured: bool,
    pub mineru_api_key_masked: Option<String>,
    pub mineru_model: String,
    pub deepseek_configured: bool,
    pub deepseek_api_key_masked: Option<String>,
    pub deepseek_model: String,
    pub translation_provider: String,
    pub r2_configured: bool,
    pub r2_account_id: String,
    pub r2_access_key_id_masked: Option<String>,
    pub r2_secret_access_key_masked: Option<String>,
    pub r2_bucket: String,
    pub r2_public_base_url: String,
}
