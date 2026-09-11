//! Shared request pools, one per large-model provider. Each pool is a FIFO
//! queue with a concurrency limit.
//! The limit adapts to rate limiting: it halves when the service answers
//! "too many requests" and climbs back to the configured value as requests
//! succeed again.

use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex as StdMutex, RwLock,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

use anyhow::{Context, Result};
use regex::Regex;
use reqwest::Client;
use tokio::{
    sync::{mpsc, oneshot, watch},
    task::JoinSet,
};

use crate::{
    config::Config,
    http::{self, ProxySettings},
    providers::{self, ChatRequest, Endpoint, ErrorKind, Finish, ProviderConfig, ProviderError},
};

/// The HTTP client shared by all pools. It is replaced when the user changes
/// the proxy; requests already in flight finish on the previous client.
type SharedClient = Arc<RwLock<Client>>;

/// How long a key that failed with a credential error sits out.
const KEY_BENCH: Duration = Duration::from_secs(600);

/// Where a large-model request goes. Captured when a document starts.
#[derive(Debug, Clone)]
pub struct LlmTarget {
    pub provider_id: String,
    pub provider_name: String,
    pub endpoint: Endpoint,
    pub model: String,
    pub keys: Vec<String>,
    /// Pool size used if this provider's pool does not exist yet.
    pub concurrency: usize,
}

impl LlmTarget {
    pub fn label(&self) -> String {
        format!("{} · {}", self.provider_name, self.model)
    }
}

/// One request to a large model.
#[derive(Debug, Clone)]
pub struct PoolRequest {
    pub target: Arc<LlmTarget>,
    pub system: String,
    pub user: String,
    pub max_tokens: Option<u32>,
}

#[derive(Debug, Clone)]
pub struct PoolResponse {
    pub text: String,
    pub finish: Finish,
    pub queue_wait: Duration,
    pub service_time: Duration,
    pub usage_detail: Option<String>,
}

struct PoolJob {
    request: PoolRequest,
    queued_at: Instant,
    response: oneshot::Sender<Result<PoolResponse, ProviderError>>,
}

/// The concurrency a pool may use right now.
struct Throttle {
    configured: usize,
    current: usize,
    cooldown_until: Instant,
    successes: usize,
}

/// Rotates through a provider's keys. A key that fails with a credential
/// error (invalid, blocked, out of balance) sits out for a while, so the
/// other keys keep the document going.
#[derive(Default)]
struct KeyRing {
    next: AtomicUsize,
    benched: StdMutex<HashMap<String, Instant>>,
}

impl KeyRing {
    fn usable<'a>(&self, keys: &'a [String]) -> Vec<&'a str> {
        let now = Instant::now();
        let benched = self.benched.lock().unwrap_or_else(|error| error.into_inner());
        keys.iter()
            .map(String::as_str)
            .filter(|key| benched.get(*key).is_none_or(|until| *until <= now))
            .collect()
    }

    /// The next usable key; `None` when every key is benched.
    fn pick<'a>(&self, keys: &'a [String]) -> Option<&'a str> {
        let usable = self.usable(keys);
        (!usable.is_empty()).then(|| usable[self.next.fetch_add(1, Ordering::Relaxed) % usable.len()])
    }

    fn bench(&self, key: &str) {
        self.benched
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(key.to_string(), Instant::now() + KEY_BENCH);
    }

    fn clear(&self) {
        self.benched.lock().unwrap_or_else(|error| error.into_inner()).clear();
    }
}

struct ProviderPool {
    sender: mpsc::Sender<PoolJob>,
    limit: watch::Sender<usize>,
    throttle: Arc<StdMutex<Throttle>>,
    keys: Arc<KeyRing>,
}

impl ProviderPool {
    fn spawn(label: String, concurrency: usize, capacity: usize, client: SharedClient, fake: bool) -> Self {
        let concurrency = concurrency.max(1);
        let (sender, receiver) = mpsc::channel::<PoolJob>(capacity);
        let (limit_sender, limit_receiver) = watch::channel(concurrency);
        let throttle = Arc::new(StdMutex::new(Throttle {
            configured: concurrency,
            current: concurrency,
            cooldown_until: Instant::now(),
            successes: 0,
        }));
        let keys = Arc::new(KeyRing::default());
        let worker_keys = keys.clone();
        let worker_throttle = throttle.clone();
        let worker_limit = limit_sender.clone();
        tokio::spawn(dispatch(receiver, limit_receiver, move |mut job: PoolJob| {
            let client = client
                .read()
                .unwrap_or_else(|error| error.into_inner())
                .clone();
            let throttle = worker_throttle.clone();
            let limit = worker_limit.clone();
            let keys = worker_keys.clone();
            async move {
                if job.response.is_closed() {
                    return;
                }
                let queue_wait = job.queued_at.elapsed();
                let started = Instant::now();
                let result = tokio::select! {
                    _ = job.response.closed() => return,
                    result = async {
                        if fake {
                            fake_execute(job.request).await
                        } else {
                            execute(&client, &keys, job.request).await
                        }
                    } => result,
                };
                adapt(&throttle, &limit, &result);
                let result = result.map(|mut response| {
                    response.queue_wait = queue_wait;
                    response.service_time = started.elapsed();
                    response
                });
                let _ = job.response.send(result);
            }
        }));
        tracing::info!(label, concurrency, capacity, "translation pool started");
        Self {
            sender,
            limit: limit_sender,
            throttle,
            keys,
        }
    }

    fn set_configured(&self, concurrency: usize) {
        let concurrency = concurrency.max(1);
        let mut throttle = self.throttle.lock().unwrap_or_else(|error| error.into_inner());
        if throttle.configured == concurrency {
            return;
        }
        let was_throttled = throttle.current < throttle.configured;
        throttle.configured = concurrency;
        throttle.current = if was_throttled {
            throttle.current.min(concurrency)
        } else {
            concurrency
        };
        let _ = self.limit.send(throttle.current);
    }

    fn effective(&self) -> usize {
        *self.limit.borrow()
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
            .map_err(|_| ProviderError::new(ErrorKind::Transient, "翻译任务池已停止"))?;
        receiver
            .await
            .map_err(|_| ProviderError::new(ErrorKind::Transient, "翻译任务池工作线程意外退出"))?
    }
}

/// Halve on rate limiting (at most every ten seconds); after a round of
/// successes grow back by a quarter, never above the configured value.
fn adapt(
    throttle: &StdMutex<Throttle>,
    limit: &watch::Sender<usize>,
    result: &Result<PoolResponse, ProviderError>,
) {
    let mut state = throttle.lock().unwrap_or_else(|error| error.into_inner());
    let now = Instant::now();
    match result {
        Err(error) if error.kind == ErrorKind::RateLimited => {
            if now >= state.cooldown_until && state.current > 1 {
                state.current = (state.current / 2).max(1);
                state.cooldown_until = now + Duration::from_secs(10);
                state.successes = 0;
                tracing::warn!(current = state.current, "rate limited; lowering concurrency");
                let _ = limit.send(state.current);
            }
        }
        Ok(_) if state.current < state.configured => {
            state.successes += 1;
            if now >= state.cooldown_until && state.successes >= state.current.max(4) {
                state.current = (state.current + (state.current / 4).max(1)).min(state.configured);
                state.successes = 0;
                let _ = limit.send(state.current);
            }
        }
        _ => {}
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
    llm: StdMutex<HashMap<String, Arc<ProviderPool>>>,
    client: SharedClient,
    capacity: usize,
    fake: bool,
}

fn build_client(proxy: &ProxySettings) -> Result<Client> {
    http::apply(Client::builder(), proxy)?
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(900))
        .pool_max_idle_per_host(256)
        .build()
        .context("无法创建翻译服务 HTTP 客户端")
}

impl TranslationPools {
    pub fn new(config: &Config, proxy: &ProxySettings) -> Result<Arc<Self>> {
        let client = Arc::new(RwLock::new(build_client(proxy)?));
        if config.fake_providers {
            tracing::warn!("DOCFLOW_FAKE_PROVIDERS=1：翻译请求由本地测试译文代替，不会调用云端服务");
        }
        Ok(Arc::new(Self {
            llm: StdMutex::new(HashMap::new()),
            client,
            capacity: config.translation_queue_capacity,
            fake: config.fake_providers,
        }))
    }

    /// Applies a new proxy policy to requests that start after this call.
    pub fn set_proxy(&self, proxy: &ProxySettings) -> Result<()> {
        let client = build_client(proxy)?;
        *self
            .client
            .write()
            .unwrap_or_else(|error| error.into_inner()) = client;
        Ok(())
    }

    /// New keys were entered for a provider: give every key another chance.
    pub fn reset_keys(&self, provider_id: &str) {
        if let Some(pool) = self.llm.lock().unwrap_or_else(|error| error.into_inner()).get(provider_id) {
            pool.keys.clear();
        }
    }

    /// Applies each provider's concurrency to its pool, if it has one.
    pub fn configure_providers(&self, providers: &[ProviderConfig]) {
        let pools = self.llm.lock().unwrap_or_else(|error| error.into_inner());
        for provider in providers {
            if let Some(pool) = pools.get(&provider.id) {
                pool.set_configured(provider.concurrency);
            }
        }
    }

    fn llm_pool(&self, target: &LlmTarget) -> Arc<ProviderPool> {
        let mut pools = self.llm.lock().unwrap_or_else(|error| error.into_inner());
        pools
            .entry(target.provider_id.clone())
            .or_insert_with(|| {
                Arc::new(ProviderPool::spawn(
                    target.provider_name.clone(),
                    target.concurrency,
                    self.capacity,
                    self.client.clone(),
                    self.fake,
                ))
            })
            .clone()
    }

    pub async fn submit(&self, request: PoolRequest) -> Result<PoolResponse, ProviderError> {
        let pool = self.llm_pool(&request.target);
        pool.submit(request).await
    }

    /// Requests the pool for this target may have in flight right now.
    pub fn concurrency(&self, target: &LlmTarget) -> usize {
        self.llm_pool(target).effective()
    }
}

async fn execute(client: &Client, keys: &KeyRing, request: PoolRequest) -> Result<PoolResponse, ProviderError> {
    let PoolRequest { target, system, user, max_tokens } = request;
    let key = if target.keys.is_empty() {
        None
    } else {
        Some(keys.pick(&target.keys).ok_or_else(|| {
            ProviderError::new(
                ErrorKind::Credential,
                format!(
                    "{}：全部 {} 个 API Key 都无法使用（无效、受限或余额不足），请在设置中更新 Key",
                    target.provider_name,
                    target.keys.len()
                ),
            )
        })?)
    };
    let reply = providers::chat(
        client,
        &target.endpoint,
        key,
        &ChatRequest {
            model: &target.model,
            system: &system,
            user: &user,
            max_tokens,
        },
        &target.provider_name,
    )
    .await;
    let reply = match (reply, key) {
        (Err(error), Some(key)) if error.kind == ErrorKind::Credential && target.keys.len() > 1 => {
            keys.bench(key);
            let remaining = keys.usable(&target.keys).len();
            if remaining == 0 {
                return Err(error);
            }
            tracing::warn!(provider = %target.provider_name, remaining, "credential error; key benched");
            let tail = crate::secrets::tail(key);
            let which = if tail.is_empty() { "其中一个 Key".to_string() } else { format!("尾号 {tail} 的 Key") };
            return Err(ProviderError::new(
                ErrorKind::Transient,
                format!("{}。{which} 已暂停使用 10 分钟，改用其余 {remaining} 个 Key", error.message),
            ));
        }
        (reply, _) => reply?,
    };
    let usage = match (reply.input_tokens, reply.output_tokens) {
        (Some(input), Some(output)) => Some(format!("输入 {input} tokens，输出 {output} tokens")),
        _ => None,
    };
    Ok(PoolResponse {
        text: reply.text,
        finish: reply.finish,
        queue_wait: Duration::ZERO,
        service_time: Duration::ZERO,
        usage_detail: usage,
    })
}

/// Deterministic local "translations" for development and automated tests
/// (`DOCFLOW_FAKE_PROVIDERS=1`). Protected markers and segment tags are kept
/// byte-for-byte, so every validation path of the real pipeline still runs.
async fn fake_execute(request: PoolRequest) -> Result<PoolResponse, ProviderError> {
    fn translate(text: &str) -> String {
        if text.trim().is_empty() {
            return text.to_string();
        }
        let body = text.trim_end();
        format!("{body}〔测试译文〕{}", &text[body.len()..])
    }
    tokio::time::sleep(Duration::from_millis(60)).await;
    let user = request.user;
    let segments = Regex::new(r#"(?s)<segment id="(\d+)">\n(.*?)\n</segment>"#).expect("static regex");
    let text = if segments.is_match(&user) {
        segments
            .captures_iter(&user)
            .map(|capture| format!("<segment id=\"{}\">\n{}\n</segment>", &capture[1], translate(&capture[2])))
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        translate(&user)
    };
    Ok(PoolResponse {
        text,
        finish: Finish::Complete,
        queue_wait: Duration::ZERO,
        service_time: Duration::ZERO,
        usage_detail: Some("本地测试译文，未调用云端服务".into()),
    })
}

#[cfg(test)]
#[path = "translation_pool_tests.rs"]
mod runtime_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn fake_provider_keeps_segment_tags_and_markers() {
        let target = Arc::new(LlmTarget {
            provider_id: "p".into(),
            provider_name: "P".into(),
            endpoint: Endpoint {
                kind: providers::ProviderType::Openai,
                base_url: "http://localhost".into(),
                extra_body: Default::default(),
            },
            model: "m".into(),
            keys: vec![],
            concurrency: 1,
        });
        let response = fake_execute(PoolRequest {
            target: target.clone(),
            system: "s".into(),
            user: "<segment id=\"4\">\nb DOCFLOWKEEP000000TOKEN\n</segment>\n\n<segment id=\"2\">\na {v0}\n</segment>".into(),
            max_tokens: None,
        })
        .await
        .unwrap();
        assert_eq!(
            response.text,
            "<segment id=\"4\">\nb DOCFLOWKEEP000000TOKEN〔测试译文〕\n</segment>\n<segment id=\"2\">\na {v0}〔测试译文〕\n</segment>"
        );
        let blank = fake_execute(PoolRequest { target, system: "s".into(), user: " \n".into(), max_tokens: None })
            .await
            .unwrap();
        assert_eq!(blank.text, " \n");
    }

    #[test]
    fn benched_keys_sit_out_until_every_key_has_failed() {
        let ring = KeyRing::default();
        let keys = vec!["sk-a".to_string(), "sk-b".to_string(), "sk-c".to_string()];
        ring.bench("sk-b");
        let picked = (0..6).filter_map(|_| ring.pick(&keys)).collect::<Vec<_>>();
        assert_eq!(picked.len(), 6);
        assert!(!picked.contains(&"sk-b"));
        assert!(picked.contains(&"sk-a") && picked.contains(&"sk-c"));
        ring.bench("sk-a");
        ring.bench("sk-c");
        assert!(ring.pick(&keys).is_none());
        ring.clear();
        assert_eq!(ring.usable(&keys).len(), 3);
    }

    #[test]
    fn rate_limits_halve_concurrency_and_successes_restore_it() {
        let throttle = StdMutex::new(Throttle {
            configured: 100,
            current: 100,
            cooldown_until: Instant::now(),
            successes: 0,
        });
        let (limit, receiver) = watch::channel(100usize);
        let limited = Err(ProviderError::new(ErrorKind::RateLimited, "429"));
        adapt(&throttle, &limit, &limited);
        assert_eq!(*receiver.borrow(), 50);
        // Within the cooldown a second 429 does not halve again.
        adapt(&throttle, &limit, &limited);
        assert_eq!(*receiver.borrow(), 50);
        let ok = Ok(PoolResponse {
            text: String::new(),
            finish: Finish::Complete,
            queue_wait: Duration::ZERO,
            service_time: Duration::ZERO,
            usage_detail: None,
        });
        throttle.lock().unwrap().cooldown_until = Instant::now();
        for _ in 0..50 {
            adapt(&throttle, &limit, &ok);
        }
        assert_eq!(*receiver.borrow(), 62);
        for _ in 0..2_000 {
            throttle.lock().unwrap().cooldown_until = Instant::now();
            adapt(&throttle, &limit, &ok);
        }
        assert_eq!(*receiver.borrow(), 100);
    }
}
