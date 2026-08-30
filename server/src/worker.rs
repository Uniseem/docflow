use std::{sync::Arc, time::Duration};

use anyhow::{Context, Result};
use sqlx::{Connection, PgConnection, Row};
use tokio::task::JoinSet;
use uuid::Uuid;

use crate::{
    db::AppState,
    events::{self, EventInput},
    pipeline, settings,
};

pub async fn run(state: Arc<AppState>) -> Result<()> {
    // Provider concurrency limits are account-wide, so the Compose deployment must
    // have exactly one site-wide pool owner even if someone tries `--scale worker`.
    // Keep the advisory lock on a dedicated, non-reconnecting connection. A pool
    // checkout would consume the only slot when DATABASE_POOL_SIZE=1, and a
    // silently replaced connection must not be mistaken for lock ownership.
    let mut pool_owner = PgConnection::connect(&state.config.database_url)
        .await
        .context("建立全站翻译池锁连接失败")?;
    let acquired: bool = sqlx::query_scalar("SELECT pg_try_advisory_lock(381001337)")
        .fetch_one(&mut pool_owner)
        .await?;
    if !acquired {
        anyhow::bail!("已有 Worker 持有全站翻译任务池；请勿横向扩容 worker 服务");
    }
    let pools = state
        .translation_pools
        .as_ref()
        .context("全站翻译任务池未初始化")?;
    pools.update_limits(&settings::load_translation_runtime(&state.pool, &state.config).await?);
    let refresh_state = state.clone();
    let settings_refresh = tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(2)).await;
            match settings::load_translation_runtime(&refresh_state.pool, &refresh_state.config)
                .await
            {
                Ok(runtime) => {
                    if let Some(pools) = &refresh_state.translation_pools {
                        pools.update_limits(&runtime);
                    }
                }
                Err(error) => tracing::warn!(%error, "保留最后有效的翻译并发配置，稍后重新读取"),
            }
        }
    });
    let instance = format!("{}-{}", hostname(), Uuid::new_v4());
    tracing::info!(concurrency=state.config.worker_concurrency, %instance, "PostgreSQL worker started");
    let mut workers = JoinSet::new();
    for slot in 0..state.config.worker_concurrency {
        let state = state.clone();
        let worker_id = format!("{instance}-{slot}");
        workers.spawn(async move { worker_loop(state, worker_id).await });
    }
    let mut lock_check = tokio::time::interval(Duration::from_secs(5));
    lock_check.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let result = loop {
        tokio::select! {
            outcome = workers.join_next() => {
                break match outcome {
                    Some(Ok(Err(error))) => Err(error.context("Worker 任务异常退出")),
                    Some(Err(error)) => Err(anyhow::Error::from(error).context("Worker 任务意外退出")),
                    _ => Err(anyhow::anyhow!("Worker 任务提前结束，停止全站翻译池以避免部分失效")),
                };
            }
            _ = lock_check.tick() => {
                // SELECT on this same PgConnection fails after a database restart
                // or connection loss. Stop all in-flight work before Compose
                // restarts this process and acquires a new advisory lock.
                let alive = tokio::time::timeout(Duration::from_secs(5),
                    sqlx::query_scalar::<_, i32>("SELECT 1").fetch_one(&mut pool_owner)).await;
                if !matches!(alive, Ok(Ok(1))) {
                    break Err(anyhow::anyhow!("全站翻译池锁连接失效，已停止所有 Worker；重启后重新竞争锁"));
                }
            }
        }
    };
    workers.shutdown().await;
    settings_refresh.abort();
    let _ = settings_refresh.await;
    drop(pool_owner);
    result
}

fn hostname() -> String {
    std::env::var("HOSTNAME").unwrap_or_else(|_| "docflow-worker".into())
}

async fn worker_loop(state: Arc<AppState>, worker_id: String) -> Result<()> {
    loop {
        match claim(&state, &worker_id).await {
            Ok(Some((id, attempt))) => {
                tracing::info!(document_id=%id, attempt, %worker_id, "job claimed");
                events::append(
                    &state.pool,
                    &id,
                    EventInput {
                        stage: "worker_claimed",
                        state: "completed",
                        level: "success",
                        progress: 3,
                        message: "并发 Worker 已原子领取任务",
                        detail: Some(
                            "任务租约和尝试次数已写入 PostgreSQL；其他 Worker 会跳过本任务",
                        ),
                        current: Some(attempt as i64),
                        total: Some(3),
                    },
                )
                .await?;
                if let Err(error) = pipeline::process(state.clone(), &id).await {
                    tracing::error!(document_id=%id, %error, "job failed");
                    fail_or_retry(&state, &id, attempt, &error).await?;
                }
            }
            Ok(None) => tokio::time::sleep(Duration::from_millis(900)).await,
            Err(error) => {
                tracing::error!(%error, %worker_id, "claim failed");
                tokio::time::sleep(Duration::from_secs(3)).await;
            }
        }
    }
}

async fn claim(state: &AppState, worker_id: &str) -> Result<Option<(String, i32)>> {
    let row = sqlx::query(
        "WITH candidate AS (\
           SELECT id FROM documents \
           WHERE (status IN ('queued','retrying') AND queue_available_at <= NOW()) \
              OR (status='processing' AND COALESCE(last_heartbeat_at, queue_locked_at, updated_at) < NOW() - INTERVAL '20 minutes') \
           ORDER BY queue_available_at, created_at \
           FOR UPDATE SKIP LOCKED LIMIT 1\
         ) \
         UPDATE documents d SET status='processing', stage='worker_claimed', progress=GREATEST(progress,3), \
           queue_attempts=queue_attempts+1, queue_locked_at=NOW(), queue_locked_by=$1, last_heartbeat_at=NOW(), updated_at=NOW() \
         FROM candidate WHERE d.id=candidate.id RETURNING d.id,d.queue_attempts"
    ).bind(worker_id).fetch_optional(&state.pool).await?;
    Ok(row.map(|row| (row.get("id"), row.get("queue_attempts"))))
}

async fn fail_or_retry(
    state: &AppState,
    id: &str,
    attempt: i32,
    error: &anyhow::Error,
) -> Result<()> {
    let detail = format!("{error:#}");
    if attempt < 3 {
        let delay = 20 * attempt.max(1);
        sqlx::query("UPDATE documents SET status='retrying',stage='retrying',failure_reason=$2,queue_available_at=NOW()+make_interval(secs=>$3),queue_locked_at=NULL,queue_locked_by=NULL,updated_at=NOW() WHERE id=$1")
            .bind(id).bind(detail.chars().take(2000).collect::<String>()).bind(delay).execute(&state.pool).await?;
        events::append(
            &state.pool,
            id,
            EventInput {
                stage: "retrying",
                state: "warning",
                level: "warning",
                progress: current_progress(state, id).await,
                message: "本次处理未完成，任务已进入持久重试队列",
                detail: Some(&format!(
                    "第 {attempt} / 3 次尝试失败；{delay} 秒后可由任一 Worker 重新领取。源文件始终保留，已经通过校验的翻译分块也已写入本地断点缓存，下次会直接复用。原因：{}",
                    detail.chars().take(900).collect::<String>()
                )),
                current: Some(attempt as i64),
                total: Some(3),
            },
        )
        .await?;
    } else {
        sqlx::query("UPDATE documents SET status='failed',stage='failed',failure_reason=$2,queue_locked_at=NULL,queue_locked_by=NULL,updated_at=NOW() WHERE id=$1")
            .bind(id).bind(detail.chars().take(2000).collect::<String>()).execute(&state.pool).await?;
        events::append(
            &state.pool,
            id,
            EventInput {
                stage: "failed",
                state: "failed",
                level: "error",
                progress: current_progress(state, id).await,
                message: "三次自动尝试均未成功，任务最终停止",
                detail: Some(&format!(
                    "源文件、全部事件和可复用翻译断点仍保留；管理员修复配置后可在后台文档管理中重新排队。最终原因：{}",
                    detail.chars().take(1200).collect::<String>()
                )),
                current: Some(attempt as i64),
                total: Some(3),
            },
        )
        .await?;
    }
    Ok(())
}

async fn current_progress(state: &AppState, id: &str) -> i32 {
    sqlx::query_scalar("SELECT progress FROM documents WHERE id=$1")
        .bind(id)
        .fetch_one(&state.pool)
        .await
        .unwrap_or(3)
}
