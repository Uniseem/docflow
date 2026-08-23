use std::{env, path::PathBuf};

use anyhow::{Context, Result};

#[derive(Debug)]
pub struct Config {
    pub app_name: String,
    pub database_url: String,
    pub database_pool_size: u32,
    pub secret_key: String,
    pub data_root: PathBuf,
    pub work_root: PathBuf,
    pub archive_root: PathBuf,
    pub max_upload_bytes: u64,
    pub translation_chunk_chars: usize,
    pub mineru_poll_seconds: u64,
    pub mineru_max_wait_seconds: u64,
    pub webp_quality: u8,
    pub worker_concurrency: usize,
    pub public_origin: String,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let secret_key = required("SECRET_KEY")?;
        if secret_key.trim().is_empty() {
            anyhow::bail!("SECRET_KEY 不能为空");
        }
        let data_root = PathBuf::from(env::var("DATA_ROOT").unwrap_or_else(|_| "/data".into()));
        Ok(Self {
            app_name: env::var("APP_NAME").unwrap_or_else(|_| "文流".into()),
            database_url: required("DATABASE_URL")?,
            database_pool_size: parsed("DATABASE_POOL_SIZE", 20)?,
            secret_key,
            work_root: data_root.join("work"),
            archive_root: data_root.join("archives"),
            data_root,
            max_upload_bytes: parsed::<u64>("MAX_UPLOAD_MB", 200)? * 1024 * 1024,
            translation_chunk_chars: parsed("TRANSLATION_CHUNK_CHARS", 10_000)?,
            mineru_poll_seconds: parsed("MINERU_POLL_SECONDS", 5)?,
            mineru_max_wait_seconds: parsed("MINERU_MAX_WAIT_SECONDS", 7_200)?,
            webp_quality: parsed("WEBP_QUALITY", 86)?,
            worker_concurrency: parsed("WORKER_CONCURRENCY", 3)?,
            public_origin: env::var("PUBLIC_ORIGIN")
                .unwrap_or_else(|_| "http://185.99.135.224:8090".into())
                .trim_end_matches('/')
                .to_string(),
        })
    }

    pub fn max_upload_mb(&self) -> u64 {
        self.max_upload_bytes / 1024 / 1024
    }
}

fn required(key: &str) -> Result<String> {
    env::var(key).with_context(|| format!("缺少环境变量 {key}"))
}

fn parsed<T>(key: &str, default: T) -> Result<T>
where
    T: std::str::FromStr,
    T::Err: std::fmt::Display,
{
    match env::var(key) {
        Ok(value) => value
            .parse()
            .map_err(|error| anyhow::anyhow!("{key} 格式错误：{error}")),
        Err(_) => Ok(default),
    }
}
