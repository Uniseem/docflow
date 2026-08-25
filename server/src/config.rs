use std::{env, fs, path::PathBuf};

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
    pub translation_per_document_concurrency: usize,
    pub translation_queue_capacity: usize,
    pub google_translation_concurrency: usize,
    pub deepseek_translation_concurrency: usize,
    pub mineru_poll_seconds: u64,
    pub mineru_max_wait_seconds: u64,
    pub webp_quality: u8,
    pub worker_concurrency: usize,
    pub public_origin: String,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let secret_key = required_or_file("SECRET_KEY", "SECRET_KEY_FILE")?;
        if secret_key.trim().is_empty() {
            anyhow::bail!("SECRET_KEY 不能为空");
        }
        let data_root = PathBuf::from(env::var("DATA_ROOT").unwrap_or_else(|_| "/data".into()));
        Ok(Self {
            app_name: env::var("APP_NAME").unwrap_or_else(|_| "文流".into()),
            database_url: database_url()?,
            database_pool_size: parsed("DATABASE_POOL_SIZE", 20)?,
            secret_key,
            work_root: data_root.join("work"),
            archive_root: data_root.join("archives"),
            data_root,
            max_upload_bytes: parsed::<u64>("MAX_UPLOAD_MB", 200)? * 1024 * 1024,
            translation_chunk_chars: parsed("TRANSLATION_CHUNK_CHARS", 10_000)?,
            translation_per_document_concurrency: parsed::<usize>(
                "TRANSLATION_PER_DOCUMENT_CONCURRENCY",
                8,
            )?
            .clamp(1, 32),
            translation_queue_capacity: parsed::<usize>("TRANSLATION_QUEUE_CAPACITY", 4_096)?
                .clamp(64, 65_536),
            google_translation_concurrency: parsed::<usize>("GOOGLE_TRANSLATION_CONCURRENCY", 32)?
                .clamp(1, 256),
            deepseek_translation_concurrency: parsed::<usize>(
                "DEEPSEEK_TRANSLATION_CONCURRENCY",
                64,
            )?
            .clamp(1, 2_000),
            mineru_poll_seconds: parsed("MINERU_POLL_SECONDS", 5)?,
            mineru_max_wait_seconds: parsed("MINERU_MAX_WAIT_SECONDS", 7_200)?,
            webp_quality: parsed("WEBP_QUALITY", 86)?,
            worker_concurrency: parsed("WORKER_CONCURRENCY", 3)?,
            public_origin: env::var("PUBLIC_ORIGIN")
                .unwrap_or_default()
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

fn required_or_file(key: &str, file_key: &str) -> Result<String> {
    if let Ok(value) = env::var(key)
        && !value.trim().is_empty()
    {
        return Ok(value);
    }
    let path = required(file_key)?;
    let value = fs::read_to_string(&path).with_context(|| format!("无法读取 {file_key}={path}"))?;
    let value = value.trim().to_string();
    if value.is_empty() {
        anyhow::bail!("{file_key} 指向的文件为空");
    }
    Ok(value)
}

fn database_url() -> Result<String> {
    if let Ok(value) = env::var("DATABASE_URL")
        && !value.trim().is_empty()
    {
        return Ok(value);
    }

    let host = env::var("DATABASE_HOST").unwrap_or_else(|_| "db".into());
    let port = parsed::<u16>("DATABASE_PORT", 5432)?;
    let database = env::var("DATABASE_NAME").unwrap_or_else(|_| "docflow".into());
    let user = env::var("DATABASE_USER").unwrap_or_else(|_| "docflow".into());
    let password = required_or_file("DATABASE_PASSWORD", "DATABASE_PASSWORD_FILE")?;
    let mut url = url::Url::parse("postgres://localhost").context("无法创建数据库连接地址")?;
    url.set_host(Some(&host)).context("数据库主机名无效")?;
    url.set_port(Some(port))
        .map_err(|_| anyhow::anyhow!("数据库端口无效"))?;
    url.set_username(&user)
        .map_err(|_| anyhow::anyhow!("数据库用户名无效"))?;
    url.set_password(Some(&password))
        .map_err(|_| anyhow::anyhow!("数据库密码无效"))?;
    url.set_path(&database);
    Ok(url.into())
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
