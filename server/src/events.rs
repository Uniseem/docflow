use anyhow::Result;
use serde::Serialize;
use sqlx::PgPool;

use crate::models::ProcessingEvent;

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
    pool: &PgPool,
    document_id: &str,
    event: EventInput<'_>,
) -> Result<ProcessingEvent> {
    let record = sqlx::query_as::<_, ProcessingEvent>(
        "INSERT INTO processing_events \
         (document_id, stage, state, level, progress, message, detail, current, total, created_at) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW()) \
         RETURNING id, document_id, stage, state, level, progress, message, detail, current, total, created_at"
    )
    .bind(document_id).bind(event.stage).bind(event.state).bind(event.level)
    .bind(event.progress).bind(event.message).bind(event.detail).bind(event.current).bind(event.total)
    .fetch_one(pool).await?;
    let payload = serde_json::to_string(&record)?;
    let _ = sqlx::query("SELECT pg_notify('docflow_events', $1)")
        .bind(payload)
        .execute(pool)
        .await;
    Ok(record)
}

pub async fn progress(
    pool: &PgPool,
    document_id: &str,
    stage: &str,
    percent: i32,
    message: &str,
    detail: Option<&str>,
) -> Result<()> {
    sqlx::query("UPDATE documents SET status='processing', stage=$2, progress=$3, updated_at=NOW(), last_heartbeat_at=NOW() WHERE id=$1")
        .bind(document_id).bind(stage).bind(percent).execute(pool).await?;
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
