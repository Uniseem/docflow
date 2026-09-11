use std::{path::Path, str::FromStr, time::Duration};

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use sqlx::{
    SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
};

/// SQL expression for the current UTC time, in the same text format as
/// [`timestamp`]. Use through `concat!(... now!() ...)` in query literals.
#[macro_export]
macro_rules! now {
    () => {
        "strftime('%Y-%m-%dT%H:%M:%fZ','now')"
    };
}

/// Formats a timestamp exactly like [`now!`], so text comparisons stay valid.
pub fn timestamp(value: DateTime<Utc>) -> String {
    value.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

pub async fn open(path: &Path) -> Result<SqlitePool> {
    let options = SqliteConnectOptions::from_str("sqlite://")?
        .filename(path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(15));
    let pool = SqlitePoolOptions::new()
        .max_connections(8)
        .connect_with(options)
        .await
        .with_context(|| format!("无法打开文档库数据库 {}", path.display()))?;
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .context("文档库数据库迁移失败")?;
    Ok(pool)
}

#[cfg(test)]
pub async fn open_memory() -> SqlitePool {
    let options = SqliteConnectOptions::from_str("sqlite::memory:")
        .unwrap()
        .foreign_keys(true);
    // A single connection keeps the in-memory database alive and shared.
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .unwrap();
    sqlx::migrate!("./migrations").run(&pool).await.unwrap();
    pool
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn sql_and_rust_timestamps_share_one_sortable_format() {
        let pool = open_memory().await;
        let sql: String = sqlx::query_scalar(concat!("SELECT ", now!()))
            .fetch_one(&pool)
            .await
            .unwrap();
        let rust = timestamp(Utc::now());
        assert_eq!(sql.len(), rust.len());
        assert!(sql.ends_with('Z') && rust.ends_with('Z'));
        assert!(DateTime::parse_from_rfc3339(&sql).is_ok());
        let decoded: DateTime<Utc> = sqlx::query_scalar(concat!("SELECT ", now!()))
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!((Utc::now() - decoded).num_seconds().abs() < 5);
    }
}
