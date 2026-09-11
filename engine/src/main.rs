//! DocFlow engine: the shared processing core of the Windows and macOS apps.
//!
//! The host app starts `docflow-engine --data-dir <dir> [--resources <dir>]`
//! and talks JSON-RPC over the process's stdin/stdout (see `rpc.rs`).

mod assets;
mod config;
mod db;
mod events;
mod http;
mod library;
mod models;
mod pipeline;
mod providers;
mod reader;
mod rpc;
mod secrets;
mod settings;
mod state;
mod translation_pool;
mod verify;
mod worker;

use std::{fs::OpenOptions, sync::Arc, time::Duration};

use anyhow::{Context, Result};
use config::{Args, Config};
use state::AppState;
use tokio::sync::mpsc;
use tracing_subscriber::EnvFilter;

fn main() -> Result<()> {
    let args = Args::parse()?;
    if args.version {
        println!("docflow-engine {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    let config = Arc::new(Config::new(&args)?);
    for directory in [
        &config.data_root,
        &config.work_root,
        &config.archive_root,
        &config.log_root,
    ] {
        std::fs::create_dir_all(directory)
            .with_context(|| format!("无法创建目录 {}", directory.display()))?;
    }
    init_logging(&config)?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(config.data_root.join("engine.lock"))
        .context("无法创建引擎锁文件")?;
    if lock.try_lock().is_err() {
        anyhow::bail!("同一个文档库已有一个 DocFlow 引擎在运行");
    }

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_name("docflow-engine")
        .build()?;
    let result = runtime.block_on(run(config));
    if let Err(error) = &result {
        tracing::error!(error = %format!("{error:#}"), "engine stopped with an error");
    }
    // Dropping the runtime aborts running jobs; their child processes are
    // killed (`kill_on_drop`) and the jobs resume on the next launch.
    runtime.shutdown_timeout(Duration::from_secs(5));
    drop(lock);
    result
}

async fn run(config: Arc<Config>) -> Result<()> {
    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        data = %config.data_root.display(),
        resources = %config.resources_root.display(),
        "engine starting"
    );
    assets::install(&config)?;
    let pool = db::open(&config.database_path).await?;
    let preferences = settings::load_preferences(&pool).await?;
    let pools = translation_pool::TranslationPools::new(&config, &preferences.proxy)?;
    pools.configure_providers(&providers::load(&pool).await?);
    let state = Arc::new(AppState::new(pool, config, pools));
    rpc::apply_preferences(&state, &preferences)?;
    library::resume_interrupted(&state).await?;

    let (outgoing, lines) = mpsc::unbounded_channel();
    events::install_sink(outgoing.clone());
    rpc::serve(state, outgoing, lines).await
}

fn init_logging(config: &Config) -> Result<()> {
    let path = config.log_root.join("engine.log");
    if std::fs::metadata(&path).is_ok_and(|metadata| metadata.len() > 8 * 1024 * 1024) {
        let _ = std::fs::rename(&path, config.log_root.join("engine.log.1"));
    }
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .with_context(|| format!("无法打开日志文件 {}", path.display()))?;
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_env("DOCFLOW_LOG").unwrap_or_else(|_| "docflow_engine=info".into()),
        )
        .with_ansi(false)
        .with_writer(std::sync::Mutex::new(file))
        .init();
    Ok(())
}
