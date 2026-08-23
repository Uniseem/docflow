use std::{
    path::Path,
    sync::Arc,
    time::{Duration, Instant},
};

use anyhow::{Context, Result};
use reqwest::Body;
use serde_json::{Value, json};
use tokio_util::io::ReaderStream;

use crate::{db::AppState, events};

const BASE: &str = "https://mineru.net/api/v4";

pub async fn parse(
    state: &Arc<AppState>,
    id: &str,
    source: &Path,
    api_key: &str,
    model: &str,
    existing: Option<&str>,
) -> Result<String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(90))
        .no_proxy()
        .build()?;
    let batch = if let Some(batch) = existing {
        events::progress(
            &state.pool,
            id,
            "mineru_resuming",
            7,
            "恢复已存在的 MinerU 批次",
            Some(&format!("批次 ID：{batch}；不会重复上传源文件")),
        )
        .await?;
        batch.to_string()
    } else {
        events::progress(
            &state.pool,
            id,
            "mineru_requesting_upload",
            5,
            "正在向 MinerU 申请一次性上传地址",
            Some(&format!("解析模型 {model}；公式与表格识别均启用")),
        )
        .await?;
        let name = source
            .file_name()
            .and_then(|v| v.to_str())
            .unwrap_or("document.pdf");
        let response=client.post(format!("{BASE}/file-urls/batch")).bearer_auth(api_key).json(&json!({"files":[{"name":name,"data_id":id}],"model_version":model,"enable_formula":true,"enable_table":true,"language":"ch"})).send().await?;
        let payload: Value = response
            .json()
            .await
            .context("MinerU 上传地址响应不是 JSON")?;
        ensure_ok(&payload)?;
        let data = &payload["data"];
        let batch = data["batch_id"]
            .as_str()
            .context("MinerU 未返回 batch_id")?
            .to_string();
        let upload = data["file_urls"]
            .as_array()
            .and_then(|v| v.first())
            .and_then(Value::as_str)
            .context("MinerU 未返回 file_urls")?;
        let size = tokio::fs::metadata(source).await?.len();
        events::progress(
            &state.pool,
            id,
            "mineru_uploading",
            6,
            "正在把源文件直传 MinerU",
            Some(&format!(
                "文件大小 {size} 字节；上传地址为 MinerU 签发且不会写入文章"
            )),
        )
        .await?;
        let file = tokio::fs::File::open(source).await?;
        let upload_response = reqwest::Client::builder()
            .timeout(Duration::from_secs(900))
            .no_proxy()
            .build()?
            .put(upload)
            .body(Body::wrap_stream(ReaderStream::new(file)))
            .send()
            .await?;
        if !upload_response.status().is_success() {
            anyhow::bail!("上传 MinerU 失败（HTTP {}）", upload_response.status());
        }
        sqlx::query("UPDATE documents SET mineru_task_id=$2,updated_at=NOW() WHERE id=$1")
            .bind(id)
            .bind(&batch)
            .execute(&state.pool)
            .await?;
        events::progress(
            &state.pool,
            id,
            "mineru_uploaded",
            9,
            "源文件已传入 MinerU，批次创建完成",
            Some(&format!("批次 ID：{batch}")),
        )
        .await?;
        batch
    };
    let started = Instant::now();
    let mut poll = 0i64;
    loop {
        if started.elapsed().as_secs() > state.config.mineru_max_wait_seconds {
            anyhow::bail!(
                "等待 MinerU 超过 {} 秒",
                state.config.mineru_max_wait_seconds
            );
        }
        poll += 1;
        let response = client
            .get(format!("{BASE}/extract-results/batch/{batch}"))
            .bearer_auth(api_key)
            .send()
            .await;
        let payload: Value = match response {
            Ok(v) => v.json().await.context("MinerU 状态响应不是 JSON")?,
            Err(error) => {
                crate::events::append(
                    &state.pool,
                    id,
                    crate::events::EventInput {
                        stage: "mineru_network_retry",
                        state: "warning",
                        level: "warning",
                        progress: 12,
                        message: "MinerU 状态查询暂时失败，稍后自动继续",
                        detail: Some(&error.to_string()),
                        current: Some(poll),
                        total: None,
                    },
                )
                .await?;
                tokio::time::sleep(Duration::from_secs(state.config.mineru_poll_seconds)).await;
                continue;
            }
        };
        ensure_ok(&payload)?;
        let results = payload["data"]
            .get("extract_result")
            .or_else(|| payload["data"].get("extract_results"))
            .and_then(Value::as_array);
        let result = results.and_then(|items| {
            items
                .iter()
                .find(|v| v["data_id"].as_str() == Some(id))
                .or_else(|| items.first())
        });
        if let Some(result) = result {
            let raw = result["state"].as_str().unwrap_or("pending");
            if raw == "done" {
                let url = result["full_zip_url"]
                    .as_str()
                    .context("MinerU 完成但未返回 full_zip_url")?;
                events::progress(
                    &state.pool,
                    id,
                    "mineru_done",
                    52,
                    "MinerU 解析完成",
                    Some(&format!(
                        "共轮询 {poll} 次，耗时 {} 秒；即将下载结构化结果",
                        started.elapsed().as_secs()
                    )),
                )
                .await?;
                return Ok(url.to_string());
            }
            if raw == "failed" {
                anyhow::bail!(
                    "MinerU 解析失败：{}",
                    result["err_msg"].as_str().unwrap_or("未知错误")
                );
            }
            let detail = &result["extract_progress"];
            let done = detail["extracted_pages"].as_i64();
            let total = detail["total_pages"].as_i64();
            let percent = if let (Some(done), Some(total)) = (done, total) {
                15 + (done * 35 / total.max(1)) as i32
            } else {
                match raw {
                    "waiting-file" => 10,
                    "pending" => 13,
                    "converting" => 18,
                    "running" => 28,
                    _ => 15,
                }
            };
            sqlx::query("UPDATE documents SET stage=$2,progress=$3,pages_processed=$4,pages_total=$5,last_heartbeat_at=NOW(),updated_at=NOW() WHERE id=$1").bind(id).bind(format!("mineru_{raw}")).bind(percent).bind(done.map(|v|v as i32)).bind(total.map(|v|v as i32)).execute(&state.pool).await?;
            crate::events::append(
                &state.pool,
                id,
                crate::events::EventInput {
                    stage: &format!("mineru_{raw}"),
                    state: "running",
                    level: "info",
                    progress: percent,
                    message: &format!("MinerU 第 {poll} 次状态：{raw}"),
                    detail: Some(&format!(
                        "已等待 {} 秒；页面 {} / {}",
                        started.elapsed().as_secs(),
                        done.map(|v| v.to_string()).unwrap_or_else(|| "?".into()),
                        total.map(|v| v.to_string()).unwrap_or_else(|| "?".into())
                    )),
                    current: done,
                    total,
                },
            )
            .await?;
        } else {
            events::progress(
                &state.pool,
                id,
                "mineru_waiting",
                12,
                "MinerU 已接收批次，等待任务记录出现",
                Some(&format!(
                    "第 {poll} 次查询；已等待 {} 秒",
                    started.elapsed().as_secs()
                )),
            )
            .await?;
        }
        tokio::time::sleep(Duration::from_secs(state.config.mineru_poll_seconds)).await;
    }
}

fn ensure_ok(value: &Value) -> Result<()> {
    if value["code"].as_i64().unwrap_or(-1) != 0 {
        anyhow::bail!(
            "MinerU 请求失败：{}",
            value["msg"].as_str().unwrap_or("未知错误")
        );
    }
    Ok(())
}
