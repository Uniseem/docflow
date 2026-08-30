use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;

use crate::{
    config::Config,
    security::{decrypt_secret, encrypt_secret},
};

pub const MINERU_API_KEY: &str = "mineru_api_key";
pub const MINERU_MODEL: &str = "mineru_model";
pub const GOOGLE_TRANSLATE_API_KEY: &str = "google_translate_api_key";
pub const DEEPSEEK_API_KEY: &str = "deepseek_api_key";
pub const DEEPSEEK_MODEL: &str = "deepseek_model";
pub const TRANSLATION_PROVIDER: &str = "translation_provider";
pub const TRANSLATION_TIER: &str = "translation_tier";
pub const TRANSLATION_RUNTIME: &str = "translation_runtime";
pub const GOOGLE_MAX_CONCURRENCY: usize = 256;
pub const DEEPSEEK_MAX_CONCURRENCY: usize = 2_000;
pub const MIN_CHUNK_CHARS: usize = 100;
pub const GOOGLE_MAX_CHUNK_CHARS: usize = 4_000;
pub const DEEPSEEK_MAX_CHUNK_CHARS: usize = 12_000;
pub const GOOGLE_MAX_SEGMENTS_PER_REQUEST: usize = 100;
pub const DEEPSEEK_MAX_SEGMENTS_PER_REQUEST: usize = 64;
pub const MAX_PER_DOCUMENT_CONCURRENCY: usize = 32;
pub const MAX_SYSTEM_PROMPT_CHARS: usize = 12_000;
pub const DEFAULT_TRANSLATION_SYSTEM_PROMPT: &str = "你是严谨的学术文献译者。把用户提供的 Markdown 准确翻译成简体中文，保持标题、列表、表格、引用和换行结构，不合并、不遗漏、不解释、不加代码围栏。";
pub const R2_ACCOUNT_ID: &str = "r2_account_id";
pub const R2_ACCESS_KEY_ID: &str = "r2_access_key_id";
pub const R2_SECRET_ACCESS_KEY: &str = "r2_secret_access_key";
pub const R2_BUCKET: &str = "r2_bucket";
pub const R2_PUBLIC_BASE_URL: &str = "r2_public_base_url";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TranslationProviderSettings {
    pub concurrency: usize,
    pub chunk_chars: usize,
    pub max_segments_per_request: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TranslationRuntimeSettings {
    pub google: TranslationProviderSettings,
    pub deepseek: TranslationProviderSettings,
    pub per_document_concurrency: usize,
    pub system_prompt: String,
}

impl TranslationRuntimeSettings {
    pub fn defaults(config: &Config) -> Self {
        Self {
            google: TranslationProviderSettings {
                concurrency: config
                    .google_translation_concurrency
                    .clamp(1, GOOGLE_MAX_CONCURRENCY),
                chunk_chars: GOOGLE_MAX_CHUNK_CHARS,
                max_segments_per_request: 4,
            },
            deepseek: TranslationProviderSettings {
                concurrency: config
                    .deepseek_translation_concurrency
                    .clamp(1, DEEPSEEK_MAX_CONCURRENCY),
                chunk_chars: config
                    .translation_chunk_chars
                    .clamp(MIN_CHUNK_CHARS, DEEPSEEK_MAX_CHUNK_CHARS),
                max_segments_per_request: 4,
            },
            per_document_concurrency: config
                .translation_per_document_concurrency
                .clamp(1, MAX_PER_DOCUMENT_CONCURRENCY),
            system_prompt: DEFAULT_TRANSLATION_SYSTEM_PROMPT.to_owned(),
        }
    }

    pub fn validate(&self) -> Result<()> {
        let limits = TranslationRuntimeLimits::default();
        self.google.validate("Google", &limits.google)?;
        self.deepseek.validate("DeepSeek", &limits.deepseek)?;
        ensure!(
            (1..=MAX_PER_DOCUMENT_CONCURRENCY).contains(&self.per_document_concurrency),
            "单文档并发数必须在 1–{MAX_PER_DOCUMENT_CONCURRENCY} 之间"
        );
        ensure!(
            !self.system_prompt.trim().is_empty(),
            "全局翻译提示词不能为空"
        );
        ensure!(
            self.system_prompt.chars().count() <= MAX_SYSTEM_PROMPT_CHARS,
            "全局翻译提示词不能超过 {MAX_SYSTEM_PROMPT_CHARS} 个字符"
        );
        ensure!(
            !self.system_prompt.contains('\0'),
            "全局翻译提示词不能包含空字符"
        );
        Ok(())
    }
}

impl TranslationProviderSettings {
    fn validate(&self, provider: &str, limits: &TranslationProviderLimits) -> Result<()> {
        ensure!(
            (1..=limits.concurrency_max).contains(&self.concurrency),
            "{provider} 并发数必须在 1–{} 之间",
            limits.concurrency_max
        );
        ensure!(
            (MIN_CHUNK_CHARS..=limits.chunk_chars_max).contains(&self.chunk_chars),
            "{provider} 每段最多字符数必须在 {MIN_CHUNK_CHARS}–{} 之间",
            limits.chunk_chars_max
        );
        ensure!(
            (1..=limits.max_segments_per_request_max).contains(&self.max_segments_per_request),
            "{provider} 单次请求最多段数必须在 1–{} 之间",
            limits.max_segments_per_request_max
        );
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct TranslationProviderLimits {
    pub concurrency_max: usize,
    pub chunk_chars_max: usize,
    pub max_segments_per_request_max: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct TranslationRuntimeLimits {
    pub google: TranslationProviderLimits,
    pub deepseek: TranslationProviderLimits,
    pub min_chunk_chars: usize,
    pub per_document_concurrency_max: usize,
    pub system_prompt_max_chars: usize,
}

impl Default for TranslationRuntimeLimits {
    fn default() -> Self {
        Self {
            google: TranslationProviderLimits {
                concurrency_max: GOOGLE_MAX_CONCURRENCY,
                chunk_chars_max: GOOGLE_MAX_CHUNK_CHARS,
                max_segments_per_request_max: GOOGLE_MAX_SEGMENTS_PER_REQUEST,
            },
            deepseek: TranslationProviderLimits {
                concurrency_max: DEEPSEEK_MAX_CONCURRENCY,
                chunk_chars_max: DEEPSEEK_MAX_CHUNK_CHARS,
                max_segments_per_request_max: DEEPSEEK_MAX_SEGMENTS_PER_REQUEST,
            },
            min_chunk_chars: MIN_CHUNK_CHARS,
            per_document_concurrency_max: MAX_PER_DOCUMENT_CONCURRENCY,
            system_prompt_max_chars: MAX_SYSTEM_PROMPT_CHARS,
        }
    }
}

pub async fn load_translation_runtime(
    pool: &PgPool,
    config: &Config,
) -> Result<TranslationRuntimeSettings> {
    let runtime = match get(pool, &config.secret_key, TRANSLATION_RUNTIME).await? {
        Some(value) => serde_json::from_str::<TranslationRuntimeSettings>(&value)
            .context("已保存的翻译运行配置格式无效")?,
        None => TranslationRuntimeSettings::defaults(config),
    };
    runtime.validate().context("已保存的翻译运行配置不合法")?;
    Ok(runtime)
}

/// Capture legacy jobs exactly once; new jobs already snapshot these settings at insertion.
/// Keep this out of `Document` so administrator prompts never appear in public job responses.
pub async fn document_translation_runtime(
    pool: &PgPool,
    config: &Config,
    id: &str,
) -> Result<TranslationRuntimeSettings> {
    let existing = sqlx::query_scalar::<_, Option<serde_json::Value>>(
        "SELECT translation_runtime_snapshot FROM documents WHERE id=$1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?
    .context("读取翻译运行快照时文档不存在")?;
    let snapshot = if let Some(snapshot) = existing {
        snapshot
    } else {
        let runtime = load_translation_runtime(pool, config).await?;
        // COALESCE preserves the winning snapshot if multiple workers arrive concurrently.
        sqlx::query_scalar::<_, serde_json::Value>(
            "UPDATE documents SET translation_runtime_snapshot=COALESCE(translation_runtime_snapshot,$2) \
             WHERE id=$1 RETURNING translation_runtime_snapshot",
        )
        .bind(id)
        .bind(serde_json::to_value(&runtime)?)
        .fetch_optional(pool)
        .await?
        .context("写入翻译运行快照时文档不存在")?
    };
    let runtime = serde_json::from_value::<TranslationRuntimeSettings>(snapshot)
        .context("文档翻译运行快照格式无效")?;
    runtime.validate().context("文档翻译运行快照不合法")?;
    Ok(runtime)
}

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

pub async fn translation_tier(pool: &PgPool, secret_key: &str) -> Result<i16> {
    if let Some(value) = get(pool, secret_key, TRANSLATION_TIER).await?
        && let Ok(tier) = value.parse::<i16>()
        && (1..=3).contains(&tier)
    {
        return Ok(tier);
    }
    Ok(
        if translation_provider(pool, secret_key).await? == "deepseek" {
            2
        } else {
            1
        },
    )
}

pub fn translation_provider_for_tier(tier: i16) -> &'static str {
    if tier <= 1 { "google" } else { "deepseek" }
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
    pub google_configured: bool,
    pub google_api_key_masked: Option<String>,
    pub deepseek_configured: bool,
    pub deepseek_api_key_masked: Option<String>,
    pub deepseek_model: String,
    pub translation_provider: String,
    pub translation_tier: i16,
    pub translation_runtime: TranslationRuntimeSettings,
    pub translation_runtime_defaults: TranslationRuntimeSettings,
    pub translation_runtime_limits: TranslationRuntimeLimits,
    pub r2_configured: bool,
    pub r2_account_id: String,
    pub r2_access_key_id_masked: Option<String>,
    pub r2_secret_access_key_masked: Option<String>,
    pub r2_bucket: String,
    pub r2_public_base_url: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn config() -> Config {
        Config {
            app_name: "test".into(),
            database_url: "postgres://unused".into(),
            database_pool_size: 1,
            secret_key: "unused".into(),
            data_root: "data".into(),
            work_root: "data/work".into(),
            archive_root: "data/archives".into(),
            max_upload_bytes: 1024,
            translation_chunk_chars: 9_000,
            translation_per_document_concurrency: 6,
            translation_queue_capacity: 4_096,
            google_translation_concurrency: 16,
            deepseek_translation_concurrency: 48,
            mineru_poll_seconds: 5,
            mineru_max_wait_seconds: 7_200,
            webp_quality: 86,
            pdf_node_binary: "node".into(),
            pdf_renderer_script: "render.mjs".into(),
            pdf_katex_root: "katex".into(),
            pdf_render_timeout_seconds: 180,
            pdf2zh_python_binary: "unused-python".into(),
            pdf2zh_runner_script: "unused-runner.py".into(),
            pdf2zh_asset_dir: "unused-assets".into(),
            pdf2zh_timeout_seconds: 7_200,
            pdf2zh_concurrency: 1,
            worker_concurrency: 3,
            public_origin: String::new(),
        }
    }

    fn runtime() -> TranslationRuntimeSettings {
        TranslationRuntimeSettings::defaults(&config())
    }

    #[test]
    fn runtime_defaults_preserve_environment_settings_and_existing_prompt() {
        let runtime = runtime();
        assert_eq!(runtime.google.concurrency, 16);
        assert_eq!(runtime.google.chunk_chars, 4_000);
        assert_eq!(runtime.google.max_segments_per_request, 4);
        assert_eq!(runtime.deepseek.concurrency, 48);
        assert_eq!(runtime.deepseek.chunk_chars, 9_000);
        assert_eq!(runtime.deepseek.max_segments_per_request, 4);
        assert_eq!(runtime.per_document_concurrency, 6);
        assert_eq!(runtime.system_prompt, DEFAULT_TRANSLATION_SYSTEM_PROMPT);
        assert!(!runtime.system_prompt.contains("DOCFLOWKEEP"));
        runtime.validate().unwrap();
    }

    #[test]
    fn runtime_defaults_clamp_legacy_values_to_supported_bounds() {
        let mut config = config();
        config.google_translation_concurrency = 0;
        config.deepseek_translation_concurrency = usize::MAX;
        config.translation_chunk_chars = 0;
        config.translation_per_document_concurrency = usize::MAX;
        let low = TranslationRuntimeSettings::defaults(&config);
        assert_eq!(low.google.concurrency, 1);
        assert_eq!(low.deepseek.concurrency, DEEPSEEK_MAX_CONCURRENCY);
        assert_eq!(low.deepseek.chunk_chars, MIN_CHUNK_CHARS);
        assert_eq!(low.per_document_concurrency, MAX_PER_DOCUMENT_CONCURRENCY);
        low.validate().unwrap();
        config.translation_chunk_chars = usize::MAX;
        let high = TranslationRuntimeSettings::defaults(&config);
        assert_eq!(high.deepseek.chunk_chars, DEEPSEEK_MAX_CHUNK_CHARS);
        high.validate().unwrap();
    }

    #[test]
    fn provider_settings_accept_exact_minimum_and_maximum_values() {
        let limits = TranslationRuntimeLimits::default();
        let mut runtime = runtime();
        runtime.google = TranslationProviderSettings {
            concurrency: 1,
            chunk_chars: MIN_CHUNK_CHARS,
            max_segments_per_request: 1,
        };
        runtime.deepseek = runtime.google.clone();
        runtime.per_document_concurrency = 1;
        runtime.validate().unwrap();
        runtime.google = TranslationProviderSettings {
            concurrency: limits.google.concurrency_max,
            chunk_chars: limits.google.chunk_chars_max,
            max_segments_per_request: limits.google.max_segments_per_request_max,
        };
        runtime.deepseek = TranslationProviderSettings {
            concurrency: limits.deepseek.concurrency_max,
            chunk_chars: limits.deepseek.chunk_chars_max,
            max_segments_per_request: limits.deepseek.max_segments_per_request_max,
        };
        runtime.per_document_concurrency = limits.per_document_concurrency_max;
        runtime.validate().unwrap();
    }

    #[test]
    fn provider_settings_reject_out_of_range_values_without_clamping() {
        let limits = TranslationRuntimeLimits::default();
        for (google, provider_limits) in [(true, &limits.google), (false, &limits.deepseek)] {
            for concurrency in [0, provider_limits.concurrency_max + 1] {
                let mut candidate = runtime();
                let provider = if google {
                    &mut candidate.google
                } else {
                    &mut candidate.deepseek
                };
                provider.concurrency = concurrency;
                assert!(candidate.validate().is_err());
            }
            for chunk_chars in [0, MIN_CHUNK_CHARS - 1, provider_limits.chunk_chars_max + 1] {
                let mut candidate = runtime();
                let provider = if google {
                    &mut candidate.google
                } else {
                    &mut candidate.deepseek
                };
                provider.chunk_chars = chunk_chars;
                assert!(candidate.validate().is_err());
            }
            for max_segments_per_request in [0, provider_limits.max_segments_per_request_max + 1] {
                let mut candidate = runtime();
                let provider = if google {
                    &mut candidate.google
                } else {
                    &mut candidate.deepseek
                };
                provider.max_segments_per_request = max_segments_per_request;
                assert!(candidate.validate().is_err());
            }
        }
    }

    #[test]
    fn per_document_concurrency_rejects_zero_and_excessive_values() {
        for concurrency in [0, MAX_PER_DOCUMENT_CONCURRENCY + 1] {
            let mut runtime = runtime();
            runtime.per_document_concurrency = concurrency;
            assert!(runtime.validate().is_err());
        }
    }

    #[test]
    fn prompt_limit_counts_unicode_characters_not_utf8_bytes() {
        let mut runtime = runtime();
        for character in ["a", "译", "📝"] {
            runtime.system_prompt = character.repeat(MAX_SYSTEM_PROMPT_CHARS);
            runtime.validate().unwrap();
            runtime.system_prompt.push('译');
            assert!(runtime.validate().is_err());
        }
    }

    #[test]
    fn prompt_rejects_empty_whitespace_and_nul_but_allows_multiline_text() {
        let mut runtime = runtime();
        for prompt in ["", " \n\t\r　", "翻译\0文本"] {
            runtime.system_prompt = prompt.into();
            assert!(runtime.validate().is_err());
        }
        runtime.system_prompt = "  保持学术文风。\n保留公式与链接。\n".into();
        runtime.validate().unwrap();
        assert!(runtime.system_prompt.starts_with("  "));
    }

    #[test]
    fn runtime_json_round_trips_without_optional_or_unknown_fields() {
        let runtime = runtime();
        let value = serde_json::to_value(&runtime).unwrap();
        assert_eq!(
            serde_json::from_value::<TranslationRuntimeSettings>(value.clone()).unwrap(),
            runtime
        );
        let mut unknown_root = value.clone();
        unknown_root["system_promt"] = json!("typo");
        assert!(serde_json::from_value::<TranslationRuntimeSettings>(unknown_root).is_err());
        for provider in ["google", "deepseek"] {
            let mut unknown_nested = value.clone();
            unknown_nested[provider]["concurency"] = json!(8);
            assert!(serde_json::from_value::<TranslationRuntimeSettings>(unknown_nested).is_err());
            let mut missing_nested = value.clone();
            missing_nested[provider]
                .as_object_mut()
                .unwrap()
                .remove("chunk_chars");
            assert!(serde_json::from_value::<TranslationRuntimeSettings>(missing_nested).is_err());
        }
        for field in [
            "google",
            "deepseek",
            "per_document_concurrency",
            "system_prompt",
        ] {
            let mut missing = value.clone();
            missing.as_object_mut().unwrap().remove(field);
            assert!(serde_json::from_value::<TranslationRuntimeSettings>(missing).is_err());
        }
    }

    #[test]
    fn runtime_json_rejects_negative_fractional_or_non_numeric_counts() {
        for count in [json!(-1), json!(1.5), json!("8"), json!(null), json!(true)] {
            let mut value = serde_json::to_value(runtime()).unwrap();
            value["google"]["concurrency"] = count;
            assert!(serde_json::from_value::<TranslationRuntimeSettings>(value).is_err());
        }
    }

    #[test]
    fn runtime_limits_have_the_documented_admin_api_shape() {
        assert_eq!(
            serde_json::to_value(TranslationRuntimeLimits::default()).unwrap(),
            json!({
                "google": {
                    "concurrency_max": 256,
                    "chunk_chars_max": 4_000,
                    "max_segments_per_request_max": 100
                },
                "deepseek": {
                    "concurrency_max": 2_000,
                    "chunk_chars_max": 12_000,
                    "max_segments_per_request_max": 64
                },
                "min_chunk_chars": 100,
                "per_document_concurrency_max": 32,
                "system_prompt_max_chars": 12_000
            })
        );
    }
}
