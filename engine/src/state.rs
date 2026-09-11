use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};

use sqlx::SqlitePool;
use tokio::{
    sync::{Notify, Semaphore},
    task::AbortHandle,
};

use crate::{config::Config, http::Network, secrets::Secrets, translation_pool::TranslationPools};

pub struct AppState {
    pub pool: SqlitePool,
    pub config: Arc<Config>,
    /// Always present in the engine; optional only so pipeline code can keep
    /// reporting a clear error if it is ever used without the pools.
    pub translation_pools: Option<Arc<TranslationPools>>,
    pub native_pdf_slots: Arc<Semaphore>,
    pub secrets: Secrets,
    pub network: Network,
    /// Running pipeline tasks, so a document can be cancelled or deleted.
    pub jobs: Mutex<HashMap<String, AbortHandle>>,
    /// Wakes the scheduler when work is queued or settings change.
    pub wake: Notify,
    /// Documents processed at the same time (a user preference).
    worker_limit: AtomicUsize,
}

impl AppState {
    pub fn new(pool: SqlitePool, config: Arc<Config>, pools: Arc<TranslationPools>) -> Self {
        Self {
            native_pdf_slots: Arc::new(Semaphore::new(config.pdf2zh_concurrency)),
            pool,
            config,
            translation_pools: Some(pools),
            secrets: Secrets::default(),
            network: Network::default(),
            jobs: Mutex::new(HashMap::new()),
            wake: Notify::new(),
            worker_limit: AtomicUsize::new(2),
        }
    }

    pub fn worker_limit(&self) -> usize {
        self.worker_limit.load(Ordering::Relaxed).max(1)
    }

    pub fn set_worker_limit(&self, limit: usize) {
        self.worker_limit.store(limit.max(1), Ordering::Relaxed);
        self.wake.notify_one();
    }

    pub fn is_running(&self, id: &str) -> bool {
        self.jobs
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .contains_key(id)
    }

    /// Aborts a running pipeline task. Dropping it kills a native PDF child
    /// process as well (`kill_on_drop`).
    pub fn abort_job(&self, id: &str) -> bool {
        match self
            .jobs
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(id)
        {
            Some(handle) => {
                handle.abort();
                true
            }
            None => false,
        }
    }

    #[cfg(test)]
    pub async fn for_tests(config: Config) -> Arc<Self> {
        let config = Arc::new(config);
        let pool = crate::db::open_memory().await;
        let pools = TranslationPools::new(&config, &crate::http::ProxySettings::Direct).unwrap();
        Arc::new(Self::new(pool, config, pools))
    }
}
