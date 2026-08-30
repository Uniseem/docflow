use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::Arc,
    time::{Duration, Instant},
};

use anyhow::{Context, Result};
use reqwest::{Client, StatusCode, header::RETRY_AFTER};
use serde_json::{Value, json};
use tokio::{
    sync::{Mutex, mpsc, oneshot, watch},
    task::JoinSet,
};

use crate::{config::Config, settings::TranslationRuntimeSettings};

pub const DEEPSEEK_MODEL_ID: &str = "deepseek-v4-flash";
const GOOGLE_ENDPOINT: &str = "https://translation.googleapis.com/language/translate/v2";
const DEEPSEEK_ENDPOINT: &str = "https://api.deepseek.com/chat/completions";
const GOOGLE_SAFE_CHARS_PER_MINUTE: usize = 4_800_000;
const GOOGLE_SAFE_REQUESTS_PER_MINUTE: usize = 240_000;
pub const GOOGLE_SAFE_REQUEST_BYTES: usize = 80_000;
pub const DEEPSEEK_SAFE_BATCH_CHARS: usize = 32_000;
pub const DEEPSEEK_SAFE_CONTEXT_TOKENS: usize = 800_000;
pub const DEEPSEEK_SAFE_OUTPUT_TOKENS: u32 = 307_200;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderKind {
    Google,
    DeepSeek,
}

impl ProviderKind {
    pub fn label(self) -> &'static str {
        match self {
            Self::Google => "Google Cloud Translation",
            Self::DeepSeek => "DeepSeek V4 Flash",
        }
    }
}

#[derive(Debug, Clone)]
pub enum PoolRequest {
    Google {
        api_key: String,
        contents: Vec<String>,
    },
    DeepSeek {
        api_key: String,
        system: String,
        user: String,
        thinking: bool,
        max_tokens: u32,
        user_id: String,
        segment_ids: Option<Vec<usize>>,
    },
}

impl PoolRequest {
    fn provider(&self) -> ProviderKind {
        match self {
            Self::Google { .. } => ProviderKind::Google,
            Self::DeepSeek { .. } => ProviderKind::DeepSeek,
        }
    }

    fn input_chars(&self) -> usize {
        match self {
            Self::Google { contents, .. } => contents.iter().map(|text| text.chars().count()).sum(),
            Self::DeepSeek { system, user, .. } => system.chars().count() + user.chars().count(),
        }
    }

    pub fn validate_size(&self) -> Result<(), ProviderError> {
        let valid = match self {
            Self::Google { contents, .. } => {
                !contents.is_empty()
                    && contents.len() <= 100
                    && serde_json::to_vec(&google_body(contents))
                        .is_ok_and(|body| body.len() <= GOOGLE_SAFE_REQUEST_BYTES)
            }
            Self::DeepSeek {
                system,
                user,
                max_tokens,
                segment_ids,
                ..
            } => {
                *max_tokens > 0
                    && !system.trim().is_empty() && !user.trim().is_empty()
                    && segment_ids.as_ref().is_none_or(|ids| !ids.is_empty() && ids.len() <= 64
                        && ids.iter().collect::<HashSet<_>>().len() == ids.len())
                    && *max_tokens <= DEEPSEEK_SAFE_OUTPUT_TOKENS
                    // UTF-8 bytes are a deliberately conservative token estimate,
                    // not a claim that characters and tokens are equivalent.
                    && system.len() + user.len() + *max_tokens as usize + 1_024
                        <= DEEPSEEK_SAFE_CONTEXT_TOKENS
            }
        };
        if valid {
            Ok(())
        } else {
            Err(ProviderError {
                message: "翻译请求超过应用安全输入或输出预算，必须拆为更小批次".into(),
                retryable: false,
                retry_after: None,
                split_retry: true,
            })
        }
    }
}

#[derive(Debug, Clone)]
pub struct PoolResponse {
    pub texts: Vec<String>,
    pub queue_wait: Duration,
    pub service_time: Duration,
    pub usage_detail: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ProviderError {
    pub message: String,
    pub retryable: bool,
    pub retry_after: Option<Duration>,
    pub split_retry: bool,
}

impl std::fmt::Display for ProviderError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ProviderError {}

struct PoolJob {
    request: PoolRequest,
    queued_at: Instant,
    response: oneshot::Sender<Result<PoolResponse, ProviderError>>,
}

#[derive(Clone)]
struct ProviderPool {
    sender: mpsc::Sender<PoolJob>,
    concurrency: watch::Sender<usize>,
}

impl ProviderPool {
    fn spawn(
        provider: ProviderKind,
        concurrency: usize,
        capacity: usize,
        client: Client,
        google_rate: Option<Arc<GoogleRateLimiter>>,
    ) -> Self {
        let (sender, receiver) = mpsc::channel::<PoolJob>(capacity);
        let (limit_sender, limit_receiver) = watch::channel(concurrency.max(1));
        tokio::spawn(dispatch(
            receiver,
            limit_receiver,
            move |mut job: PoolJob| {
                let client = client.clone();
                let google_rate = google_rate.clone();
                async move {
                    if job.response.is_closed() {
                        return;
                    }
                    if let Some(limiter) = &google_rate {
                        tokio::select! {
                            _ = job.response.closed() => return,
                            _ = limiter.reserve(job.request.input_chars()) => (),
                        }
                    }
                    if job.response.is_closed() {
                        return;
                    }
                    let queue_wait = job.queued_at.elapsed();
                    let service_started = Instant::now();
                    let result = tokio::select! {
                        _ = job.response.closed() => return,
                        result = execute(&client, job.request) => result,
                    }
                    .map(|mut response| {
                        response.queue_wait = queue_wait;
                        response.service_time = service_started.elapsed();
                        response
                    });
                    let _ = job.response.send(result);
                }
            },
        ));
        tracing::info!(?provider, concurrency, capacity, "translation pool started");
        Self {
            sender,
            concurrency: limit_sender,
        }
    }

    async fn submit(&self, request: PoolRequest) -> Result<PoolResponse, ProviderError> {
        request.validate_size()?;
        let (response, receiver) = oneshot::channel();
        self.sender
            .send(PoolJob {
                request,
                queued_at: Instant::now(),
                response,
            })
            .await
            .map_err(|_| ProviderError {
                message: "翻译任务池已停止".into(),
                retryable: true,
                retry_after: None,
                split_retry: false,
            })?;
        receiver.await.map_err(|_| ProviderError {
            message: "翻译任务池工作线程意外退出".into(),
            retryable: true,
            retry_after: None,
            split_retry: false,
        })?
    }
}

async fn dispatch<T, F, Fut>(
    mut receiver: mpsc::Receiver<T>,
    mut limit: watch::Receiver<usize>,
    execute_job: F,
) where
    T: Send + 'static,
    F: Fn(T) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    let mut running = JoinSet::new();
    let mut receiver_open = true;
    let mut limit_open = true;
    loop {
        let concurrency = (*limit.borrow_and_update()).max(1);
        if !receiver_open && running.is_empty() {
            break;
        }
        tokio::select! {
            biased;
            result = limit.changed(), if limit_open => {
                if result.is_err() { limit_open = false; }
            }
            result = running.join_next(), if !running.is_empty() => {
                if let Some(Err(error)) = result {
                    tracing::error!(%error, "translation request task stopped unexpectedly");
                }
            }
            job = receiver.recv(), if receiver_open && running.len() < concurrency => {
                match job {
                    Some(job) => { running.spawn(execute_job(job)); }
                    None => receiver_open = false,
                }
            }
        }
    }
}

pub struct TranslationPools {
    google: ProviderPool,
    deepseek: ProviderPool,
}

impl TranslationPools {
    pub fn new(config: &Config) -> Result<Arc<Self>> {
        let client = Client::builder()
            .no_proxy()
            .connect_timeout(Duration::from_secs(20))
            .timeout(Duration::from_secs(720))
            .pool_max_idle_per_host(
                config
                    .google_translation_concurrency
                    .max(config.deepseek_translation_concurrency),
            )
            .build()
            .context("无法创建翻译任务池 HTTP 客户端")?;
        let google_rate = Arc::new(GoogleRateLimiter::new(
            GOOGLE_SAFE_REQUESTS_PER_MINUTE,
            GOOGLE_SAFE_CHARS_PER_MINUTE,
        ));
        Ok(Arc::new(Self {
            google: ProviderPool::spawn(
                ProviderKind::Google,
                config.google_translation_concurrency,
                config.translation_queue_capacity,
                client.clone(),
                Some(google_rate),
            ),
            deepseek: ProviderPool::spawn(
                ProviderKind::DeepSeek,
                config.deepseek_translation_concurrency,
                config.translation_queue_capacity,
                client,
                None,
            ),
        }))
    }

    pub async fn submit(&self, request: PoolRequest) -> Result<PoolResponse, ProviderError> {
        match request.provider() {
            ProviderKind::Google => self.google.submit(request).await,
            ProviderKind::DeepSeek => self.deepseek.submit(request).await,
        }
    }

    pub fn concurrency(&self, provider: ProviderKind) -> usize {
        match provider {
            ProviderKind::Google => *self.google.concurrency.borrow(),
            ProviderKind::DeepSeek => *self.deepseek.concurrency.borrow(),
        }
    }

    pub fn update_limits(&self, settings: &TranslationRuntimeSettings) {
        for (pool, requested) in [
            (&self.google, settings.google.concurrency),
            (&self.deepseek, settings.deepseek.concurrency),
        ] {
            pool.concurrency.send_if_modified(|current| {
                if *current == requested {
                    false
                } else {
                    *current = requested.max(1);
                    true
                }
            });
        }
    }
}

#[derive(Debug)]
struct GoogleRateWindow {
    entries: VecDeque<(Instant, usize)>,
    chars: usize,
}

#[derive(Debug)]
struct GoogleRateLimiter {
    max_requests: usize,
    max_chars: usize,
    window: Mutex<GoogleRateWindow>,
}

impl GoogleRateLimiter {
    fn new(max_requests: usize, max_chars: usize) -> Self {
        Self {
            max_requests,
            max_chars,
            window: Mutex::new(GoogleRateWindow {
                entries: VecDeque::new(),
                chars: 0,
            }),
        }
    }

    async fn reserve(&self, chars: usize) {
        loop {
            let wait = {
                let mut window = self.window.lock().await;
                let now = Instant::now();
                while let Some((created, old_chars)) = window.entries.front().copied() {
                    if now.duration_since(created) < Duration::from_secs(60) {
                        break;
                    }
                    window.entries.pop_front();
                    window.chars = window.chars.saturating_sub(old_chars);
                }
                if window.entries.len() < self.max_requests
                    && window.chars.saturating_add(chars) <= self.max_chars
                {
                    window.entries.push_back((now, chars));
                    window.chars += chars;
                    None
                } else {
                    window
                        .entries
                        .front()
                        .map(|(created, _)| {
                            Duration::from_secs(60).saturating_sub(now.duration_since(*created))
                                + Duration::from_millis(20)
                        })
                        .or(Some(Duration::from_millis(100)))
                }
            };
            match wait {
                Some(duration) => tokio::time::sleep(duration).await,
                None => return,
            }
        }
    }
}

async fn execute(client: &Client, request: PoolRequest) -> Result<PoolResponse, ProviderError> {
    match request {
        PoolRequest::Google { api_key, contents } => call_google(client, &api_key, &contents).await,
        request @ PoolRequest::DeepSeek { .. } => call_deepseek(client, request).await,
    }
}

fn google_body(contents: &[String]) -> Value {
    json!({"q": contents, "target": "zh-CN", "format": "text"})
}

async fn call_google(
    client: &Client,
    key: &str,
    contents: &[String],
) -> Result<PoolResponse, ProviderError> {
    let response = client
        .post(GOOGLE_ENDPOINT)
        .query(&[("key", key)])
        .json(&google_body(contents))
        .send()
        .await
        .map_err(network_error)?;
    let status = response.status();
    let retry_after = retry_after(&response);
    let raw = response.text().await.map_err(network_error)?;
    if !status.is_success() {
        return Err(http_error(
            "Google Cloud Translation",
            status,
            retry_after,
            &raw.replace(key, "[redacted]"),
        ));
    }
    let value: Value = serde_json::from_str(&raw)
        .map_err(|_| output_error("Google Cloud Translation 返回了无法解析的 JSON"))?;
    let texts = decode_google(&value, contents.len())?;
    Ok(PoolResponse {
        texts,
        queue_wait: Duration::ZERO,
        service_time: Duration::ZERO,
        usage_detail: Some(format!(
            "本批 {} 段，计费字符约 {}",
            contents.len(),
            contents
                .iter()
                .map(|text| text.chars().count())
                .sum::<usize>()
        )),
    })
}

fn decode_google(value: &Value, expected: usize) -> Result<Vec<String>, ProviderError> {
    let translations = value["data"]["translations"]
        .as_array()
        .filter(|values| values.len() == expected)
        .ok_or_else(|| output_error("Google 批次返回段数与提交段数不一致"))?;
    translations
        .iter()
        .map(|value| {
            value["translatedText"]
                .as_str()
                .filter(|text| !text.trim().is_empty())
                .map(|text| html_escape::decode_html_entities(text).into_owned())
                .filter(|text| !text.trim().is_empty())
                .ok_or_else(|| output_error("Google 批次中存在空译文"))
        })
        .collect()
}

async fn call_deepseek(
    client: &Client,
    request: PoolRequest,
) -> Result<PoolResponse, ProviderError> {
    let PoolRequest::DeepSeek {
        api_key,
        system,
        user,
        thinking,
        max_tokens,
        user_id,
        segment_ids,
    } = request
    else {
        unreachable!("only DeepSeek requests are routed here")
    };
    let mut body = json!({
        "model": DEEPSEEK_MODEL_ID,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user}
        ],
        "thinking": {"type": if thinking { "enabled" } else { "disabled" }},
        "max_tokens": max_tokens,
        "stream": false,
        "user_id": user_id
    });
    if segment_ids.is_some() {
        body["response_format"] = json!({"type": "json_object"});
    }
    if thinking {
        body["reasoning_effort"] = Value::String("high".into());
    } else {
        body["temperature"] = json!(0.1);
    }
    let response = client
        .post(DEEPSEEK_ENDPOINT)
        .bearer_auth(&api_key)
        .json(&body)
        .send()
        .await
        .map_err(network_error)?;
    let status = response.status();
    let retry_after = retry_after(&response);
    let raw = response.text().await.map_err(network_error)?;
    if !status.is_success() {
        return Err(http_error(
            "DeepSeek",
            status,
            retry_after,
            &raw.replace(&api_key, "[redacted]"),
        ));
    }
    let value: Value =
        serde_json::from_str(&raw).map_err(|_| output_error("DeepSeek 返回了无法解析的 JSON"))?;
    let texts = decode_deepseek(&value, segment_ids.as_deref())?;
    let prompt_tokens = value["usage"]["prompt_tokens"].as_u64().unwrap_or(0);
    let completion_tokens = value["usage"]["completion_tokens"].as_u64().unwrap_or(0);
    let reasoning_tokens = value["usage"]["completion_tokens_details"]["reasoning_tokens"]
        .as_u64()
        .unwrap_or(0);
    Ok(PoolResponse {
        texts,
        queue_wait: Duration::ZERO,
        service_time: Duration::ZERO,
        usage_detail: Some(format!(
            "本批输入 {prompt_tokens} tokens；输出 {completion_tokens} tokens{}",
            if thinking {
                format!("（其中推理 {reasoning_tokens} tokens）")
            } else {
                String::new()
            }
        )),
    })
}

fn decode_deepseek(
    value: &Value,
    segment_ids: Option<&[usize]>,
) -> Result<Vec<String>, ProviderError> {
    let choice = &value["choices"][0];
    match choice["finish_reason"].as_str() {
        Some("stop") => (),
        Some("length") => {
            return Err(output_error(
                "DeepSeek 输出达到 token 上限，拒绝保存截断译文",
            ));
        }
        _ => return Err(output_error("DeepSeek 未正常完成译文输出")),
    }
    let text = choice["message"]["content"]
        .as_str()
        .filter(|text| !text.trim().is_empty())
        .ok_or_else(|| output_error("DeepSeek 未返回译文"))?;
    let Some(ids) = segment_ids else {
        return Ok(vec![text.to_string()]);
    };
    let payload: Value = serde_json::from_str(text)
        .map_err(|_| output_error("DeepSeek 批次未返回符合约定的 JSON 对象"))?;
    let segments = payload["segments"]
        .as_array()
        .filter(|values| values.len() == ids.len())
        .ok_or_else(|| output_error("DeepSeek 批次返回段数与提交段数不一致"))?;
    let expected = ids.iter().copied().collect::<HashSet<_>>();
    let mut results = HashMap::new();
    for segment in segments {
        let index = segment["id"]
            .as_u64()
            .and_then(|id| usize::try_from(id).ok())
            .filter(|id| expected.contains(id))
            .ok_or_else(|| output_error("DeepSeek 批次返回了未知段落编号"))?;
        let text = segment["text"]
            .as_str()
            .filter(|text| !text.trim().is_empty())
            .ok_or_else(|| output_error("DeepSeek 批次中存在空译文"))?;
        if results.insert(index, text.to_string()).is_some() {
            return Err(output_error("DeepSeek 批次返回了重复段落编号"));
        }
    }
    ids.iter()
        .map(|id| {
            results
                .remove(id)
                .ok_or_else(|| output_error("DeepSeek 批次丢失段落"))
        })
        .collect()
}

fn output_error(message: &str) -> ProviderError {
    ProviderError {
        message: message.into(),
        retryable: false,
        retry_after: None,
        split_retry: true,
    }
}

fn network_error(error: reqwest::Error) -> ProviderError {
    let retryable =
        error.is_timeout() || error.is_connect() || error.is_request() || error.is_body();
    ProviderError {
        message: format!("翻译服务网络错误：{}", error.without_url()),
        retryable,
        retry_after: None,
        split_retry: false,
    }
}

#[cfg(test)]
#[path = "translation_pool_tests.rs"]
mod runtime_tests;

fn retry_after(response: &reqwest::Response) -> Option<Duration> {
    response
        .headers()
        .get(RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .map(Duration::from_secs)
}

fn http_error(
    provider: &str,
    status: StatusCode,
    retry_after: Option<Duration>,
    body: &str,
) -> ProviderError {
    let google_rate_limit = provider == "Google Cloud Translation"
        && status.as_u16() == 403
        && (body.contains("User Rate Limit Exceeded") || body.contains("userRateLimitExceeded"));
    ProviderError {
        message: format!(
            "{provider} HTTP {status}：{}",
            body.chars().take(500).collect::<String>()
        ),
        retryable: google_rate_limit || matches!(status.as_u16(), 429 | 500 | 502 | 503 | 504),
        retry_after: retry_after.or(google_rate_limit.then_some(Duration::from_secs(60))),
        split_retry: status.as_u16() == 413
            || (status.as_u16() == 400
                && (body.contains("context_length_exceeded")
                    || body.contains("maximum context length"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn google_rate_window_reserves_below_caps() {
        let limiter = GoogleRateLimiter::new(10, 100);
        limiter.reserve(40).await;
        limiter.reserve(50).await;
        let window = limiter.window.lock().await;
        assert_eq!(window.entries.len(), 2);
        assert_eq!(window.chars, 90);
    }

    #[test]
    fn deepseek_limit_is_twenty_percent_below_official_ceiling() {
        assert_eq!(2_500 * 80 / 100, 2_000);
    }
}
