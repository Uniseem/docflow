//! Newline-delimited JSON-RPC over stdin/stdout.
//!
//! Host → engine: `{"id": 1, "method": "documents.list", "params": {...}}`
//! Engine → host: `{"id": 1, "result": ...}` or
//!                `{"id": 1, "error": {"code": "...", "message": "..."}}`
//! Engine → host notifications (no id): `{"method": "event", "params": ...}`,
//! `document.changed`, `document.removed`.
//!
//! stdout carries protocol lines only; logs go to a file. The engine exits
//! when stdin closes, so it can never outlive its host.

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use anyhow::Result;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Map, Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::mpsc,
};

use crate::{
    library::{self, CreateInput, EventsInput, ListInput, UserError},
    providers::{self, Endpoint, ProviderConfig, ProviderType},
    secrets,
    settings::{self, Preferences, TranslationRuntimeLimits, TranslationRuntimeSettings},
    state::AppState,
    verify, worker,
};

pub const PROTOCOL_VERSION: u32 = 3;
const MAX_REQUEST_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Deserialize)]
struct Request {
    #[serde(default)]
    id: Option<Value>,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Serialize)]
struct RpcError {
    code: &'static str,
    message: String,
}

impl RpcError {
    fn invalid(message: impl Into<String>) -> Self {
        Self {
            code: "invalid_params",
            message: message.into(),
        }
    }

    fn user(message: impl Into<String>) -> Self {
        Self {
            code: "user_error",
            message: message.into(),
        }
    }
}

impl From<anyhow::Error> for RpcError {
    fn from(error: anyhow::Error) -> Self {
        if let Some(user) = error.downcast_ref::<UserError>() {
            return Self::user(user.0.clone());
        }
        let message = format!("{error:#}");
        Self {
            code: "failed",
            message: message.chars().take(1_500).collect(),
        }
    }
}

type RpcResult = std::result::Result<Value, RpcError>;

pub struct Server {
    state: Arc<AppState>,
    started: AtomicBool,
    shutdown: tokio::sync::Notify,
}

/// Serves requests until stdin closes or the host asks the engine to stop.
pub async fn serve(
    state: Arc<AppState>,
    outgoing: mpsc::UnboundedSender<String>,
    mut lines: mpsc::UnboundedReceiver<String>,
) -> Result<()> {
    // The notification sink keeps a sender alive for the whole process, so
    // the writer is told explicitly when to drain the queue and stop.
    let (stop, mut stopped) = tokio::sync::oneshot::channel::<()>();
    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        loop {
            let line = tokio::select! {
                biased;
                line = lines.recv() => line,
                _ = &mut stopped => {
                    while let Ok(line) = lines.try_recv() {
                        let _ = stdout.write_all(format!("{line}\n").as_bytes()).await;
                    }
                    let _ = stdout.flush().await;
                    break;
                }
            };
            let Some(line) = line else {
                break;
            };
            if stdout.write_all(line.as_bytes()).await.is_err()
                || stdout.write_all(b"\n").await.is_err()
                || stdout.flush().await.is_err()
            {
                break;
            }
        }
    });
    let server = Arc::new(Server {
        state,
        started: AtomicBool::new(false),
        shutdown: tokio::sync::Notify::new(),
    });
    let mut stdin = BufReader::new(tokio::io::stdin());
    let mut buffer = Vec::new();
    loop {
        buffer.clear();
        let read = tokio::select! {
            read = stdin.read_until(b'\n', &mut buffer) => read?,
            _ = server.shutdown.notified() => break,
        };
        if read == 0 {
            tracing::info!("host closed stdin; stopping");
            break;
        }
        if buffer.len() > MAX_REQUEST_BYTES {
            tracing::warn!(bytes = buffer.len(), "oversized request ignored");
            continue;
        }
        let line = String::from_utf8_lossy(&buffer).trim().to_string();
        if line.is_empty() {
            continue;
        }
        let server = server.clone();
        let outgoing = outgoing.clone();
        tokio::spawn(async move {
            if let Some(response) = server.handle(&line).await {
                let _ = outgoing.send(response);
            }
        });
    }
    drop(outgoing);
    // Give in-flight handlers (such as the engine.shutdown reply) a moment to
    // queue their responses, then drain and stop the writer.
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let _ = stop.send(());
    let _ = tokio::time::timeout(std::time::Duration::from_secs(1), writer).await;
    Ok(())
}

impl Server {
    async fn handle(self: &Arc<Self>, line: &str) -> Option<String> {
        let request = match serde_json::from_str::<Request>(line) {
            Ok(request) => request,
            Err(error) => {
                return Some(
                    json!({"id": null, "error": {"code": "parse_error", "message": error.to_string()}})
                        .to_string(),
                );
            }
        };
        let id = request.id.clone();
        let result = self.dispatch(&request.method, request.params).await;
        let id = id?;
        Some(
            match result {
                Ok(value) => json!({"id": id, "result": value}),
                Err(error) => json!({"id": id, "error": error}),
            }
            .to_string(),
        )
    }

    async fn dispatch(self: &Arc<Self>, method: &str, params: Value) -> RpcResult {
        let state = &self.state;
        match method {
            "engine.initialize" => {
                let input: InitializeInput = parse(params)?;
                for (name, value) in input.secrets {
                    secrets::validate_name(&name).map_err(|error| RpcError::invalid(error.to_string()))?;
                    state.secrets.set(&name, value);
                }
                if !self.started.swap(true, Ordering::SeqCst) {
                    tokio::spawn(worker::run(state.clone()));
                }
                Ok(json!({
                    "protocol": PROTOCOL_VERSION,
                    "version": env!("CARGO_PKG_VERSION"),
                    "data_dir": state.config.data_root,
                    "resources_dir": state.config.resources_root,
                    "settings": settings_view(state).await?,
                }))
            }
            "engine.shutdown" => {
                self.shutdown.notify_one();
                Ok(json!({}))
            }
            "settings.get" => view_value(settings_view(state).await?),
            "settings.update" => {
                let input: SettingsUpdate = parse(params)?;
                if let Some(preferences) = input.preferences {
                    settings::save_preferences(&state.pool, &preferences)
                        .await
                        .map_err(|error| RpcError::invalid(format!("{error:#}")))?;
                    apply_preferences(state, &preferences)?;
                }
                if let Some(runtime) = input.translation_runtime {
                    runtime
                        .validate()
                        .map_err(|error| RpcError::invalid(format!("{error:#}")))?;
                    settings::set(
                        &state.pool,
                        settings::TRANSLATION_RUNTIME,
                        &serde_json::to_string(&runtime).map_err(anyhow::Error::from)?,
                    )
                    .await?;
                }
                view_value(settings_view(state).await?)
            }
            "secrets.set" => {
                let input: SecretInput = parse(params)?;
                secrets::validate_name(&input.name).map_err(|error| RpcError::invalid(error.to_string()))?;
                state.secrets.set(&input.name, input.value);
                if let (Some(pools), Some(provider)) = (&state.translation_pools, input.name.strip_prefix("provider:")) {
                    pools.reset_keys(provider);
                }
                view_value(settings_view(state).await?)
            }
            "secrets.verify" => {
                let input: SecretInput = parse(params)?;
                if input.name != secrets::MINERU {
                    return Err(RpcError::invalid("只能验证 MinerU 的 API Key"));
                }
                let value = input
                    .value
                    .filter(|value| !value.trim().is_empty())
                    .ok_or_else(|| RpcError::invalid("请输入 API Key"))?;
                verify::mineru(&state.network, &value)
                    .await
                    .map_err(|error| RpcError::user(format!("{error:#}")))?;
                Ok(json!({"ok": true}))
            }
            "providers.save" => {
                let input: ProviderInput = parse(params)?;
                let mut provider = input.provider;
                if let Some(text) = &input.extra_body_json {
                    provider.extra_body = parse_extra_body(text)?;
                }
                let saved = providers::upsert(&state.pool, provider)
                    .await
                    .map_err(|error| RpcError::user(format!("{error:#}")))?;
                if let Some(pools) = &state.translation_pools {
                    pools.configure_providers(&saved);
                }
                view_value(settings_view(state).await?)
            }
            "providers.delete" => {
                let input: IdInput = parse(params)?;
                providers::remove(&state.pool, &input.id).await?;
                state.secrets.set(&secrets::provider_secret(&input.id), None);
                view_value(settings_view(state).await?)
            }
            "providers.models" => {
                let input: EndpointInput = parse(params)?;
                let (endpoint, key, name) = input.resolve(state)?;
                let models = verify::models(&state.network, &endpoint, key.as_deref(), &name)
                    .await
                    .map_err(|error| RpcError::user(format!("{error:#}")))?;
                Ok(json!({"models": models}))
            }
            "providers.check" => {
                let input: EndpointInput = parse(params)?;
                let model = input
                    .model
                    .clone()
                    .filter(|model| !model.trim().is_empty())
                    .ok_or_else(|| RpcError::invalid("请选择一个模型用于检查"))?;
                let (endpoint, key, name) = input.resolve(state)?;
                let result = verify::provider(&state.network, &endpoint, key.as_deref(), &model, &name)
                    .await
                    .map_err(|error| RpcError::user(format!("{error:#}")))?;
                view_value(result)
            }
            "documents.create" => {
                let input: CreateInput = parse(params)?;
                view(state, library::create(state, input).await?)
            }
            "documents.list" => {
                let input: ListInput = if params.is_null() { ListInput::default() } else { parse(params)? };
                view_value(library::list(state, input).await?)
            }
            "documents.get" => {
                let input: IdInput = parse(params)?;
                view(state, library::get(state, &input.id).await?)
            }
            "documents.events" => {
                let input: EventsInput = parse(params)?;
                view_value(library::events(state, input).await?)
            }
            "documents.rename" => {
                let input: RenameInput = parse(params)?;
                view(state, library::rename(state, &input.id, &input.title).await?)
            }
            "documents.retry" => {
                let input: IdInput = parse(params)?;
                view(state, library::retry(state, &input.id).await?)
            }
            "documents.cancel" => {
                let input: IdInput = parse(params)?;
                view(state, library::cancel(state, &input.id).await?)
            }
            "documents.delete" => {
                let input: IdInput = parse(params)?;
                library::delete(state, &input.id).await?;
                Ok(json!({"deleted": true}))
            }
            "documents.exportBundle" => {
                let input: ExportInput = parse(params)?;
                let bytes = library::export_bundle(state, &input.id, &input.destination).await?;
                Ok(json!({"path": input.destination, "bytes": bytes}))
            }
            other => Err(RpcError {
                code: "method_not_found",
                message: format!("未知方法：{other}"),
            }),
        }
    }
}

fn parse<T: DeserializeOwned>(params: Value) -> std::result::Result<T, RpcError> {
    serde_json::from_value(params).map_err(|error| RpcError::invalid(format!("参数格式不正确：{error}")))
}

fn view_value(value: impl Serialize) -> RpcResult {
    Ok(serde_json::to_value(value).map_err(anyhow::Error::from)?)
}

fn view(state: &AppState, view: crate::models::DocumentView) -> RpcResult {
    let names = library::suggested_names(&view.document);
    let mut value = serde_json::to_value(view).map_err(anyhow::Error::from)?;
    value["suggested_names"] = serde_json::to_value(names).map_err(anyhow::Error::from)?;
    value["running"] = json!(state.is_running(value["id"].as_str().unwrap_or_default()));
    Ok(value)
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct InitializeInput {
    #[serde(default)]
    secrets: HashMap<String, Option<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SettingsUpdate {
    #[serde(default)]
    preferences: Option<Preferences>,
    #[serde(default)]
    translation_runtime: Option<TranslationRuntimeSettings>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SecretInput {
    name: String,
    #[serde(default)]
    value: Option<String>,
}

/// Extra request fields may also travel as JSON text: a host whose encoder
/// rewrites object keys (Swift's snake_case strategy) would otherwise turn
/// `generationConfig` into `generation_config`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProviderInput {
    provider: ProviderConfig,
    #[serde(default)]
    extra_body_json: Option<String>,
}

/// Blank text clears the extra fields; anything else must be a JSON object.
fn parse_extra_body(text: &str) -> std::result::Result<Option<Map<String, Value>>, RpcError> {
    if text.trim().is_empty() {
        return Ok(None);
    }
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Object(map)) => Ok((!map.is_empty()).then_some(map)),
        Ok(_) => Err(RpcError::user("附加请求参数必须是 JSON 对象，例如 {\"temperature\": 0.3}")),
        Err(error) => Err(RpcError::user(format!("附加请求参数不是有效的 JSON：{error}"))),
    }
}

/// A provider endpoint to check, possibly not saved yet. Without `api_key`
/// the key stored for `provider_id` is used.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct EndpointInput {
    #[serde(default)]
    provider_id: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(rename = "type")]
    kind: ProviderType,
    base_url: String,
    #[serde(default)]
    api_key: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    extra_body: Option<Map<String, Value>>,
    #[serde(default)]
    extra_body_json: Option<String>,
}

impl EndpointInput {
    fn resolve(&self, state: &AppState) -> std::result::Result<(Endpoint, Option<String>, String), RpcError> {
        let extra_body = match &self.extra_body_json {
            Some(text) => parse_extra_body(text)?.unwrap_or_default(),
            None => self.extra_body.clone().unwrap_or_default(),
        };
        let base_url = providers::normalize_base_url(&self.base_url);
        let parsed = url::Url::parse(&base_url).map_err(|_| RpcError::user("API 地址格式不正确"))?;
        if !matches!(parsed.scheme(), "http" | "https") {
            return Err(RpcError::user("API 地址必须以 http:// 或 https:// 开头"));
        }
        let key = self
            .api_key
            .as_deref()
            .map(secrets::split_keys)
            .and_then(|keys| keys.into_iter().next())
            .or_else(|| {
                self.provider_id
                    .as_deref()
                    .and_then(|id| state.secrets.keys(&secrets::provider_secret(id)).into_iter().next())
            });
        let name = self
            .name
            .clone()
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| self.kind.label().to_string());
        Ok((
            Endpoint {
                kind: self.kind,
                base_url,
                extra_body,
            },
            key,
            name,
        ))
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct IdInput {
    id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RenameInput {
    id: String,
    title: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExportInput {
    id: String,
    destination: PathBuf,
}

pub fn apply_preferences(state: &AppState, preferences: &Preferences) -> Result<()> {
    state.network.set_proxy(preferences.proxy.clone());
    if let Some(pools) = &state.translation_pools {
        pools.set_proxy(&preferences.proxy)?;
    }
    state.set_worker_limit(preferences.worker_concurrency);
    Ok(())
}

#[derive(Debug, Serialize)]
struct SecretStatus {
    configured: bool,
    masked: Option<String>,
}

#[derive(Debug, Serialize)]
struct ProviderView {
    #[serde(flatten)]
    config: ProviderConfig,
    /// `extra_body` as indented JSON text (see `ProviderInput`).
    extra_body_json: String,
    key_configured: bool,
    key_masked: Option<String>,
    key_optional: bool,
    key_url: Option<&'static str>,
}

#[derive(Debug, Serialize)]
struct Capabilities {
    mineru_ready: bool,
    pdf2zh_ready: bool,
    pdf2zh_issue: Option<String>,
    /// At least one enabled provider with a model and a key.
    llm_ready: bool,
    fake_providers: bool,
    max_upload_mb: u64,
    mineru_extensions: &'static [&'static str],
    pdf2zh_extensions: &'static [&'static str],
}

#[derive(Debug, Serialize)]
struct SettingsView {
    preferences: Preferences,
    translation_runtime: TranslationRuntimeSettings,
    translation_runtime_defaults: TranslationRuntimeSettings,
    translation_runtime_limits: TranslationRuntimeLimits,
    providers: Vec<ProviderView>,
    provider_presets: &'static [providers::Preset],
    mineru: SecretStatus,
    capabilities: Capabilities,
    data_dir: PathBuf,
    engine_version: &'static str,
}

async fn settings_view(state: &AppState) -> Result<SettingsView> {
    let fake = state.config.fake_providers;
    let providers = providers::load(&state.pool)
        .await?
        .into_iter()
        .map(|config| {
            let name = secrets::provider_secret(&config.id);
            ProviderView {
                extra_body_json: config
                    .extra_body
                    .as_ref()
                    .filter(|extra| !extra.is_empty())
                    .and_then(|extra| serde_json::to_string_pretty(extra).ok())
                    .unwrap_or_default(),
                key_configured: state.secrets.configured(&name),
                key_masked: state.secrets.masked(&name),
                key_optional: config.key_optional(),
                key_url: config
                    .preset
                    .as_deref()
                    .and_then(providers::find_preset)
                    .map(|preset| preset.key_url)
                    .filter(|url| !url.is_empty()),
                config,
            }
        })
        .collect::<Vec<_>>();
    let llm_ready = providers.iter().any(|provider| {
        provider.config.enabled
            && !provider.config.models.is_empty()
            && (fake || provider.key_configured || provider.key_optional)
    });
    Ok(SettingsView {
        preferences: settings::load_preferences(&state.pool).await?,
        translation_runtime: settings::load_translation_runtime(&state.pool).await?,
        translation_runtime_defaults: TranslationRuntimeSettings::default(),
        translation_runtime_limits: TranslationRuntimeLimits::default(),
        providers,
        provider_presets: providers::PRESETS,
        mineru: SecretStatus {
            configured: state.secrets.configured(secrets::MINERU),
            masked: state.secrets.masked(secrets::MINERU),
        },
        capabilities: Capabilities {
            mineru_ready: state.secrets.configured(secrets::MINERU) || state.config.fake_mineru_zip.is_some(),
            pdf2zh_ready: state.config.pdf2zh_available(),
            pdf2zh_issue: pdf2zh_issue(state),
            llm_ready,
            fake_providers: fake,
            max_upload_mb: state.config.max_upload_mb(),
            mineru_extensions: library::MINERU_EXTENSIONS,
            pdf2zh_extensions: library::PDF2ZH_EXTENSIONS,
        },
        data_dir: state.config.data_root.clone(),
        engine_version: env!("CARGO_PKG_VERSION"),
    })
}

fn pdf2zh_issue(state: &AppState) -> Option<String> {
    let config = &state.config;
    if !config.pdf2zh_python_binary.is_file() {
        return Some(format!(
            "未找到内置 Python 运行时：{}",
            config.pdf2zh_python_binary.display()
        ));
    }
    if !config.pdf2zh_asset_dir.join(".ready").is_file() {
        return Some(format!(
            "BabelDOC 离线资源不完整：{}",
            config.pdf2zh_asset_dir.display()
        ));
    }
    if !config.pdf2zh_runner_script.is_file() {
        return Some("PDF 原生翻译适配脚本缺失".into());
    }
    // Non-ASCII folders are worked around through %ProgramData%\DocFlow on
    // Windows; anywhere else they block BabelDOC.
    let fallback = crate::config::ascii_fallback_root().is_some();
    for (path, what) in [
        (&config.native_work_root, "文档库"),
        (&config.pdf2zh_asset_dir, "应用安装目录"),
    ] {
        if !crate::config::is_ascii_path(path) && !fallback {
            return Some(format!(
                "{what}路径包含非英文字符（{}），BabelDOC 需要纯英文路径",
                path.display()
            ));
        }
    }
    None
}
