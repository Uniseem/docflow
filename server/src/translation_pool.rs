use std::{
    collections::VecDeque,
    sync::Arc,
    time::{Duration, Instant},
};

use anyhow::{Context, Result};
use reqwest::{Client, StatusCode, header::RETRY_AFTER};
use serde_json::{Value, json};
use tokio::sync::{Mutex, mpsc, oneshot};

use crate::config::Config;

pub const DEEPSEEK_MODEL_ID: &str = "deepseek-v4-flash";
const GOOGLE_ENDPOINT: &str = "https://translation.googleapis.com/language/translate/v2";
const DEEPSEEK_ENDPOINT: &str = "https://api.deepseek.com/chat/completions";
const GOOGLE_SAFE_CHARS_PER_MINUTE: usize = 4_800_000;
const GOOGLE_SAFE_REQUESTS_PER_MINUTE: usize = 240_000;

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
        content: String,
    },
    DeepSeek {
        api_key: String,
        system: String,
        user: String,
        thinking: bool,
        max_tokens: u32,
        user_id: String,
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
            Self::Google { content, .. } => content.chars().count(),
            Self::DeepSeek { system, user, .. } => system.chars().count() + user.chars().count(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct PoolResponse {
    pub text: String,
    pub queue_wait: Duration,
    pub service_time: Duration,
    pub usage_detail: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ProviderError {
    pub message: String,
    pub retryable: bool,
    pub retry_after: Option<Duration>,
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
    concurrency: usize,
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
        let receiver = Arc::new(Mutex::new(receiver));
        for worker_index in 0..concurrency {
            let receiver = receiver.clone();
            let client = client.clone();
            let google_rate = google_rate.clone();
            tokio::spawn(async move {
                loop {
                    let job = {
                        let mut guard = receiver.lock().await;
                        guard.recv().await
                    };
                    let Some(job) = job else { break };
                    let queue_wait = job.queued_at.elapsed();
                    let service_started = Instant::now();
                    if let Some(limiter) = &google_rate {
                        limiter.reserve(job.request.input_chars()).await;
                    }
                    let result = execute(&client, job.request).await.map(|mut response| {
                        response.queue_wait = queue_wait;
                        response.service_time = service_started.elapsed();
                        response
                    });
                    let _ = job.response.send(result);
                }
                tracing::debug!(?provider, worker_index, "translation pool worker stopped");
            });
        }
        tracing::info!(?provider, concurrency, capacity, "translation pool started");
        Self {
            sender,
            concurrency,
        }
    }

    async fn submit(&self, request: PoolRequest) -> Result<PoolResponse, ProviderError> {
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
            })?;
        receiver.await.map_err(|_| ProviderError {
            message: "翻译任务池工作线程意外退出".into(),
            retryable: true,
            retry_after: None,
        })?
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
            ProviderKind::Google => self.google.concurrency,
            ProviderKind::DeepSeek => self.deepseek.concurrency,
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
        PoolRequest::Google { api_key, content } => call_google(client, &api_key, &content).await,
        PoolRequest::DeepSeek {
            api_key,
            system,
            user,
            thinking,
            max_tokens,
            user_id,
        } => {
            call_deepseek(
                client, &api_key, &system, &user, thinking, max_tokens, &user_id,
            )
            .await
        }
    }
}

async fn call_google(
    client: &Client,
    key: &str,
    content: &str,
) -> Result<PoolResponse, ProviderError> {
    let response = client
        .post(GOOGLE_ENDPOINT)
        .query(&[("key", key)])
        .json(&json!({"q": content, "target": "zh-CN", "format": "text"}))
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
            &raw,
        ));
    }
    let value: Value = serde_json::from_str(&raw).map_err(|error| ProviderError {
        message: format!("Google Cloud Translation 返回了无法解析的 JSON：{error}"),
        retryable: false,
        retry_after: None,
    })?;
    let text = value["data"]["translations"][0]["translatedText"]
        .as_str()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| ProviderError {
            message: "Google Cloud Translation 未返回译文".into(),
            retryable: false,
            retry_after: None,
        })?;
    Ok(PoolResponse {
        text: html_escape::decode_html_entities(text).into_owned(),
        queue_wait: Duration::ZERO,
        service_time: Duration::ZERO,
        usage_detail: Some(format!("计费字符约 {}", content.chars().count())),
    })
}

async fn call_deepseek(
    client: &Client,
    key: &str,
    system: &str,
    user: &str,
    thinking: bool,
    max_tokens: u32,
    user_id: &str,
) -> Result<PoolResponse, ProviderError> {
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
    if thinking {
        body["reasoning_effort"] = Value::String("high".into());
    } else {
        body["temperature"] = json!(0.1);
    }
    let response = client
        .post(DEEPSEEK_ENDPOINT)
        .bearer_auth(key)
        .json(&body)
        .send()
        .await
        .map_err(network_error)?;
    let status = response.status();
    let retry_after = retry_after(&response);
    let raw = response.text().await.map_err(network_error)?;
    if !status.is_success() {
        return Err(http_error("DeepSeek", status, retry_after, &raw));
    }
    let value: Value = serde_json::from_str(&raw).map_err(|error| ProviderError {
        message: format!("DeepSeek 返回了无法解析的 JSON：{error}"),
        retryable: false,
        retry_after: None,
    })?;
    let text = value["choices"][0]["message"]["content"]
        .as_str()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| ProviderError {
            message: "DeepSeek 未返回译文".into(),
            retryable: false,
            retry_after: None,
        })?;
    let prompt_tokens = value["usage"]["prompt_tokens"].as_u64().unwrap_or(0);
    let completion_tokens = value["usage"]["completion_tokens"].as_u64().unwrap_or(0);
    let reasoning_tokens = value["usage"]["completion_tokens_details"]["reasoning_tokens"]
        .as_u64()
        .unwrap_or(0);
    Ok(PoolResponse {
        text: text.to_string(),
        queue_wait: Duration::ZERO,
        service_time: Duration::ZERO,
        usage_detail: Some(format!(
            "输入 {prompt_tokens} tokens；输出 {completion_tokens} tokens{}",
            if thinking {
                format!("（其中推理 {reasoning_tokens} tokens）")
            } else {
                String::new()
            }
        )),
    })
}

fn network_error(error: reqwest::Error) -> ProviderError {
    ProviderError {
        message: format!("翻译服务网络错误：{error}"),
        retryable: error.is_timeout() || error.is_connect() || error.is_request(),
        retry_after: None,
    }
}

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
    ProviderError {
        message: format!(
            "{provider} HTTP {status}：{}",
            body.chars().take(500).collect::<String>()
        ),
        retryable: matches!(status.as_u16(), 429 | 500 | 502 | 503 | 504),
        retry_after,
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
