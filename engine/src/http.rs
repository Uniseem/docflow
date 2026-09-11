//! Outbound HTTP configuration. Desktop users often need a proxy to reach
//! Google Translate or a model provider, so every client honours one setting.
//! "System" reads the Windows registry proxy or the macOS network settings.

use std::sync::RwLock;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
pub enum ProxySettings {
    /// Environment variables, then the Windows / macOS system proxy.
    System,
    /// Direct connections only.
    Direct,
    /// An explicit `http://`, `https://` or `socks5://` proxy.
    Custom { url: String },
}

impl Default for ProxySettings {
    fn default() -> Self {
        Self::System
    }
}

impl ProxySettings {
    pub fn validate(&self) -> Result<()> {
        if let Self::Custom { url } = self {
            let parsed = url::Url::parse(url.trim()).context("代理地址格式不正确")?;
            anyhow::ensure!(
                matches!(parsed.scheme(), "http" | "https" | "socks5" | "socks5h"),
                "代理地址只支持 http、https 或 socks5"
            );
            anyhow::ensure!(parsed.host_str().is_some(), "代理地址缺少主机名");
        }
        Ok(())
    }
}

#[derive(Default)]
pub struct Network {
    proxy: RwLock<ProxySettings>,
}

impl Network {
    pub fn proxy(&self) -> ProxySettings {
        self.proxy
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    pub fn set_proxy(&self, proxy: ProxySettings) {
        *self.proxy.write().unwrap_or_else(|error| error.into_inner()) = proxy;
    }

    /// A client builder with the current proxy policy applied.
    pub fn builder(&self) -> Result<reqwest::ClientBuilder> {
        apply(reqwest::Client::builder(), &self.proxy())
    }
}

pub fn apply(builder: reqwest::ClientBuilder, proxy: &ProxySettings) -> Result<reqwest::ClientBuilder> {
    Ok(match proxy {
        ProxySettings::System => builder,
        ProxySettings::Direct => builder.no_proxy(),
        ProxySettings::Custom { url } => builder
            .proxy(reqwest::Proxy::all(url.trim()).context("代理地址无效")?),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proxy_settings_round_trip_and_reject_unknown_schemes() {
        for proxy in [
            ProxySettings::System,
            ProxySettings::Direct,
            ProxySettings::Custom {
                url: "http://127.0.0.1:7890".into(),
            },
        ] {
            let json = serde_json::to_string(&proxy).unwrap();
            assert_eq!(serde_json::from_str::<ProxySettings>(&json).unwrap(), proxy);
            proxy.validate().unwrap();
        }
        assert!(
            ProxySettings::Custom {
                url: "ftp://proxy".into()
            }
            .validate()
            .is_err()
        );
        assert!(
            ProxySettings::Custom {
                url: "not a url".into()
            }
            .validate()
            .is_err()
        );
    }
}
