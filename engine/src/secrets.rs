//! Credentials live in the host's OS keychain (Windows Credential Manager /
//! macOS Keychain). The host hands them to the engine over the stdio pipe at
//! startup; the engine keeps them only in memory and never persists, logs or
//! returns them.
//!
//! Names: `mineru`, and `provider:<id>` for each large-model provider. A
//! provider value may hold several keys separated by commas or new lines;
//! requests then rotate through them.

use std::{collections::HashMap, sync::RwLock};

use anyhow::Result;

pub const MINERU: &str = "mineru";

pub fn provider_secret(id: &str) -> String {
    format!("provider:{id}")
}

pub fn validate_name(name: &str) -> Result<()> {
    if name == MINERU {
        return Ok(());
    }
    match name.strip_prefix("provider:") {
        Some(id) => crate::providers::validate_id(id),
        None => anyhow::bail!("未知的密钥名称：{name}"),
    }
}

/// Every non-empty key of a list separated by commas, spaces or new lines.
pub fn split_keys(value: &str) -> Vec<String> {
    value
        .split([',', '，', '\n', '\r', ' ', '\t', ';'])
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .map(str::to_string)
        .collect()
}

/// The last four characters of a key long enough for that to reveal little.
pub fn tail(key: &str) -> String {
    let chars = key.chars().collect::<Vec<_>>();
    if chars.len() < 12 {
        return String::new();
    }
    chars[chars.len() - 4..].iter().collect()
}

#[derive(Default)]
pub struct Secrets {
    values: RwLock<HashMap<String, String>>,
}

impl Secrets {
    pub fn get(&self, name: &str) -> Option<String> {
        self.values
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .get(name)
            .cloned()
            .filter(|value| !value.trim().is_empty())
    }

    pub fn keys(&self, name: &str) -> Vec<String> {
        self.get(name).map(|value| split_keys(&value)).unwrap_or_default()
    }

    pub fn set(&self, name: &str, value: Option<String>) {
        let value = value
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let mut values = self.values.write().unwrap_or_else(|error| error.into_inner());
        match value {
            Some(value) => {
                values.insert(name.to_string(), value);
            }
            None => {
                values.remove(name);
            }
        }
    }

    pub fn configured(&self, name: &str) -> bool {
        self.get(name).is_some()
    }

    /// A short hint such as `••••••••1a2b` (and the number of keys). Short
    /// values show no characters at all.
    pub fn masked(&self, name: &str) -> Option<String> {
        let keys = self.keys(name);
        let last = keys.last()?;
        let suffix = tail(last);
        Some(if keys.len() > 1 {
            format!("••••••••{suffix}（共 {} 个）", keys.len())
        } else {
            format!("••••••••{suffix}")
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blank_values_are_not_configured_and_masks_only_show_a_suffix() {
        let secrets = Secrets::default();
        secrets.set("provider:google", Some("   ".into()));
        assert!(!secrets.configured("provider:google"));
        secrets.set("provider:deepseek", Some(" sk-abcdef123456 ".into()));
        assert_eq!(secrets.get("provider:deepseek").as_deref(), Some("sk-abcdef123456"));
        assert_eq!(secrets.masked("provider:deepseek").as_deref(), Some("••••••••3456"));
        secrets.set("provider:deepseek", None);
        assert!(secrets.masked("provider:deepseek").is_none());
        secrets.set("provider:local", Some("short-key".into()));
        assert_eq!(secrets.masked("provider:local").as_deref(), Some("••••••••"));
    }

    #[test]
    fn several_keys_are_split_and_counted() {
        let secrets = Secrets::default();
        secrets.set("provider:x", Some("sk-one1111, sk-two2222\nsk-three3333".into()));
        assert_eq!(secrets.keys("provider:x").len(), 3);
        assert_eq!(secrets.masked("provider:x").as_deref(), Some("••••••••3333（共 3 个）"));
        assert!(validate_name("provider:deep-seek_1").is_ok());
        assert!(validate_name("provider:bad id").is_err());
        assert!(validate_name("google").is_err());
        assert!(validate_name(MINERU).is_ok());
    }
}
