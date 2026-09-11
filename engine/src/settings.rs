use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::{http::ProxySettings, now};

pub const MINERU_MODEL: &str = "mineru_model";
pub const DEFAULT_TRANSLATOR: &str = "default_translator";
pub const DEFAULT_MODE: &str = "default_mode";
pub const TRANSLATION_RUNTIME: &str = "translation_runtime_v2";
pub const PROXY: &str = "proxy";
pub const WORKER_CONCURRENCY: &str = "worker_concurrency";

pub const MIN_CHUNK_CHARS: usize = 100;
/// Google's free endpoint: requests in flight (it rate-limits bursts).
pub const GOOGLE_DEFAULT_CONCURRENCY: usize = 8;
pub const GOOGLE_MAX_CONCURRENCY: usize = 64;
pub const GOOGLE_DEFAULT_CHUNK_CHARS: usize = 3_000;
pub const GOOGLE_MAX_CHUNK_CHARS: usize = 5_000;
pub const LLM_DEFAULT_CHUNK_CHARS: usize = 4_000;
pub const LLM_MAX_CHUNK_CHARS: usize = 32_000;
pub const LLM_DEFAULT_SEGMENTS_PER_REQUEST: usize = 8;
pub const LLM_MAX_SEGMENTS_PER_REQUEST: usize = 64;
pub const LLM_DEFAULT_REQUEST_CHARS: usize = 8_000;
pub const LLM_MIN_REQUEST_CHARS: usize = 500;
pub const LLM_MAX_REQUEST_CHARS: usize = 100_000;
pub const LLM_MAX_OUTPUT_TOKENS: u32 = 1_000_000;
pub const DEFAULT_PER_DOCUMENT_CONCURRENCY: usize = 100;
pub const MAX_PER_DOCUMENT_CONCURRENCY: usize = 1_000;
pub const MAX_SYSTEM_PROMPT_CHARS: usize = 12_000;
pub const MAX_WORKER_CONCURRENCY: usize = 4;
pub const DEFAULT_TRANSLATION_SYSTEM_PROMPT: &str = "你是严谨的学术文献译者。把用户提供的内容准确、流畅地翻译成简体中文：术语统一，保留原有的段落、标题、列表、表格和换行结构；不合并、不遗漏、不解释，不添加原文没有的内容。";

/// What translates a document. Captured on the document when it is queued.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum TranslatorChoice {
    /// Google Translate's free web endpoint; no key.
    Google,
    /// A model of a configured large-model provider.
    Llm { provider_id: String, model: String },
}

impl Default for TranslatorChoice {
    fn default() -> Self {
        Self::Google
    }
}

impl TranslatorChoice {
    pub fn validate(&self) -> Result<()> {
        if let Self::Llm { provider_id, model } = self {
            crate::providers::validate_id(provider_id)?;
            ensure!(
                !model.trim().is_empty() && model.len() <= 256,
                "请选择要使用的模型"
            );
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct GoogleRuntime {
    pub concurrency: usize,
    pub chunk_chars: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct LlmRuntime {
    /// Longest piece of text treated as one segment.
    pub chunk_chars: usize,
    /// Segments combined into one request.
    pub max_segments_per_request: usize,
    /// Characters of source text in one request.
    pub max_request_chars: usize,
    /// 0 = let the provider decide (Anthropic then uses 8192).
    pub max_output_tokens: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TranslationRuntimeSettings {
    pub google: GoogleRuntime,
    pub llm: LlmRuntime,
    /// Requests one document keeps in flight at most.
    pub per_document_concurrency: usize,
    pub system_prompt: String,
}

impl Default for TranslationRuntimeSettings {
    fn default() -> Self {
        Self {
            google: GoogleRuntime {
                concurrency: GOOGLE_DEFAULT_CONCURRENCY,
                chunk_chars: GOOGLE_DEFAULT_CHUNK_CHARS,
            },
            llm: LlmRuntime {
                chunk_chars: LLM_DEFAULT_CHUNK_CHARS,
                max_segments_per_request: LLM_DEFAULT_SEGMENTS_PER_REQUEST,
                max_request_chars: LLM_DEFAULT_REQUEST_CHARS,
                max_output_tokens: 0,
            },
            per_document_concurrency: DEFAULT_PER_DOCUMENT_CONCURRENCY,
            system_prompt: DEFAULT_TRANSLATION_SYSTEM_PROMPT.to_owned(),
        }
    }
}

impl TranslationRuntimeSettings {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            (1..=GOOGLE_MAX_CONCURRENCY).contains(&self.google.concurrency),
            "Google 翻译并发数必须在 1–{GOOGLE_MAX_CONCURRENCY} 之间"
        );
        ensure!(
            (MIN_CHUNK_CHARS..=GOOGLE_MAX_CHUNK_CHARS).contains(&self.google.chunk_chars),
            "Google 翻译每段最多字符数必须在 {MIN_CHUNK_CHARS}–{GOOGLE_MAX_CHUNK_CHARS} 之间"
        );
        ensure!(
            (MIN_CHUNK_CHARS..=LLM_MAX_CHUNK_CHARS).contains(&self.llm.chunk_chars),
            "大模型每段最多字符数必须在 {MIN_CHUNK_CHARS}–{LLM_MAX_CHUNK_CHARS} 之间"
        );
        ensure!(
            (1..=LLM_MAX_SEGMENTS_PER_REQUEST).contains(&self.llm.max_segments_per_request),
            "大模型单次请求最多段数必须在 1–{LLM_MAX_SEGMENTS_PER_REQUEST} 之间"
        );
        ensure!(
            (LLM_MIN_REQUEST_CHARS..=LLM_MAX_REQUEST_CHARS).contains(&self.llm.max_request_chars),
            "大模型单次请求最多字符数必须在 {LLM_MIN_REQUEST_CHARS}–{LLM_MAX_REQUEST_CHARS} 之间"
        );
        ensure!(
            self.llm.max_output_tokens <= LLM_MAX_OUTPUT_TOKENS,
            "最大输出 tokens 不能超过 {LLM_MAX_OUTPUT_TOKENS}"
        );
        ensure!(
            (1..=MAX_PER_DOCUMENT_CONCURRENCY).contains(&self.per_document_concurrency),
            "单个文档最多同时请求数必须在 1–{MAX_PER_DOCUMENT_CONCURRENCY} 之间"
        );
        ensure!(!self.system_prompt.trim().is_empty(), "翻译提示词不能为空");
        ensure!(
            self.system_prompt.chars().count() <= MAX_SYSTEM_PROMPT_CHARS,
            "翻译提示词不能超过 {MAX_SYSTEM_PROMPT_CHARS} 个字符"
        );
        ensure!(!self.system_prompt.contains('\0'), "翻译提示词不能包含空字符");
        Ok(())
    }
}

/// Bounds shown next to the settings fields.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct TranslationRuntimeLimits {
    pub min_chunk_chars: usize,
    pub google_concurrency_max: usize,
    pub google_chunk_chars_max: usize,
    pub llm_chunk_chars_max: usize,
    pub llm_segments_per_request_max: usize,
    pub llm_request_chars_min: usize,
    pub llm_request_chars_max: usize,
    pub llm_output_tokens_max: u32,
    pub per_document_concurrency_max: usize,
    pub provider_concurrency_max: usize,
    pub system_prompt_max_chars: usize,
}

impl Default for TranslationRuntimeLimits {
    fn default() -> Self {
        Self {
            min_chunk_chars: MIN_CHUNK_CHARS,
            google_concurrency_max: GOOGLE_MAX_CONCURRENCY,
            google_chunk_chars_max: GOOGLE_MAX_CHUNK_CHARS,
            llm_chunk_chars_max: LLM_MAX_CHUNK_CHARS,
            llm_segments_per_request_max: LLM_MAX_SEGMENTS_PER_REQUEST,
            llm_request_chars_min: LLM_MIN_REQUEST_CHARS,
            llm_request_chars_max: LLM_MAX_REQUEST_CHARS,
            llm_output_tokens_max: LLM_MAX_OUTPUT_TOKENS,
            per_document_concurrency_max: MAX_PER_DOCUMENT_CONCURRENCY,
            provider_concurrency_max: crate::providers::MAX_CONCURRENCY,
            system_prompt_max_chars: MAX_SYSTEM_PROMPT_CHARS,
        }
    }
}

pub async fn load_translation_runtime(pool: &SqlitePool) -> Result<TranslationRuntimeSettings> {
    let runtime = match get(pool, TRANSLATION_RUNTIME).await? {
        // A value from an older version falls back to the defaults.
        Some(value) => serde_json::from_str::<TranslationRuntimeSettings>(&value)
            .ok()
            .filter(|runtime| runtime.validate().is_ok())
            .unwrap_or_default(),
        None => TranslationRuntimeSettings::default(),
    };
    Ok(runtime)
}

/// Each job keeps the runtime settings from the moment it was queued, so a
/// later settings change never alters work that is already in progress.
pub async fn document_translation_runtime(
    pool: &SqlitePool,
    id: &str,
) -> Result<TranslationRuntimeSettings> {
    let existing = sqlx::query_scalar::<_, Option<String>>(
        "SELECT translation_runtime_snapshot FROM documents WHERE id=$1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?
    .context("读取翻译运行快照时文档不存在")?;
    if let Some(runtime) = existing
        .as_deref()
        .and_then(|snapshot| serde_json::from_str::<TranslationRuntimeSettings>(snapshot).ok())
        .filter(|runtime| runtime.validate().is_ok())
    {
        return Ok(runtime);
    }
    let runtime = load_translation_runtime(pool).await?;
    sqlx::query("UPDATE documents SET translation_runtime_snapshot=$2 WHERE id=$1")
        .bind(id)
        .bind(serde_json::to_string(&runtime)?)
        .execute(pool)
        .await?;
    Ok(runtime)
}

pub async fn get(pool: &SqlitePool, key: &str) -> Result<Option<String>> {
    Ok(
        sqlx::query_scalar::<_, String>("SELECT value FROM app_settings WHERE key = $1")
            .bind(key)
            .fetch_optional(pool)
            .await?,
    )
}

pub async fn set(pool: &SqlitePool, key: &str, value: &str) -> Result<()> {
    sqlx::query(concat!(
        "INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, ",
        now!(),
        ") ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    ))
    .bind(key)
    .bind(value)
    .execute(pool)
    .await?;
    Ok(())
}

/// Desktop preferences that are not provider credentials.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Preferences {
    /// MinerU parsing model: `vlm` or `pipeline`.
    pub mineru_model: String,
    /// Preselected in "新建翻译".
    pub default_translator: TranslatorChoice,
    /// `mineru` or `pdf2zh`.
    pub default_mode: String,
    pub proxy: ProxySettings,
    /// Documents processed at the same time.
    pub worker_concurrency: usize,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            mineru_model: "vlm".into(),
            default_translator: TranslatorChoice::Google,
            default_mode: "pdf2zh".into(),
            proxy: ProxySettings::System,
            worker_concurrency: 2,
        }
    }
}

impl Preferences {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            ["vlm", "pipeline"].contains(&self.mineru_model.as_str()),
            "MinerU 模型只能是 vlm 或 pipeline"
        );
        self.default_translator.validate()?;
        ensure!(
            ["mineru", "pdf2zh"].contains(&self.default_mode.as_str()),
            "默认处理方式只能是 mineru 或 pdf2zh"
        );
        ensure!(
            (1..=MAX_WORKER_CONCURRENCY).contains(&self.worker_concurrency),
            "同时处理的文档数必须在 1–{MAX_WORKER_CONCURRENCY} 之间"
        );
        self.proxy.validate()
    }
}

pub async fn load_preferences(pool: &SqlitePool) -> Result<Preferences> {
    let defaults = Preferences::default();
    let proxy = match get(pool, PROXY).await? {
        Some(value) => serde_json::from_str(&value).unwrap_or_default(),
        None => defaults.proxy.clone(),
    };
    Ok(Preferences {
        mineru_model: get(pool, MINERU_MODEL)
            .await?
            .filter(|value| ["vlm", "pipeline"].contains(&value.as_str()))
            .unwrap_or(defaults.mineru_model),
        default_translator: get(pool, DEFAULT_TRANSLATOR)
            .await?
            .and_then(|value| serde_json::from_str::<TranslatorChoice>(&value).ok())
            .filter(|choice| choice.validate().is_ok())
            .unwrap_or(defaults.default_translator),
        default_mode: get(pool, DEFAULT_MODE)
            .await?
            .filter(|value| ["mineru", "pdf2zh"].contains(&value.as_str()))
            .unwrap_or(defaults.default_mode),
        proxy,
        worker_concurrency: get(pool, WORKER_CONCURRENCY)
            .await?
            .and_then(|value| value.parse().ok())
            .filter(|value| (1..=MAX_WORKER_CONCURRENCY).contains(value))
            .unwrap_or(defaults.worker_concurrency),
    })
}

pub async fn save_preferences(pool: &SqlitePool, preferences: &Preferences) -> Result<()> {
    preferences.validate()?;
    set(pool, MINERU_MODEL, &preferences.mineru_model).await?;
    set(
        pool,
        DEFAULT_TRANSLATOR,
        &serde_json::to_string(&preferences.default_translator)?,
    )
    .await?;
    set(pool, DEFAULT_MODE, &preferences.default_mode).await?;
    set(pool, PROXY, &serde_json::to_string(&preferences.proxy)?).await?;
    set(
        pool,
        WORKER_CONCURRENCY,
        &preferences.worker_concurrency.to_string(),
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn preferences_persist_and_fall_back_to_defaults() {
        let pool = crate::db::open_memory().await;
        assert_eq!(load_preferences(&pool).await.unwrap(), Preferences::default());
        let changed = Preferences {
            mineru_model: "pipeline".into(),
            default_translator: TranslatorChoice::Llm {
                provider_id: "deepseek".into(),
                model: "deepseek-chat".into(),
            },
            default_mode: "mineru".into(),
            proxy: ProxySettings::Custom {
                url: "socks5://127.0.0.1:1080".into(),
            },
            worker_concurrency: 4,
        };
        save_preferences(&pool, &changed).await.unwrap();
        assert_eq!(load_preferences(&pool).await.unwrap(), changed);
        let mut invalid = changed.clone();
        invalid.worker_concurrency = 0;
        assert!(save_preferences(&pool, &invalid).await.is_err());
        set(&pool, DEFAULT_TRANSLATOR, "{\"kind\":\"llm\"}").await.unwrap();
        assert_eq!(
            load_preferences(&pool).await.unwrap().default_translator,
            TranslatorChoice::Google
        );
    }

    #[tokio::test]
    async fn runtime_settings_round_trip_and_ignore_older_formats() {
        let pool = crate::db::open_memory().await;
        let mut runtime = TranslationRuntimeSettings::default();
        assert_eq!(load_translation_runtime(&pool).await.unwrap(), runtime);
        runtime.system_prompt = "保留术语。".into();
        runtime.llm.max_segments_per_request = 12;
        set(&pool, TRANSLATION_RUNTIME, &serde_json::to_string(&runtime).unwrap())
            .await
            .unwrap();
        assert_eq!(load_translation_runtime(&pool).await.unwrap(), runtime);
        set(&pool, TRANSLATION_RUNTIME, "{\"google\":{\"concurrency\":1}}").await.unwrap();
        assert_eq!(
            load_translation_runtime(&pool).await.unwrap(),
            TranslationRuntimeSettings::default()
        );
    }

    #[test]
    fn defaults_use_one_hundred_requests_for_large_models() {
        let runtime = TranslationRuntimeSettings::default();
        assert_eq!(runtime.per_document_concurrency, 100);
        assert_eq!(crate::providers::DEFAULT_CONCURRENCY, 100);
        assert_eq!(runtime.google.concurrency, GOOGLE_DEFAULT_CONCURRENCY);
        runtime.validate().unwrap();
    }

    #[test]
    fn runtime_bounds_are_inclusive_and_enforced() {
        let limits = TranslationRuntimeLimits::default();
        let mut runtime = TranslationRuntimeSettings::default();
        runtime.google = GoogleRuntime { concurrency: 1, chunk_chars: MIN_CHUNK_CHARS };
        runtime.llm = LlmRuntime {
            chunk_chars: MIN_CHUNK_CHARS,
            max_segments_per_request: 1,
            max_request_chars: LLM_MIN_REQUEST_CHARS,
            max_output_tokens: 0,
        };
        runtime.per_document_concurrency = 1;
        runtime.validate().unwrap();
        runtime.google = GoogleRuntime {
            concurrency: limits.google_concurrency_max,
            chunk_chars: limits.google_chunk_chars_max,
        };
        runtime.llm = LlmRuntime {
            chunk_chars: limits.llm_chunk_chars_max,
            max_segments_per_request: limits.llm_segments_per_request_max,
            max_request_chars: limits.llm_request_chars_max,
            max_output_tokens: limits.llm_output_tokens_max,
        };
        runtime.per_document_concurrency = limits.per_document_concurrency_max;
        runtime.validate().unwrap();
        let mutations: [fn(&mut TranslationRuntimeSettings); 8] = [
            |runtime: &mut TranslationRuntimeSettings| runtime.google.concurrency = 0,
            |runtime: &mut TranslationRuntimeSettings| runtime.google.chunk_chars = GOOGLE_MAX_CHUNK_CHARS + 1,
            |runtime: &mut TranslationRuntimeSettings| runtime.llm.chunk_chars = MIN_CHUNK_CHARS - 1,
            |runtime: &mut TranslationRuntimeSettings| runtime.llm.max_segments_per_request = 0,
            |runtime: &mut TranslationRuntimeSettings| runtime.llm.max_request_chars = LLM_MAX_REQUEST_CHARS + 1,
            |runtime: &mut TranslationRuntimeSettings| runtime.per_document_concurrency = 0,
            |runtime: &mut TranslationRuntimeSettings| runtime.system_prompt = " \n".into(),
            |runtime: &mut TranslationRuntimeSettings| runtime.system_prompt = "译".repeat(MAX_SYSTEM_PROMPT_CHARS + 1),
        ];
        for mutate in mutations {
            let mut candidate = TranslationRuntimeSettings::default();
            mutate(&mut candidate);
            assert!(candidate.validate().is_err());
        }
    }

    #[test]
    fn runtime_json_rejects_unknown_or_missing_fields() {
        let value = serde_json::to_value(TranslationRuntimeSettings::default()).unwrap();
        let mut unknown = value.clone();
        unknown["llm"]["concurency"] = json!(8);
        assert!(serde_json::from_value::<TranslationRuntimeSettings>(unknown).is_err());
        let mut missing = value.clone();
        missing.as_object_mut().unwrap().remove("system_prompt");
        assert!(serde_json::from_value::<TranslationRuntimeSettings>(missing).is_err());
    }

    #[test]
    fn translator_choice_has_a_tagged_json_form() {
        assert_eq!(serde_json::to_value(TranslatorChoice::Google).unwrap(), json!({"kind": "google"}));
        let llm: TranslatorChoice =
            serde_json::from_value(json!({"kind": "llm", "provider_id": "siliconflow", "model": "Qwen/Qwen3"})).unwrap();
        llm.validate().unwrap();
        assert!(
            TranslatorChoice::Llm { provider_id: "x".into(), model: " ".into() }
                .validate()
                .is_err()
        );
    }
}
