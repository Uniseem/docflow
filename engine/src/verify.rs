//! Live checks behind the settings buttons: the MinerU key and large-model
//! providers (model list and a test request). Keys are never logged;
//! provider error bodies are redacted before they reach the user.

use std::time::Duration;

use anyhow::{Context, Result};

use crate::{
    http::Network,
    providers::{self, CheckResult, Endpoint, RemoteModel},
};

pub async fn mineru(network: &Network, key: &str) -> Result<()> {
    let key = key.trim();
    anyhow::ensure!(key.len() >= 8, "MinerU API Key 格式不正确");
    let response = network
        .builder()?
        .timeout(Duration::from_secs(25))
        .build()?
        .get("https://mineru.net/api/v4/extract/task/00000000-0000-0000-0000-000000000000")
        .bearer_auth(key)
        .send()
        .await
        .context("无法连接 MinerU，请检查网络或代理设置")?;
    if matches!(response.status().as_u16(), 401 | 403) {
        anyhow::bail!("MinerU API Key 无效或没有权限");
    }
    Ok(())
}

fn client(network: &Network, seconds: u64) -> Result<reqwest::Client> {
    Ok(network
        .builder()?
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(seconds))
        .build()?)
}

pub async fn models(network: &Network, endpoint: &Endpoint, key: Option<&str>, name: &str) -> Result<Vec<RemoteModel>> {
    providers::list_models(&client(network, 45)?, endpoint, key, name).await
}

pub async fn provider(network: &Network, endpoint: &Endpoint, key: Option<&str>, model: &str, name: &str) -> Result<CheckResult> {
    providers::check(&client(network, 90)?, endpoint, key, model, name).await
}
