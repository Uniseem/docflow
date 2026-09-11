use std::sync::OnceLock;

use anyhow::Result;
use serde::Serialize;
use serde_json::json;
use sqlx::SqlitePool;
use tokio::sync::mpsc;

use crate::{models::ProcessingEvent, now};

/// Serialized JSON-RPC notifications for the host application. The engine
/// has exactly one host connection, so a process-wide sink keeps pipeline
/// code independent of the transport.
static SINK: OnceLock<mpsc::UnboundedSender<String>> = OnceLock::new();

pub fn install_sink(sender: mpsc::UnboundedSender<String>) {
    let _ = SINK.set(sender);
}

pub fn notify(method: &str, params: impl Serialize) {
    let Some(sink) = SINK.get() else {
        return;
    };
    match serde_json::to_string(&json!({ "method": method, "params": params })) {
        Ok(line) => {
            let _ = sink.send(line);
        }
        Err(error) => tracing::warn!(%error, method, "无法序列化通知"),
    }
}

/// Tells the host to refetch a document after a status or metadata change.
pub fn document_changed(id: &str) {
    notify("document.changed", json!({ "id": id }));
}

pub fn document_removed(id: &str) {
    notify("document.removed", json!({ "id": id }));
}

#[derive(Debug, Clone, Serialize)]
pub struct EventInput<'a> {
    pub stage: &'a str,
    pub state: &'a str,
    pub level: &'a str,
    pub progress: i32,
    pub message: &'a str,
    pub detail: Option<&'a str>,
    pub current: Option<i64>,
    pub total: Option<i64>,
}

pub async fn append(
    pool: &SqlitePool,
    document_id: &str,
    event: EventInput<'_>,
) -> Result<ProcessingEvent> {
    let record = sqlx::query_as::<_, ProcessingEvent>(concat!(
        "INSERT INTO processing_events \
         (document_id, stage, state, level, progress, message, detail, current, total, created_at) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,",
        now!(),
        ") RETURNING id, document_id, stage, state, level, progress, message, detail, current, total, created_at"
    ))
    .bind(document_id)
    .bind(event.stage)
    .bind(event.state)
    .bind(event.level)
    .bind(event.progress)
    .bind(event.message)
    .bind(event.detail)
    .bind(event.current)
    .bind(event.total)
    .fetch_one(pool)
    .await?;
    notify("event", &record);
    Ok(record)
}

pub async fn progress(
    pool: &SqlitePool,
    document_id: &str,
    stage: &str,
    percent: i32,
    message: &str,
    detail: Option<&str>,
) -> Result<()> {
    // Never resurrect a job the user cancelled while this step was running.
    sqlx::query(concat!(
        "UPDATE documents SET stage=$2, progress=$3, updated_at=",
        now!(),
        " WHERE id=$1 AND status='processing'"
    ))
    .bind(document_id)
    .bind(stage)
    .bind(percent)
    .execute(pool)
    .await?;
    append(
        pool,
        document_id,
        EventInput {
            stage,
            state: "running",
            level: "info",
            progress: percent,
            message,
            detail,
            current: None,
            total: None,
        },
    )
    .await?;
    Ok(())
}
