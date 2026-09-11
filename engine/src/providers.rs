//! Large-model providers configured by the user, in the spirit of Cherry
//! Studio: presets for common services, an editable API host, keys in the OS
//! keychain (handed to the engine in memory), and a model list fetched from
//! the provider itself.
//!
//! Four wire formats are supported: OpenAI-compatible Chat Completions (most
//! services, including DeepSeek, SiliconFlow, OpenRouter, Ollama …), Azure
//! OpenAI (the same format with an `api-key` header), the Anthropic Messages
//! API and the Gemini `generateContent` API.

use std::{collections::HashSet, time::Duration};

use anyhow::{Context, Result, ensure};
use regex::Regex;
use reqwest::{Client, RequestBuilder, StatusCode, header::RETRY_AFTER};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sqlx::SqlitePool;

use crate::settings;

pub const PROVIDERS_KEY: &str = "providers";
pub const DEFAULT_CONCURRENCY: usize = 100;
pub const MAX_CONCURRENCY: usize = 2_000;
pub const MAX_PROVIDERS: usize = 64;
pub const MAX_MODELS: usize = 500;
/// Anthropic requires an explicit output budget.
pub const ANTHROPIC_DEFAULT_MAX_TOKENS: u32 = 8_192;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderType {
    /// OpenAI-compatible `/chat/completions`.
    Openai,
    /// Azure OpenAI v1 API: OpenAI format with an `api-key` header.
    Azure,
    /// Anthropic Messages API.
    Anthropic,
    /// Google Gemini `generateContent`.
    Gemini,
}

impl ProviderType {
    pub fn label(self) -> &'static str {
        match self {
            Self::Openai => "OpenAI 兼容",
            Self::Azure => "Azure OpenAI",
            Self::Anthropic => "Anthropic",
            Self::Gemini => "Gemini",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelConfig {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderConfig {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: ProviderType,
    pub base_url: String,
    #[serde(default = "enabled_by_default")]
    pub enabled: bool,
    #[serde(default)]
    pub models: Vec<ModelConfig>,
    /// Requests in flight to this provider across all documents.
    #[serde(default = "default_concurrency")]
    pub concurrency: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset: Option<String>,
    /// Extra fields merged into every request body (for example a thinking
    /// switch), like Cherry Studio's custom parameters.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extra_body: Option<Map<String, Value>>,
}

fn enabled_by_default() -> bool {
    true
}

fn default_concurrency() -> usize {
    DEFAULT_CONCURRENCY
}

#[derive(Debug, Clone, Serialize)]
pub struct Preset {
    pub id: &'static str,
    pub name: &'static str,
    #[serde(rename = "type")]
    pub kind: ProviderType,
    pub base_url: &'static str,
    /// Where to create an API key.
    pub key_url: &'static str,
    pub key_optional: bool,
}

const fn preset(
    id: &'static str,
    name: &'static str,
    kind: ProviderType,
    base_url: &'static str,
    key_url: &'static str,
) -> Preset {
    Preset {
        id,
        name,
        kind,
        base_url,
        key_url,
        key_optional: false,
    }
}

pub const PRESETS: &[Preset] = &[
    preset("deepseek", "DeepSeek", ProviderType::Openai, "https://api.deepseek.com/v1", "https://platform.deepseek.com/api_keys"),
    preset("openai", "OpenAI", ProviderType::Openai, "https://api.openai.com/v1", "https://platform.openai.com/api-keys"),
    preset("anthropic", "Anthropic（Claude）", ProviderType::Anthropic, "https://api.anthropic.com", "https://console.anthropic.com/settings/keys"),
    preset("gemini", "Google Gemini", ProviderType::Gemini, "https://generativelanguage.googleapis.com", "https://aistudio.google.com/apikey"),
    preset("openrouter", "OpenRouter", ProviderType::Openai, "https://openrouter.ai/api/v1", "https://openrouter.ai/keys"),
    preset("siliconflow", "硅基流动", ProviderType::Openai, "https://api.siliconflow.cn/v1", "https://cloud.siliconflow.cn/account/ak"),
    preset("dashscope", "阿里云百炼", ProviderType::Openai, "https://dashscope.aliyuncs.com/compatible-mode/v1", "https://bailian.console.aliyun.com/?apiKey=1"),
    preset("volcengine", "火山引擎（豆包）", ProviderType::Openai, "https://ark.cn-beijing.volces.com/api/v3", "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey"),
    preset("moonshot", "月之暗面（Kimi）", ProviderType::Openai, "https://api.moonshot.cn/v1", "https://platform.moonshot.cn/console/api-keys"),
    preset("zhipu", "智谱 AI", ProviderType::Openai, "https://open.bigmodel.cn/api/paas/v4", "https://open.bigmodel.cn/usercenter/apikeys"),
    preset("hunyuan", "腾讯混元", ProviderType::Openai, "https://api.hunyuan.cloud.tencent.com/v1", "https://console.cloud.tencent.com/hunyuan/api-key"),
    preset("stepfun", "阶跃星辰", ProviderType::Openai, "https://api.stepfun.com/v1", "https://platform.stepfun.com/interface-key"),
    preset("lingyi", "零一万物", ProviderType::Openai, "https://api.lingyiwanwu.com/v1", "https://platform.lingyiwanwu.com/apikeys"),
    preset("xai", "xAI（Grok）", ProviderType::Openai, "https://api.x.ai/v1", "https://console.x.ai"),
    preset("groq", "Groq", ProviderType::Openai, "https://api.groq.com/openai/v1", "https://console.groq.com/keys"),
    preset("mistral", "Mistral AI", ProviderType::Openai, "https://api.mistral.ai/v1", "https://console.mistral.ai/api-keys"),
    preset("azure", "Azure OpenAI", ProviderType::Azure, "https://资源名称.openai.azure.com/openai/v1", "https://portal.azure.com"),
    Preset {
        id: "ollama",
        name: "Ollama（本机）",
        kind: ProviderType::Openai,
        base_url: "http://localhost:11434/v1",
        key_url: "",
        key_optional: true,
    },
    Preset {
        id: "lmstudio",
        name: "LM Studio（本机）",
        kind: ProviderType::Openai,
        base_url: "http://localhost:1234/v1",
        key_url: "",
        key_optional: true,
    },
    preset("custom", "自定义（OpenAI 兼容）", ProviderType::Openai, "", ""),
];

/// Lower case only: the id is part of the key name `provider:<id>`, and a
/// host's key-name conversions must not be able to change it.
pub fn validate_id(id: &str) -> Result<()> {
    ensure!(
        !id.is_empty()
            && id.len() <= 64
            && id
                .chars()
                .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || matches!(ch, '-' | '_')),
        "服务商 ID 只能包含小写英文字母、数字、- 和 _"
    );
    Ok(())
}

impl ProviderConfig {
    pub fn validate(&self) -> Result<()> {
        validate_id(&self.id)?;
        ensure!(
            !self.name.trim().is_empty() && self.name.chars().count() <= 64,
            "服务商名称不能为空，且不超过 64 个字符"
        );
        let url = normalize_base_url(&self.base_url);
        ensure!(!url.is_empty(), "请填写 {} 的 API 地址", self.name);
        let parsed = url::Url::parse(&url).with_context(|| format!("{} 的 API 地址格式不正确", self.name))?;
        ensure!(
            matches!(parsed.scheme(), "http" | "https") && parsed.host_str().is_some(),
            "{} 的 API 地址必须以 http:// 或 https:// 开头",
            self.name
        );
        ensure!(
            (1..=MAX_CONCURRENCY).contains(&self.concurrency),
            "{} 的并发请求数必须在 1–{MAX_CONCURRENCY} 之间",
            self.name
        );
        ensure!(self.models.len() <= MAX_MODELS, "每个服务商最多添加 {MAX_MODELS} 个模型");
        let mut seen = HashSet::new();
        for model in &self.models {
            ensure!(
                !model.id.trim().is_empty() && model.id.len() <= 256 && !model.id.contains(['\n', '\r']),
                "模型 ID 不能为空、不能换行，且不超过 256 个字符"
            );
            ensure!(seen.insert(model.id.as_str()), "模型 {} 重复添加", model.id);
        }
        if let Some(extra) = &self.extra_body {
            for key in extra.keys() {
                ensure!(
                    !matches!(key.as_str(), "model" | "messages" | "stream" | "contents" | "system" | "systemInstruction"),
                    "附加请求参数不能覆盖 {key}"
                );
            }
        }
        Ok(())
    }

    /// Local servers (Ollama, LM Studio …) usually need no key.
    pub fn key_optional(&self) -> bool {
        if let Some(preset) = self.preset.as_deref().and_then(find_preset)
            && preset.key_optional
        {
            return true;
        }
        url::Url::parse(&normalize_base_url(&self.base_url))
            .ok()
            .and_then(|url| url.host_str().map(str::to_ascii_lowercase))
            .is_some_and(|host| matches!(host.as_str(), "localhost" | "127.0.0.1" | "::1" | "[::1]"))
    }

    pub fn endpoint(&self) -> Endpoint {
        Endpoint {
            kind: self.kind,
            base_url: normalize_base_url(&self.base_url),
            extra_body: self.extra_body.clone().unwrap_or_default(),
        }
    }

    pub fn model_label(&self, model: &str) -> String {
        let name = self
            .models
            .iter()
            .find(|candidate| candidate.id == model)
            .and_then(|candidate| candidate.name.clone())
            .unwrap_or_else(|| model.to_string());
        format!("{} · {name}", self.name)
    }
}

pub fn find_preset(id: &str) -> Option<&'static Preset> {
    PRESETS.iter().find(|preset| preset.id == id)
}

pub fn normalize_base_url(value: &str) -> String {
    value.trim().trim_end_matches('/').to_string()
}

pub async fn load(pool: &SqlitePool) -> Result<Vec<ProviderConfig>> {
    let Some(value) = settings::get(pool, PROVIDERS_KEY).await? else {
        return Ok(Vec::new());
    };
    // A damaged entry must not hide the others or stop the engine.
    let values: Vec<Value> = serde_json::from_str(&value).context("已保存的服务商配置格式无效")?;
    Ok(values
        .into_iter()
        .filter_map(|value| serde_json::from_value::<ProviderConfig>(value).ok())
        .filter(|provider| provider.validate().is_ok())
        .collect())
}

pub async fn save_all(pool: &SqlitePool, providers: &[ProviderConfig]) -> Result<()> {
    ensure!(providers.len() <= MAX_PROVIDERS, "最多添加 {MAX_PROVIDERS} 个服务商");
    let mut ids = HashSet::new();
    for provider in providers {
        provider.validate()?;
        ensure!(ids.insert(provider.id.as_str()), "服务商 ID {} 重复", provider.id);
    }
    settings::set(pool, PROVIDERS_KEY, &serde_json::to_string(providers)?).await
}

pub async fn upsert(pool: &SqlitePool, mut provider: ProviderConfig) -> Result<Vec<ProviderConfig>> {
    provider.base_url = normalize_base_url(&provider.base_url);
    provider.name = provider.name.trim().to_string();
    for model in &mut provider.models {
        model.id = model.id.trim().to_string();
        model.name = model.name.take().map(|name| name.trim().to_string()).filter(|name| !name.is_empty());
    }
    provider.validate()?;
    let mut providers = load(pool).await?;
    match providers.iter_mut().find(|existing| existing.id == provider.id) {
        Some(existing) => *existing = provider,
        None => providers.push(provider),
    }
    save_all(pool, &providers).await?;
    Ok(providers)
}

pub async fn remove(pool: &SqlitePool, id: &str) -> Result<Vec<ProviderConfig>> {
    let mut providers = load(pool).await?;
    providers.retain(|provider| provider.id != id);
    save_all(pool, &providers).await?;
    Ok(providers)
}

// ---------------------------------------------------------------------------
// Wire protocol

#[derive(Debug, Clone, PartialEq)]
pub struct Endpoint {
    pub kind: ProviderType,
    pub base_url: String,
    pub extra_body: Map<String, Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorKind {
    /// Network trouble or a temporary server problem: retry later.
    Transient,
    /// HTTP 429 and friends: retry later with fewer requests in flight.
    RateLimited,
    /// The request was too large for the model: split it.
    Oversized,
    /// The reply was truncated, malformed or incomplete: split or repair.
    Output,
    /// The provider declined this content (safety filter): split or keep.
    Refused,
    /// The provider rejected this particular request.
    Rejected,
    /// This key is wrong, blocked or out of balance: another key may work.
    Credential,
    /// Missing model, wrong address …: stop the document.
    Fatal,
}

#[derive(Debug, Clone)]
pub struct ProviderError {
    pub kind: ErrorKind,
    pub message: String,
    pub retry_after: Option<Duration>,
}

impl ProviderError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            retry_after: None,
        }
    }

    pub fn retryable(&self) -> bool {
        matches!(self.kind, ErrorKind::Transient | ErrorKind::RateLimited)
    }
}

impl std::fmt::Display for ProviderError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ProviderError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Finish {
    Complete,
    Truncated,
    Refused,
}

#[derive(Debug, Clone)]
pub struct ChatReply {
    pub text: String,
    pub finish: Finish,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
}

pub struct ChatRequest<'a> {
    pub model: &'a str,
    pub system: &'a str,
    pub user: &'a str,
    pub max_tokens: Option<u32>,
}

fn join(base: &str, path: &str) -> String {
    format!("{}/{}", base.trim_end_matches('/'), path.trim_start_matches('/'))
}

/// `https://api.anthropic.com` or `…/v1` both work.
fn versioned(base: &str, version: &str, path: &str) -> String {
    if base.ends_with(&format!("/{version}")) {
        join(base, path)
    } else {
        join(&join(base, version), path)
    }
}

pub fn chat_url(endpoint: &Endpoint, model: &str) -> String {
    match endpoint.kind {
        ProviderType::Openai | ProviderType::Azure => join(&endpoint.base_url, "chat/completions"),
        ProviderType::Anthropic => versioned(&endpoint.base_url, "v1", "messages"),
        ProviderType::Gemini => {
            let base = if endpoint.base_url.ends_with("/v1") || endpoint.base_url.ends_with("/v1beta") {
                endpoint.base_url.clone()
            } else {
                join(&endpoint.base_url, "v1beta")
            };
            join(&base, &format!("models/{}:generateContent", model.trim_start_matches("models/")))
        }
    }
}

pub fn models_url(endpoint: &Endpoint) -> String {
    match endpoint.kind {
        ProviderType::Openai | ProviderType::Azure => join(&endpoint.base_url, "models"),
        ProviderType::Anthropic => versioned(&endpoint.base_url, "v1", "models"),
        ProviderType::Gemini => {
            if endpoint.base_url.ends_with("/v1") || endpoint.base_url.ends_with("/v1beta") {
                join(&endpoint.base_url, "models")
            } else {
                join(&endpoint.base_url, "v1beta/models")
            }
        }
    }
}

fn authorize(request: RequestBuilder, kind: ProviderType, key: Option<&str>) -> RequestBuilder {
    let request = match kind {
        ProviderType::Anthropic => request.header("anthropic-version", "2023-06-01"),
        _ => request,
    };
    let Some(key) = key.filter(|key| !key.is_empty()) else {
        return request;
    };
    match kind {
        ProviderType::Openai => request.bearer_auth(key),
        ProviderType::Azure => request.header("api-key", key),
        ProviderType::Anthropic => request.header("x-api-key", key),
        ProviderType::Gemini => request.header("x-goog-api-key", key),
    }
}

pub fn chat_body(endpoint: &Endpoint, request: &ChatRequest<'_>) -> Value {
    let mut body = match endpoint.kind {
        ProviderType::Openai | ProviderType::Azure => {
            let mut body = json!({
                "model": request.model,
                "messages": [
                    {"role": "system", "content": request.system},
                    {"role": "user", "content": request.user}
                ],
                "stream": false
            });
            if let Some(max_tokens) = request.max_tokens {
                body["max_tokens"] = json!(max_tokens);
            }
            body
        }
        ProviderType::Anthropic => json!({
            "model": request.model,
            "max_tokens": request.max_tokens.unwrap_or(ANTHROPIC_DEFAULT_MAX_TOKENS),
            "system": request.system,
            "messages": [{"role": "user", "content": request.user}]
        }),
        ProviderType::Gemini => {
            let mut body = json!({
                "systemInstruction": {"parts": [{"text": request.system}]},
                "contents": [{"role": "user", "parts": [{"text": request.user}]}]
            });
            if let Some(max_tokens) = request.max_tokens {
                body["generationConfig"] = json!({"maxOutputTokens": max_tokens});
            }
            body
        }
    };
    if let Some(object) = body.as_object_mut() {
        for (key, value) in &endpoint.extra_body {
            merge(object, key, value.clone());
        }
    }
    body
}

/// Objects merge recursively, so `generationConfig` extras keep the
/// engine's own `maxOutputTokens`.
fn merge(object: &mut Map<String, Value>, key: &str, value: Value) {
    match (object.get_mut(key), value) {
        (Some(Value::Object(existing)), Value::Object(extra)) => {
            for (key, value) in extra {
                merge(existing, &key, value);
            }
        }
        (_, value) => {
            object.insert(key.to_string(), value);
        }
    }
}

pub async fn chat(
    client: &Client,
    endpoint: &Endpoint,
    key: Option<&str>,
    request: &ChatRequest<'_>,
    provider_name: &str,
) -> Result<ChatReply, ProviderError> {
    let body = chat_body(endpoint, request);
    let response = authorize(client.post(chat_url(endpoint, request.model)), endpoint.kind, key)
        .json(&body)
        .send()
        .await
        .map_err(|error| network_error(provider_name, error))?;
    let status = response.status();
    let retry_after = retry_after(&response);
    let raw = response
        .text()
        .await
        .map_err(|error| network_error(provider_name, error))?;
    let raw = redact(&raw, key);
    if !status.is_success() {
        let mut error = classify_http(provider_name, status, &raw, request.model);
        error.retry_after = retry_after.or(error.retry_after);
        return Err(error);
    }
    let value: Value = serde_json::from_str(&raw).map_err(|_| {
        ProviderError::new(
            ErrorKind::Output,
            format!("{provider_name} 返回了无法解析的内容：{}", snippet(&raw)),
        )
    })?;
    parse_chat(endpoint.kind, &value, provider_name, request.model)
}

pub fn parse_chat(
    kind: ProviderType,
    value: &Value,
    provider_name: &str,
    model: &str,
) -> Result<ChatReply, ProviderError> {
    if let Some(error) = value.get("error").filter(|error| !error.is_null()) {
        // Some gateways answer HTTP 200 with an error object.
        let message = error["message"].as_str().or(error.as_str()).unwrap_or("未知错误");
        let code = error["code"].to_string() + error["type"].as_str().unwrap_or("");
        return Err(classify_message(provider_name, &format!("{code} {message}"), model));
    }
    let (text, finish, input_tokens, output_tokens) = match kind {
        ProviderType::Openai | ProviderType::Azure => {
            let choice = &value["choices"][0];
            let content = &choice["message"]["content"];
            let text = match content {
                Value::String(text) => text.clone(),
                Value::Array(parts) => parts
                    .iter()
                    .filter_map(|part| part["text"].as_str())
                    .collect::<Vec<_>>()
                    .join(""),
                _ => String::new(),
            };
            let finish = match choice["finish_reason"].as_str().unwrap_or("stop") {
                "length" | "max_tokens" | "model_length" => Finish::Truncated,
                "content_filter" | "safety" | "sensitive" | "refusal" => Finish::Refused,
                _ => Finish::Complete,
            };
            if text.trim().is_empty() && choice["message"]["refusal"].is_string() {
                (String::new(), Finish::Refused, None, None)
            } else {
                (
                    text,
                    finish,
                    value["usage"]["prompt_tokens"].as_u64(),
                    value["usage"]["completion_tokens"].as_u64(),
                )
            }
        }
        ProviderType::Anthropic => {
            let text = value["content"]
                .as_array()
                .map(|blocks| {
                    blocks
                        .iter()
                        .filter(|block| block["type"] == "text")
                        .filter_map(|block| block["text"].as_str())
                        .collect::<Vec<_>>()
                        .join("")
                })
                .unwrap_or_default();
            let finish = match value["stop_reason"].as_str().unwrap_or("end_turn") {
                "max_tokens" => Finish::Truncated,
                "refusal" => Finish::Refused,
                _ => Finish::Complete,
            };
            (
                text,
                finish,
                value["usage"]["input_tokens"].as_u64(),
                value["usage"]["output_tokens"].as_u64(),
            )
        }
        ProviderType::Gemini => {
            if value["promptFeedback"]["blockReason"].is_string() {
                return Ok(ChatReply {
                    text: String::new(),
                    finish: Finish::Refused,
                    input_tokens: None,
                    output_tokens: None,
                });
            }
            let candidate = &value["candidates"][0];
            let text = candidate["content"]["parts"]
                .as_array()
                .map(|parts| {
                    parts
                        .iter()
                        .filter(|part| part["thought"] != true)
                        .filter_map(|part| part["text"].as_str())
                        .collect::<Vec<_>>()
                        .join("")
                })
                .unwrap_or_default();
            let finish = match candidate["finishReason"].as_str().unwrap_or("STOP") {
                "MAX_TOKENS" => Finish::Truncated,
                "SAFETY" | "RECITATION" | "BLOCKLIST" | "PROHIBITED_CONTENT" | "SPII" | "IMAGE_SAFETY" => {
                    Finish::Refused
                }
                _ => Finish::Complete,
            };
            (
                text,
                finish,
                value["usageMetadata"]["promptTokenCount"].as_u64(),
                value["usageMetadata"]["candidatesTokenCount"].as_u64(),
            )
        }
    };
    Ok(ChatReply {
        text: strip_reasoning(&text),
        finish,
        input_tokens,
        output_tokens,
    })
}

/// Local reasoning models (Qwen3, R1 distills …) put their thinking inline.
pub fn strip_reasoning(text: &str) -> String {
    let pattern = Regex::new(r"(?s)^\s*<think(?:ing)?>.*?</think(?:ing)?>\s*").expect("static regex");
    pattern.replace(text, "").into_owned()
}

pub fn classify_http(provider: &str, status: StatusCode, body: &str, model: &str) -> ProviderError {
    let detail = extract_error_message(body);
    let lower = detail.to_ascii_lowercase();
    let code = status.as_u16();
    let message = |text: String| format!("{provider}：{text}（HTTP {code}）");
    let kind = match code {
        401 => return ProviderError::new(ErrorKind::Credential, message(format!("API Key 无效或已过期。{detail}"))),
        402 => return ProviderError::new(ErrorKind::Credential, message(format!("账户余额不足或需要付费。{detail}"))),
        403 if lower.contains("rate") && lower.contains("limit") => ErrorKind::RateLimited,
        403 => {
            return ProviderError::new(
                ErrorKind::Credential,
                message(format!("没有访问权限（Key 无效、账户受限或所在地区不受支持）。{detail}")),
            );
        }
        404 => {
            return ProviderError::new(
                ErrorKind::Fatal,
                message(format!("找不到模型 {model} 或接口地址不正确，请检查 API 地址和模型 ID。{detail}")),
            );
        }
        408 | 409 | 425 | 500 | 502 | 503 | 504 | 520..=529 => ErrorKind::Transient,
        429 => {
            if lower.contains("insufficient") || lower.contains("exceeded your current quota") {
                return ProviderError::new(ErrorKind::Credential, message(format!("配额或余额已用尽。{detail}")));
            }
            ErrorKind::RateLimited
        }
        413 => ErrorKind::Oversized,
        400 | 422 => return classify_message(provider, &format!("HTTP {code} {detail}"), model),
        _ => ErrorKind::Rejected,
    };
    let mut error = ProviderError::new(kind, message(detail));
    if kind == ErrorKind::RateLimited {
        error.retry_after = Some(Duration::from_secs(5));
    }
    error
}

fn classify_message(provider: &str, message: &str, model: &str) -> ProviderError {
    let lower = message.to_ascii_lowercase();
    let text = format!("{provider}：{}", snippet(message));
    if ["context_length", "context length", "maximum context", "too many tokens", "too long", "reduce the length", "exceeds the maximum", "input is too large"]
        .iter()
        .any(|marker| lower.contains(marker))
    {
        return ProviderError::new(ErrorKind::Oversized, text);
    }
    if ["content_filter", "content filter", "data_inspection", "sensitive", "safety", "inappropriate", "content management policy", "moderation"]
        .iter()
        .any(|marker| lower.contains(marker))
    {
        return ProviderError::new(ErrorKind::Refused, text);
    }
    if ["invalid api key", "invalid_api_key", "incorrect api key", "authentication", "unauthorized", "api key not valid"]
        .iter()
        .any(|marker| lower.contains(marker))
    {
        return ProviderError::new(ErrorKind::Credential, format!("{text}（API Key 无效）"));
    }
    if ["model_not_found", "model not found", "does not exist", "no such model", "unknown model", "not supported model", "invalid model"]
        .iter()
        .any(|marker| lower.contains(marker))
    {
        return ProviderError::new(ErrorKind::Fatal, format!("{text}（模型 {model} 不可用）"));
    }
    if lower.contains("rate limit") || lower.contains("rate_limit") || lower.contains("too many requests") {
        let mut error = ProviderError::new(ErrorKind::RateLimited, text);
        error.retry_after = Some(Duration::from_secs(5));
        return error;
    }
    if lower.contains("insufficient") && (lower.contains("balance") || lower.contains("quota") || lower.contains("credit")) {
        return ProviderError::new(ErrorKind::Credential, format!("{text}（余额或配额不足）"));
    }
    ProviderError::new(ErrorKind::Rejected, text)
}

fn extract_error_message(body: &str) -> String {
    if let Ok(value) = serde_json::from_str::<Value>(body) {
        for candidate in [
            &value["error"]["message"],
            &value["error"],
            &value["message"],
            &value["detail"],
            &value[0]["error"]["message"],
        ] {
            if let Some(text) = candidate.as_str().filter(|text| !text.trim().is_empty()) {
                return snippet(text);
            }
        }
    }
    snippet(body)
}

pub fn snippet(text: &str) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut value: String = flat.chars().take(400).collect();
    if flat.chars().count() > 400 {
        value.push('…');
    }
    value
}

pub fn redact(text: &str, key: Option<&str>) -> String {
    match key.filter(|key| key.len() >= 6) {
        Some(key) => text.replace(key, "[redacted]"),
        None => text.to_string(),
    }
}

pub fn network_error(provider: &str, error: reqwest::Error) -> ProviderError {
    let (timeout, connect) = (error.is_timeout(), error.is_connect());
    let detail = error.without_url().to_string();
    let hint = if timeout {
        "请求超时"
    } else if connect {
        "无法连接（请检查网络、代理设置或 API 地址）"
    } else {
        "网络错误"
    };
    ProviderError::new(ErrorKind::Transient, format!("{provider}：{hint}：{detail}"))
}

pub fn retry_after(response: &reqwest::Response) -> Option<Duration> {
    response
        .headers()
        .get(RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<f64>().ok())
        .filter(|seconds| seconds.is_finite() && *seconds >= 0.0)
        .map(|seconds| Duration::from_secs_f64(seconds.min(300.0)))
}

// ---------------------------------------------------------------------------
// Model lists and checks

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RemoteModel {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_length: Option<u64>,
}

pub async fn list_models(
    client: &Client,
    endpoint: &Endpoint,
    key: Option<&str>,
    provider_name: &str,
) -> Result<Vec<RemoteModel>> {
    let mut models = Vec::new();
    let mut page_token: Option<String> = None;
    for _ in 0..20 {
        let mut request = authorize(client.get(models_url(endpoint)), endpoint.kind, key);
        request = match endpoint.kind {
            ProviderType::Anthropic => {
                let mut query = vec![("limit", "1000".to_string())];
                if let Some(after) = &page_token {
                    query.push(("after_id", after.clone()));
                }
                request.query(&query)
            }
            ProviderType::Gemini => {
                let mut query = vec![("pageSize", "1000".to_string())];
                if let Some(token) = &page_token {
                    query.push(("pageToken", token.clone()));
                }
                request.query(&query)
            }
            _ => request,
        };
        let response = request
            .send()
            .await
            .map_err(|error| anyhow::anyhow!(network_error(provider_name, error).message))?;
        let status = response.status();
        let raw = redact(&response.text().await.unwrap_or_default(), key);
        if !status.is_success() {
            let error = classify_http(provider_name, status, &raw, "");
            anyhow::bail!(if status == StatusCode::NOT_FOUND || status == StatusCode::METHOD_NOT_ALLOWED {
                format!("{provider_name} 不支持获取模型列表（HTTP {status}），请手动添加模型 ID")
            } else {
                error.message
            });
        }
        let value: Value = serde_json::from_str(&raw)
            .with_context(|| format!("{provider_name} 返回的模型列表无法解析：{}", snippet(&raw)))?;
        let (page, next) = parse_models(endpoint.kind, &value);
        models.extend(page);
        match next {
            Some(token) if !token.is_empty() => page_token = Some(token),
            _ => break,
        }
    }
    let mut seen = HashSet::new();
    models.retain(|model| seen.insert(model.id.clone()));
    models.sort_by(|a, b| a.id.to_lowercase().cmp(&b.id.to_lowercase()));
    Ok(models)
}

pub fn parse_models(kind: ProviderType, value: &Value) -> (Vec<RemoteModel>, Option<String>) {
    match kind {
        ProviderType::Openai | ProviderType::Azure => {
            let list = value["data"]
                .as_array()
                .or_else(|| value["models"].as_array())
                .or_else(|| value.as_array())
                .cloned()
                .unwrap_or_default();
            let models = list
                .iter()
                .filter_map(|item| {
                    let id = item["id"].as_str().or_else(|| item["name"].as_str())?.trim();
                    (!id.is_empty()).then(|| RemoteModel {
                        id: id.to_string(),
                        name: item["name"].as_str().filter(|name| *name != id).map(str::to_string),
                        owner: item["owned_by"].as_str().map(str::to_string),
                        context_length: item["context_length"].as_u64(),
                    })
                })
                .collect();
            (models, None)
        }
        ProviderType::Anthropic => {
            let models = value["data"]
                .as_array()
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| {
                            Some(RemoteModel {
                                id: item["id"].as_str()?.to_string(),
                                name: item["display_name"].as_str().map(str::to_string),
                                owner: Some("Anthropic".into()),
                                context_length: None,
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            let next = (value["has_more"] == true)
                .then(|| value["last_id"].as_str().map(str::to_string))
                .flatten();
            (models, next)
        }
        ProviderType::Gemini => {
            let models = value["models"]
                .as_array()
                .map(|items| {
                    items
                        .iter()
                        .filter(|item| {
                            item["supportedGenerationMethods"]
                                .as_array()
                                .is_none_or(|methods| methods.iter().any(|method| method == "generateContent"))
                        })
                        .filter_map(|item| {
                            let id = item["name"].as_str()?.trim_start_matches("models/").to_string();
                            Some(RemoteModel {
                                id,
                                name: item["displayName"].as_str().map(str::to_string),
                                owner: Some("Google".into()),
                                context_length: item["inputTokenLimit"].as_u64(),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            (models, value["nextPageToken"].as_str().map(str::to_string))
        }
    }
}

#[derive(Debug, Serialize)]
pub struct CheckResult {
    pub ok: bool,
    pub latency_ms: u128,
    pub reply: String,
}

pub async fn check(
    client: &Client,
    endpoint: &Endpoint,
    key: Option<&str>,
    model: &str,
    provider_name: &str,
) -> Result<CheckResult> {
    let started = std::time::Instant::now();
    let reply = chat(
        client,
        endpoint,
        key,
        &ChatRequest {
            model,
            system: "你是翻译引擎。把用户输入翻译成简体中文，只输出译文。",
            user: "Hello, world.",
            max_tokens: match endpoint.kind {
                ProviderType::Anthropic => Some(256),
                _ => None,
            },
        },
        provider_name,
    )
    .await
    .map_err(|error| anyhow::anyhow!(error.message))?;
    ensure!(
        !reply.text.trim().is_empty() || reply.finish == Finish::Truncated,
        "{provider_name} 的模型 {model} 没有返回内容"
    );
    Ok(CheckResult {
        ok: true,
        latency_ms: started.elapsed().as_millis(),
        reply: snippet(reply.text.trim()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn endpoint(kind: ProviderType, base: &str) -> Endpoint {
        Endpoint {
            kind,
            base_url: normalize_base_url(base),
            extra_body: Map::new(),
        }
    }

    #[test]
    fn urls_follow_each_provider_convention() {
        assert_eq!(
            chat_url(&endpoint(ProviderType::Openai, "https://api.deepseek.com/v1/"), "m"),
            "https://api.deepseek.com/v1/chat/completions"
        );
        assert_eq!(models_url(&endpoint(ProviderType::Openai, "http://localhost:11434/v1")), "http://localhost:11434/v1/models");
        assert_eq!(chat_url(&endpoint(ProviderType::Anthropic, "https://api.anthropic.com"), "m"), "https://api.anthropic.com/v1/messages");
        assert_eq!(chat_url(&endpoint(ProviderType::Anthropic, "https://proxy.example/v1"), "m"), "https://proxy.example/v1/messages");
        assert_eq!(
            chat_url(&endpoint(ProviderType::Gemini, "https://generativelanguage.googleapis.com"), "models/gemini-x"),
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-x:generateContent"
        );
        assert_eq!(
            models_url(&endpoint(ProviderType::Gemini, "https://generativelanguage.googleapis.com/v1beta")),
            "https://generativelanguage.googleapis.com/v1beta/models"
        );
    }

    #[test]
    fn request_bodies_match_each_api_and_merge_extras() {
        let mut openai = endpoint(ProviderType::Openai, "https://x/v1");
        openai.extra_body.insert("thinking".into(), json!({"type": "disabled"}));
        let body = chat_body(&openai, &ChatRequest { model: "m", system: "s", user: "u", max_tokens: None });
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["thinking"]["type"], "disabled");
        assert!(body.get("max_tokens").is_none());

        let anthropic = chat_body(
            &endpoint(ProviderType::Anthropic, "https://x"),
            &ChatRequest { model: "c", system: "s", user: "u", max_tokens: None },
        );
        assert_eq!(anthropic["max_tokens"], ANTHROPIC_DEFAULT_MAX_TOKENS);
        assert_eq!(anthropic["system"], "s");

        let mut gemini = endpoint(ProviderType::Gemini, "https://x");
        gemini.extra_body.insert("generationConfig".into(), json!({"thinkingConfig": {"thinkingBudget": 0}}));
        let body = chat_body(&gemini, &ChatRequest { model: "g", system: "s", user: "u", max_tokens: Some(100) });
        assert_eq!(body["generationConfig"]["maxOutputTokens"], 100);
        assert_eq!(body["generationConfig"]["thinkingConfig"]["thinkingBudget"], 0);
        assert_eq!(body["contents"][0]["parts"][0]["text"], "u");
    }

    #[test]
    fn replies_report_truncation_refusal_and_strip_reasoning() {
        let reply = parse_chat(
            ProviderType::Openai,
            &json!({"choices": [{"message": {"content": "<think>hmm</think>\n译文"}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 3, "completion_tokens": 4}}),
            "P",
            "m",
        )
        .unwrap();
        assert_eq!(reply.text, "译文");
        assert_eq!(reply.finish, Finish::Complete);
        assert_eq!(reply.output_tokens, Some(4));
        let truncated = parse_chat(ProviderType::Openai, &json!({"choices": [{"message": {"content": "半"}, "finish_reason": "length"}]}), "P", "m").unwrap();
        assert_eq!(truncated.finish, Finish::Truncated);
        let anthropic = parse_chat(
            ProviderType::Anthropic,
            &json!({"content": [{"type": "thinking", "thinking": "x"}, {"type": "text", "text": "好"}], "stop_reason": "max_tokens"}),
            "A",
            "c",
        )
        .unwrap();
        assert_eq!((anthropic.text.as_str(), anthropic.finish), ("好", Finish::Truncated));
        let gemini = parse_chat(
            ProviderType::Gemini,
            &json!({"candidates": [{"content": {"parts": [{"text": "想", "thought": true}, {"text": "译"}]}, "finishReason": "SAFETY"}]}),
            "G",
            "g",
        )
        .unwrap();
        assert_eq!((gemini.text.as_str(), gemini.finish), ("译", Finish::Refused));
        let blocked = parse_chat(ProviderType::Gemini, &json!({"promptFeedback": {"blockReason": "SAFETY"}}), "G", "g").unwrap();
        assert_eq!(blocked.finish, Finish::Refused);
        let error = parse_chat(ProviderType::Openai, &json!({"error": {"message": "Model not found: x"}}), "P", "x").unwrap_err();
        assert_eq!(error.kind, ErrorKind::Fatal);
    }

    #[test]
    fn http_errors_are_classified_for_retry_split_or_stop() {
        let kind = |status: u16, body: &str| classify_http("P", StatusCode::from_u16(status).unwrap(), body, "m").kind;
        assert_eq!(kind(401, ""), ErrorKind::Credential);
        assert_eq!(kind(402, ""), ErrorKind::Credential);
        assert_eq!(kind(403, "forbidden"), ErrorKind::Credential);
        assert_eq!(kind(404, ""), ErrorKind::Fatal);
        assert_eq!(kind(429, r#"{"error":{"message":"Rate limit reached"}}"#), ErrorKind::RateLimited);
        assert_eq!(kind(429, r#"{"error":{"message":"You exceeded your current quota, insufficient_quota"}}"#), ErrorKind::Credential);
        assert_eq!(kind(503, "busy"), ErrorKind::Transient);
        assert_eq!(kind(529, "overloaded"), ErrorKind::Transient);
        assert_eq!(kind(400, r#"{"error":{"message":"This model's maximum context length is 8192 tokens"}}"#), ErrorKind::Oversized);
        assert_eq!(kind(400, r#"{"error":{"code":"data_inspection_failed","message":"Input data may contain inappropriate content."}}"#), ErrorKind::Refused);
        assert_eq!(kind(400, r#"{"error":{"message":"Invalid API key provided"}}"#), ErrorKind::Credential);
        assert_eq!(kind(400, r#"{"error":{"message":"API key not valid. Please pass a valid API key."}}"#), ErrorKind::Credential);
        assert_eq!(kind(400, r#"{"error":{"message":"Unsupported parameter: temperature"}}"#), ErrorKind::Rejected);
        assert!(classify_http("P", StatusCode::UNAUTHORIZED, "sk-secret", "m").message.contains("API Key"));
    }

    #[test]
    fn model_lists_parse_for_every_api() {
        let (openai, next) = parse_models(
            ProviderType::Openai,
            &json!({"data": [{"id": "deepseek-chat", "owned_by": "deepseek"}, {"id": "x", "name": "X Model", "context_length": 128000}]}),
        );
        assert_eq!(openai.len(), 2);
        assert_eq!(openai[1].context_length, Some(128_000));
        assert!(next.is_none());
        let (anthropic, next) = parse_models(
            ProviderType::Anthropic,
            &json!({"data": [{"id": "claude-x", "display_name": "Claude X"}], "has_more": true, "last_id": "claude-x"}),
        );
        assert_eq!(anthropic[0].name.as_deref(), Some("Claude X"));
        assert_eq!(next.as_deref(), Some("claude-x"));
        let (gemini, next) = parse_models(
            ProviderType::Gemini,
            &json!({"models": [
                {"name": "models/gemini-2.5-flash", "displayName": "Gemini 2.5 Flash", "supportedGenerationMethods": ["generateContent"]},
                {"name": "models/embedding-001", "supportedGenerationMethods": ["embedContent"]}
            ], "nextPageToken": "t"}),
        );
        assert_eq!(gemini.len(), 1);
        assert_eq!(gemini[0].id, "gemini-2.5-flash");
        assert_eq!(next.as_deref(), Some("t"));
    }

    #[test]
    fn provider_validation_and_local_keys() {
        let mut provider = ProviderConfig {
            id: "ollama".into(),
            name: "Ollama".into(),
            kind: ProviderType::Openai,
            base_url: "http://localhost:11434/v1/".into(),
            enabled: true,
            models: vec![ModelConfig { id: "qwen3".into(), name: None }],
            concurrency: DEFAULT_CONCURRENCY,
            preset: None,
            extra_body: None,
        };
        provider.validate().unwrap();
        assert!(provider.key_optional());
        assert_eq!(provider.endpoint().base_url, "http://localhost:11434/v1");
        provider.base_url = "https://api.example.com/v1".into();
        assert!(!provider.key_optional());
        provider.models.push(ModelConfig { id: "qwen3".into(), name: None });
        assert!(provider.validate().is_err());
        provider.models.pop();
        provider.concurrency = 0;
        assert!(provider.validate().is_err());
        provider.concurrency = 100;
        provider.extra_body = Some(serde_json::from_value(json!({"messages": []})).unwrap());
        assert!(provider.validate().is_err());
        assert!(validate_id("bad id").is_err());
        assert!(validate_id("MyGateway").is_err());
        assert!(validate_id("my-gateway_2").is_ok());
        assert_eq!(provider.model_label("qwen3"), "Ollama · qwen3");
    }

    #[test]
    fn retry_after_and_redaction() {
        assert_eq!(redact("key sk-123456 leaked", Some("sk-123456")), "key [redacted] leaked");
        assert_eq!(snippet(&"a ".repeat(500)).chars().count(), 401);
    }
}
