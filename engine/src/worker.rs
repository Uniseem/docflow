//! In-process job scheduler. The desktop engine is the only writer of its
//! library, so claims need no locks beyond the scheduler's own sequencing.

use std::{collections::HashMap, sync::Arc, time::Duration};

use anyhow::Result;
use chrono::{DateTime, Utc};
use tokio::task::{Id, JoinSet};

use crate::{
    db,
    events::{self, EventInput},
    library, now, pipeline,
    state::AppState,
};

const MAX_ATTEMPTS: i64 = 3;

pub async fn run(state: Arc<AppState>) {
    let mut running: JoinSet<(String, Result<()>)> = JoinSet::new();
    let mut tasks: HashMap<Id, String> = HashMap::new();
    tracing::info!("document scheduler started");
    loop {
        let limit = state.worker_limit();
        while running.len() < limit {
            match claim(&state).await {
                Ok(Some((id, attempt))) => {
                    tracing::info!(document_id = %id, attempt, "job claimed");
                    let _ = events::append(
                        &state.pool,
                        &id,
                        EventInput {
                            stage: "worker_claimed",
                            state: "completed",
                            level: "success",
                            progress: 3,
                            message: "开始处理任务",
                            detail: Some(&format!("第 {attempt} / {MAX_ATTEMPTS} 次尝试")),
                            current: Some(attempt),
                            total: Some(MAX_ATTEMPTS),
                        },
                    )
                    .await;
                    events::document_changed(&id);
                    let job_state = state.clone();
                    let job_id = id.clone();
                    let handle = running.spawn(async move {
                        let result = pipeline::process(job_state, &job_id).await;
                        (job_id, result)
                    });
                    tasks.insert(handle.id(), id.clone());
                    state
                        .jobs
                        .lock()
                        .unwrap_or_else(|error| error.into_inner())
                        .insert(id, handle);
                }
                Ok(None) => break,
                Err(error) => {
                    tracing::error!(%error, "claim failed");
                    break;
                }
            }
        }
        let idle = next_due(&state).await.unwrap_or(Duration::from_secs(30));
        tokio::select! {
            _ = state.wake.notified() => {}
            joined = running.join_next_with_id(), if !running.is_empty() => {
                if let Some(joined) = joined {
                    finish(&state, &mut tasks, joined).await;
                }
            }
            _ = tokio::time::sleep(idle) => {}
        }
    }
}

async fn finish(
    state: &Arc<AppState>,
    tasks: &mut HashMap<Id, String>,
    joined: Result<(Id, (String, Result<()>)), tokio::task::JoinError>,
) {
    match joined {
        Ok((task, (id, result))) => {
            tasks.remove(&task);
            state
                .jobs
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(&id);
            if let Err(error) = result {
                tracing::error!(document_id = %id, error = %format!("{error:#}"), "job failed");
                if let Err(error) = fail_or_retry(state, &id, &error).await {
                    tracing::error!(document_id = %id, %error, "could not record job failure");
                }
            }
            events::document_changed(&id);
        }
        Err(error) => {
            let Some(id) = tasks.remove(&error.id()) else {
                return;
            };
            state
                .jobs
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .remove(&id);
            if error.is_panic() {
                let failure = anyhow::anyhow!("处理过程中发生内部错误");
                let _ = fail_or_retry(state, &id, &failure).await;
            }
            // A cancelled task was stopped by `library::cancel` / `delete`,
            // which already recorded the new status.
            events::document_changed(&id);
        }
    }
}

async fn claim(state: &AppState) -> Result<Option<(String, i64)>> {
    let now = db::timestamp(Utc::now());
    Ok(sqlx::query_as::<_, (String, i64)>(concat!(
        "UPDATE documents SET status='processing',stage='worker_claimed',progress=MAX(progress,3),\
         queue_attempts=queue_attempts+1,failure_reason=NULL,started_at=COALESCE(started_at,",
        now!(),
        "),updated_at=",
        now!(),
        " WHERE id=(SELECT id FROM documents WHERE status IN ('queued','retrying') AND queue_available_at<=$1 \
         ORDER BY queue_available_at, created_at LIMIT 1) RETURNING id, queue_attempts"
    ))
    .bind(now)
    .fetch_optional(&state.pool)
    .await?)
}

/// Time until the next delayed retry becomes available.
async fn next_due(state: &AppState) -> Option<Duration> {
    let next: Option<String> = sqlx::query_scalar(
        "SELECT MIN(queue_available_at) FROM documents WHERE status IN ('queued','retrying')",
    )
    .fetch_one(&state.pool)
    .await
    .ok()?;
    let next = DateTime::parse_from_rfc3339(&next?).ok()?.with_timezone(&Utc);
    let wait = (next - Utc::now()).to_std().unwrap_or(Duration::ZERO);
    Some(wait.max(Duration::from_millis(200)))
}

async fn fail_or_retry(state: &AppState, id: &str, error: &anyhow::Error) -> Result<()> {
    let (attempt, progress): (i64, i64) =
        sqlx::query_as("SELECT queue_attempts, progress FROM documents WHERE id=$1")
            .bind(id)
            .fetch_one(&state.pool)
            .await?;
    let detail = format!("{error:#}");
    let reason = detail.chars().take(2_000).collect::<String>();
    let permanent = pipeline::is_permanent(error) || library::is_permanent_input_error(error);
    if !permanent && attempt < MAX_ATTEMPTS {
        let delay = 20 * attempt.max(1);
        let available = db::timestamp(Utc::now() + chrono::Duration::seconds(delay));
        let updated = sqlx::query(concat!(
            "UPDATE documents SET status='retrying',stage='retrying',failure_reason=$2,queue_available_at=$3,updated_at=",
            now!(),
            " WHERE id=$1 AND status='processing'"
        ))
        .bind(id)
        .bind(&reason)
        .bind(available)
        .execute(&state.pool)
        .await?;
        if updated.rows_affected() == 0 {
            return Ok(());
        }
        events::append(
            &state.pool,
            id,
            EventInput {
                stage: "retrying",
                state: "warning",
                level: "warning",
                progress: progress as i32,
                message: "本次处理未完成，稍后自动重试",
                detail: Some(&format!(
                    "第 {attempt} / {MAX_ATTEMPTS} 次尝试失败；{delay} 秒后重试。已通过校验的翻译分块会直接复用。原因：{}",
                    detail.chars().take(900).collect::<String>()
                )),
                current: Some(attempt),
                total: Some(MAX_ATTEMPTS),
            },
        )
        .await?;
    } else {
        let updated = sqlx::query(concat!(
            "UPDATE documents SET status='failed',stage='failed',failure_reason=$2,updated_at=",
            now!(),
            " WHERE id=$1 AND status='processing'"
        ))
        .bind(id)
        .bind(&reason)
        .execute(&state.pool)
        .await?;
        if updated.rows_affected() == 0 {
            return Ok(());
        }
        events::append(
            &state.pool,
            id,
            EventInput {
                stage: "failed",
                state: "failed",
                level: "error",
                progress: progress as i32,
                message: if permanent {
                    "任务无法完成"
                } else {
                    "多次自动尝试均未成功，任务已停止"
                },
                detail: Some(&format!(
                    "源文件、处理记录和可复用的翻译断点均已保留，调整设置后可点击“重新处理”。原因：{}",
                    detail.chars().take(1_200).collect::<String>()
                )),
                current: Some(attempt),
                total: Some(MAX_ATTEMPTS),
            },
        )
        .await?;
    }
    Ok(())
}
