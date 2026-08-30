//! The Python child owns PDF layout only. Rust owns credentials, persistent
//! settings, paragraph batching, retries and the two site-wide provider pools.
use std::{
    collections::{HashSet, VecDeque},
    future::Future,
    path::Path,
    pin::Pin,
    process::Stdio,
    sync::{
        Arc, Mutex,
        atomic::{AtomicI32, Ordering},
    },
    time::{Duration, Instant},
};

use anyhow::{Context, Result};
use futures::{StreamExt, stream::FuturesUnordered};
use serde::Deserialize;
use serde_json::json;
use tokio::{
    io::{
        AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt,
        BufReader,
    },
    process::{Child, Command},
    sync::mpsc,
};

use super::{
    archive::{self, ArchiveInput},
    document_root, pdf,
    translate::{
        TranslationHeartbeat,
        native::{MAX_PARAGRAPH_CHARS, NativeRequest, NativeSession},
    },
};
use crate::{
    db::AppState,
    events::{self, EventInput},
};

const MAX_LINE_BYTES: usize = 1_048_576;
const MAX_PENDING: usize = 128;
const MAX_REQUESTS: usize = 100_000;
const STDERR_TAIL_BYTES: usize = 16_384;
const BATCH_FLUSH: Duration = Duration::from_millis(25);

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum EngineEvent {
    Ready {
        pages: i32,
        engine: String,
        version: String,
    },
    Translate {
        request_id: u64,
        text: String,
    },
    Progress {
        stage: String,
        current: u64,
        total: u64,
        percent: f64,
    },
    Result {
        mono: String,
        dual: String,
        pages: i32,
    },
    Error {
        message: String,
    },
}

#[derive(Debug, Clone)]
struct EngineResult {
    pages: i32,
}

#[derive(Default)]
struct ProtocolState {
    pages: Option<i32>,
    seen: HashSet<u64>,
    waiting: HashSet<u64>,
    result: Option<EngineResult>,
}

impl ProtocolState {
    fn accept(&mut self, event: &EngineEvent) -> Result<()> {
        anyhow::ensure!(self.result.is_none(), "PDF 排版器在最终结果后仍返回消息");
        match event {
            EngineEvent::Error { message } => {
                anyhow::bail!("{}", message.chars().take(600).collect::<String>())
            }
            EngineEvent::Ready {
                pages,
                engine,
                version,
            } => {
                anyhow::ensure!(self.pages.is_none(), "PDF 排版器重复初始化");
                anyhow::ensure!(
                    engine == "BabelDOC" && version == "0.6.4",
                    "PDF 排版内核版本不匹配，需要随镜像提供的 BabelDOC 0.6.4"
                );
                anyhow::ensure!((1..=100_000).contains(pages), "PDF 排版器返回无效页数");
                self.pages = Some(*pages);
            }
            EngineEvent::Translate { request_id, text } => {
                anyhow::ensure!(self.pages.is_some(), "PDF 排版器未通过初始化检查");
                anyhow::ensure!(
                    self.seen.len() < MAX_REQUESTS,
                    "PDF 段落数量超过本机安全限制"
                );
                anyhow::ensure!(
                    self.seen.insert(*request_id),
                    "PDF 排版器重复提交同一段落编号"
                );
                anyhow::ensure!(
                    text.chars().count() <= MAX_PARAGRAPH_CHARS,
                    "PDF 段落异常长"
                );
                self.waiting.insert(*request_id);
            }
            EngineEvent::Progress {
                stage,
                current,
                total,
                percent,
            } => {
                anyhow::ensure!(self.pages.is_some(), "PDF 排版器尚未初始化");
                anyhow::ensure!(
                    !stage.is_empty()
                        && stage.len() <= 800
                        && current <= total
                        && *total <= 100_000_000
                        && percent.is_finite()
                        && (0.0..=100.0).contains(percent),
                    "PDF 排版器返回无效进度"
                );
            }
            EngineEvent::Result { mono, dual, pages } => {
                anyhow::ensure!(self.pages == Some(*pages), "PDF 输出页数与输入页数不一致");
                // Never interpret an engine-provided path or URL as a file to publish.
                anyhow::ensure!(
                    mono == "mono.pdf" && dual == "dual.pdf",
                    "PDF 排版器返回不允许的输出名称"
                );
                anyhow::ensure!(
                    !self.seen.is_empty() && self.waiting.is_empty(),
                    "PDF 仍有未完成的翻译段落，拒绝发布部分结果"
                );
                self.result = Some(EngineResult { pages: *pages });
            }
        }
        Ok(())
    }

    fn complete(&mut self, ids: &[u64], replies: &[(u64, String)]) -> Result<()> {
        let returned = replies.iter().map(|(id, _)| *id).collect::<HashSet<_>>();
        anyhow::ensure!(
            returned.len() == ids.len()
                && replies.len() == ids.len()
                && ids
                    .iter()
                    .all(|id| returned.contains(id) && self.waiting.contains(id)),
            "PDF 回填段落编号或数量不一致"
        );
        for id in ids {
            self.waiting.remove(id);
        }
        Ok(())
    }
}

pub async fn process(state: &Arc<AppState>, id: &str, source: &Path, tier: i16) -> Result<()> {
    anyhow::ensure!(
        state.config.pdf2zh_available(),
        "PDF 原生翻译运行环境尚未就绪，请更新包含原生排版内核的服务端镜像"
    );
    // Also renew the lease while waiting for a CPU slot, not only during calls
    // to a translation provider. A queued native job must not be claimed twice.
    let _heartbeat = TranslationHeartbeat::start(state.clone(), id.to_string());
    events::progress(
        &state.pool,
        id,
        "pdf2zh_preflight_queued",
        5,
        "PDF 原生翻译已排队，等待本机排版执行位",
        Some("原生排版使用本机 CPU；Google / DeepSeek 段落请求仍进入与 MinerU 相同的全站任务池"),
    )
    .await?;
    let permit = state
        .native_pdf_slots
        .acquire()
        .await
        .context("PDF 原生排版执行队列已停止")?;
    let progress = Arc::new(AtomicI32::new(5));
    let session = NativeSession::new(state.clone(), id, tier, progress.clone()).await?;
    // A failed attempt can have complete files even if archive publication
    // failed. Never overwrite that attempt; paragraph caches live separately.
    let attempt_root = document_root(&state.config.work_root, id)?
        .join("native-pdf")
        .join(uuid::Uuid::new_v4().simple().to_string());
    let final_root = attempt_root.join("final");
    tokio::fs::create_dir_all(&attempt_root).await?;
    events::progress(&state.pool, id, "pdf2zh_preflight_started", 6, "检查 PDF 文本层并加载本地原生排版内核",
        Some(&format!("BabelDOC 0.6.4；最多 {} 个排版回调；本篇最多 {} 个翻译请求并行，单次最多 {} 段；模型与字体随镜像提供，不在任务期间下载", session.callback_workers(), session.runtime.per_document_concurrency, session.batch_limit()))).await?;
    progress.store(6, Ordering::Relaxed);
    let output = run_engine(state, id, source, &final_root, session).await?;
    drop(permit);
    events::progress(
        &state.pool,
        id,
        "pdf2zh_verified_started",
        90,
        "原生排版完成，检查中文 PDF 和双语 PDF",
        Some("两份文件均须通过文件头、结束标记、完整页数及页面尺寸检查，才会写入永久归档"),
    )
    .await?;
    let mono = final_root.join("mono.pdf");
    let dual = final_root.join("dual.pdf");
    for path in [&mono, &dual] {
        let metadata = tokio::fs::symlink_metadata(path)
            .await
            .context("原生 PDF 输出缺失")?;
        anyhow::ensure!(metadata.file_type().is_file(), "原生 PDF 输出不是普通文件");
        pdf::verify_pdf(path).await?;
    }
    let mono_bytes = tokio::fs::metadata(&mono).await?.len();
    let dual_bytes = tokio::fs::metadata(&dual).await?.len();
    events::append(&state.pool, id, EventInput { stage: "pdf2zh_verified", state: "completed", level: "success", progress: 93,
        message: "中文 PDF 与双语 PDF 已通过校验", detail: Some(&format!("原文 {} 页；中文 PDF {} 字节；双语 PDF {} 页、{} 字节。原有页面尺寸已核对；原生路线不生成 Markdown", output.pages, mono_bytes, output.pages * 2, dual_bytes)),
        current: Some(2), total: Some(2) }).await?;
    archive::archive_and_publish(
        state,
        id,
        ArchiveInput::Pdf2zh {
            source,
            final_root: &final_root,
            mono_pdf: &mono,
            dual_pdf: &dual,
            mono_bytes,
            dual_bytes,
            pages: output.pages,
        },
    )
    .await
}

// Aborting a Worker (e.g. losing the exclusive global-pool lease) must also
// abort pipe readers. The child itself has kill_on_drop enabled below.
struct AbortTask(tokio::task::AbortHandle);
impl Drop for AbortTask {
    fn drop(&mut self) {
        self.0.abort();
    }
}

async fn run_engine(
    state: &Arc<AppState>,
    id: &str,
    source: &Path,
    output: &Path,
    session: Arc<NativeSession>,
) -> Result<EngineResult> {
    let mut command = Command::new(&state.config.pdf2zh_python_binary);
    command
        .arg(&state.config.pdf2zh_runner_script)
        .arg("--input")
        .arg(source)
        .arg("--output")
        .arg(output)
        .arg("--workers")
        .arg(session.callback_workers().to_string())
        .arg("--asset-dir")
        .arg(&state.config.pdf2zh_asset_dir)
        .env_clear()
        .env("PYTHONUTF8", "1")
        .env("PYTHONUNBUFFERED", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // Do not inherit DATABASE_URL, SECRET_KEY, cloud credentials or proxy vars.
    for key in [
        "PATH",
        "SystemRoot",
        "WINDIR",
        "TEMP",
        "TMP",
        "LANG",
        "LC_ALL",
    ] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    let mut child = command.spawn().context("无法启动 PDF 原生排版进程")?;
    let stdin = child.stdin.take().context("PDF 排版输入管道不可用")?;
    let stdout = child.stdout.take().context("PDF 排版输出管道不可用")?;
    let stderr = child.stderr.take().context("PDF 排版日志管道不可用")?;
    let (sender, receiver) = mpsc::channel(MAX_PENDING);
    let reader = tokio::spawn(read_events(stdout, sender));
    let _reader_guard = AbortTask(reader.abort_handle());
    let stderr_tail = Arc::new(Mutex::new(VecDeque::new()));
    let stderr_reader = tokio::spawn(collect_stderr(stderr, stderr_tail.clone()));
    let _stderr_guard = AbortTask(stderr_reader.abort_handle());
    let result = tokio::time::timeout(
        Duration::from_secs(state.config.pdf2zh_timeout_seconds),
        async {
            let result = run_protocol(state, id, session, receiver, stdin).await?;
            let status = child
                .wait()
                .await
                .context("无法读取 PDF 排版进程退出状态")?;
            anyhow::ensure!(
                status.success(),
                "PDF 原生排版进程异常退出（{status}），未发布结果"
            );
            Ok(result)
        },
    )
    .await
    .unwrap_or_else(|_| {
        Err(anyhow::anyhow!(
            "PDF 原生排版超过 {} 秒，已停止本次尝试；源文件和翻译断点保留",
            state.config.pdf2zh_timeout_seconds
        ))
    });
    if result.is_err() {
        stop_child(&mut child).await;
        let tail = stderr_tail
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .copied()
            .collect::<Vec<_>>();
        tracing::warn!(document_id = id, stderr_tail = %String::from_utf8_lossy(&tail), "PDF 原生排版失败；只保留受限日志尾部");
    }
    result
}

async fn stop_child(child: &mut Child) {
    let _ = child.start_kill();
    let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
}

async fn collect_stderr(mut input: impl AsyncRead + Unpin, tail: Arc<Mutex<VecDeque<u8>>>) {
    let mut buffer = [0_u8; 4096];
    while let Ok(count) = input.read(&mut buffer).await {
        if count == 0 {
            break;
        }
        let mut tail = tail.lock().unwrap_or_else(|e| e.into_inner());
        tail.extend(&buffer[..count]);
        let excess = tail.len().saturating_sub(STDERR_TAIL_BYTES);
        tail.drain(..excess);
    }
}

async fn read_events(input: impl AsyncRead + Unpin, sender: mpsc::Sender<Result<EngineEvent>>) {
    let mut input = BufReader::new(input);
    loop {
        let event = match read_bounded_line(&mut input).await {
            Ok(None) => break,
            Ok(Some(line)) => serde_json::from_slice(&line)
                .map_err(|_| anyhow::anyhow!("PDF 排版器返回无效 JSONL 消息")),
            Err(error) => Err(error),
        };
        let failed = event.is_err();
        if sender.send(event).await.is_err() || failed {
            break;
        }
    }
}

async fn read_bounded_line(input: &mut (impl AsyncBufRead + Unpin)) -> Result<Option<Vec<u8>>> {
    let mut result = Vec::new();
    loop {
        let buffer = input.fill_buf().await.context("PDF 排版输出管道读取失败")?;
        if buffer.is_empty() {
            return Ok((!result.is_empty()).then_some(result));
        }
        let count = buffer
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(buffer.len(), |index| index + 1);
        anyhow::ensure!(
            result.len() + count <= MAX_LINE_BYTES,
            "PDF 排版消息超过 1 MiB 安全限制"
        );
        let finished = buffer[count - 1] == b'\n';
        result.extend_from_slice(&buffer[..count]);
        input.consume(count);
        if finished {
            return Ok(Some(result));
        }
    }
}

struct QueuedParagraph {
    arrived: Instant,
    request: NativeRequest,
}
type BatchReply = (Vec<u64>, Result<Vec<(u64, String)>>);
type BatchFuture = Pin<Box<dyn Future<Output = BatchReply> + Send>>;

fn take_ready_batch(
    pending: &mut VecDeque<QueuedParagraph>,
    limit: usize,
    now: Instant,
) -> Option<Vec<NativeRequest>> {
    let first = pending.front()?;
    if pending.len() < limit && now.duration_since(first.arrived) < BATCH_FLUSH {
        return None;
    }
    Some(
        pending
            .drain(..limit.min(pending.len()))
            .map(|item| item.request)
            .collect(),
    )
}

async fn write_reply(
    output: &mut (impl AsyncWrite + Unpin),
    value: serde_json::Value,
) -> Result<()> {
    let mut line = serde_json::to_vec(&value)?;
    line.push(b'\n');
    anyhow::ensure!(
        line.len() <= MAX_LINE_BYTES,
        "PDF 翻译回填消息超过 1 MiB 安全限制"
    );
    output
        .write_all(&line)
        .await
        .context("无法将翻译段落回填到 PDF 排版进程")?;
    output.flush().await?;
    Ok(())
}

async fn run_protocol(
    state: &Arc<AppState>,
    id: &str,
    session: Arc<NativeSession>,
    mut input: mpsc::Receiver<Result<EngineEvent>>,
    output: impl AsyncWrite + Unpin,
) -> Result<EngineResult> {
    let mut output = Some(output);
    let mut completed_at: Option<Instant> = None;
    let mut protocol = ProtocolState::default();
    let mut pending = VecDeque::new();
    let mut active = FuturesUnordered::<BatchFuture>::new();
    let mut timer = tokio::time::interval(BATCH_FLUSH);
    timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut reporter = ProgressReporter::new();
    loop {
        anyhow::ensure!(
            completed_at.is_none_or(|at| at.elapsed() < Duration::from_secs(10)),
            "PDF 排版进程返回结果后未按约定退出，未发布结果"
        );
        while active.len() < session.runtime.per_document_concurrency {
            let Some(batch) = take_ready_batch(&mut pending, session.batch_limit(), Instant::now())
            else {
                break;
            };
            let session = session.clone();
            let ids = batch.iter().map(|item| item.request_id).collect();
            active.push(Box::pin(async move {
                (ids, session.translate_batch(batch).await)
            }));
        }
        tokio::select! {
            event = input.recv() => {
                let Some(event) = event else {
                    anyhow::ensure!(pending.is_empty() && active.is_empty() && protocol.waiting.is_empty(), "PDF 排版进程提前断开，仍有未完成段落");
                    return protocol.result.context("PDF 原生排版进程未返回经过校验的完整结果");
                };
                let event = event?;
                protocol.accept(&event)?;
                match event {
                    EngineEvent::Ready { pages, .. } => {
                        sqlx::query("UPDATE documents SET pages_total=$2,pages_processed=0 WHERE id=$1").bind(id).bind(pages).execute(&state.pool).await?;
                        session.progress.fetch_max(9, Ordering::Relaxed);
                        events::progress(&state.pool, id, "pdf2zh_preflight_completed", 9, "PDF 文本层与本地排版环境检查通过",
                            Some(&format!("原文共 {pages} 页；不调用 MinerU；段落通过 Rust 的全站共享池翻译"))).await?;
                    }
                    EngineEvent::Translate { request_id, text } => {
                        anyhow::ensure!(pending.len() + active.len() < MAX_PENDING && protocol.waiting.len() <= MAX_PENDING, "PDF 原生回调队列超过安全容量");
                        if session.progress.load(Ordering::Relaxed) < 30 {
                            session.progress.fetch_max(30, Ordering::Relaxed);
                            events::progress(&state.pool, id, "pdf2zh_translation_started", 30, "开始翻译 PDF 原文段落", Some("按当前任务设置快照组批；不足一批的尾段会定时提交，不会等待其他用户凑批")).await?;
                        }
                        pending.push_back(QueuedParagraph { arrived: Instant::now(), request: NativeRequest { request_id, text } });
                    }
                    EngineEvent::Progress { stage, current, total, percent } => {
                        reporter.report(state, id, &session.progress, &stage, current, total, percent).await?;
                    }
                    EngineEvent::Result { .. } => {
                        // Acknowledge the terminal result with EOF immediately.
                        // Waiting for child stdout EOF first would deadlock its
                        // stdin reader / Python interpreter shutdown.
                        drop(output.take());
                        completed_at = Some(Instant::now());
                    },
                    EngineEvent::Error { .. } => unreachable!("errors are returned by protocol validation"),
                }
            }
            Some((ids, result)) = active.next(), if !active.is_empty() => {
                match result {
                    Ok(replies) => {
                        protocol.complete(&ids, &replies)?;
                        for (request_id, text) in replies {
                            write_reply(output.as_mut().context("PDF 回填连接已关闭")?, json!({"type":"translation","request_id":request_id,"text":text})).await?;
                        }
                    }
                    Err(error) => {
                        // Wake the blocked Python callbacks before shutting down.
                        // The first error stops the whole attempt, not just one page.
                        for request_id in ids {
                            if let Some(output) = output.as_mut() {
                                let _ = write_reply(output, json!({"type":"error","request_id":request_id,"message":"段落翻译未通过校验，本次原生排版已中止"})).await;
                            }
                        }
                        return Err(error).context("PDF 原生段落翻译失败，未发布部分结果");
                    }
                }
            }
            _ = timer.tick() => (),
        }
    }
}

struct ProgressReporter {
    last_stage: String,
    last_current: u64,
    emitted: Instant,
}

fn stage_progress(stage: &str, fraction: f64, previous: i32) -> (&'static str, &'static str, i32) {
    let (key, label, from, to) = match stage {
        "Parse PDF and Create Intermediate Representation" => (
            "pdf2zh_layout_intermediate",
            "解析 PDF 原生页面对象",
            10,
            13,
        ),
        "DetectScannedFile" => ("pdf2zh_layout_scan", "复核扫描页与 PDF 文本层", 14, 15),
        "Parse Page Layout" => ("pdf2zh_layout_pages", "分析 PDF 页面布局", 16, 20),
        "Parse Table" => ("pdf2zh_layout_tables", "分析 PDF 表格", 21, 22),
        "Parse Paragraphs" => ("pdf2zh_layout_paragraphs", "提取 PDF 原文段落", 23, 25),
        "Parse Formulas and Styles" => ("pdf2zh_layout_formulas", "保护 PDF 公式与样式", 26, 29),
        "Translate Paragraphs" => ("pdf2zh_translation", "通过共享任务池翻译 PDF 段落", 30, 79),
        "Typesetting" => ("pdf2zh_typesetting_text", "将译文排回原有页面", 80, 83),
        "Add Fonts" => ("pdf2zh_typesetting_fonts", "嵌入中文字体", 84, 85),
        "Generate drawing instructions" => (
            "pdf2zh_typesetting_drawing",
            "生成 PDF 页面绘制指令",
            86,
            87,
        ),
        "Subset font" => (
            "pdf2zh_typesetting_subset",
            "裁剪并校验 PDF 内嵌字体",
            88,
            88,
        ),
        "Save PDF" => ("pdf2zh_typesetting_save", "写入中文 PDF 与双语 PDF", 89, 89),
        _ if previous >= 80 => (
            "pdf2zh_typesetting_engine",
            "处理 PDF 原生排版子步骤",
            previous,
            previous,
        ),
        _ if previous >= 30 => (
            "pdf2zh_translation_engine",
            "处理 PDF 原生翻译子步骤",
            previous,
            previous,
        ),
        _ => (
            "pdf2zh_layout_engine",
            "处理 PDF 版面分析子步骤",
            previous,
            previous,
        ),
    };
    let percent = from + ((to - from) as f64 * fraction.clamp(0.0, 1.0)).floor() as i32;
    (key, label, previous.max(percent).min(89))
}

impl ProgressReporter {
    fn new() -> Self {
        Self {
            last_stage: String::new(),
            last_current: 0,
            emitted: Instant::now(),
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn report(
        &mut self,
        state: &Arc<AppState>,
        id: &str,
        progress: &AtomicI32,
        stage: &str,
        current: u64,
        total: u64,
        percent: f64,
    ) -> Result<()> {
        let previous = progress.load(Ordering::Relaxed);
        let fraction = if total > 0 {
            current as f64 / total as f64
        } else {
            percent / 100.0
        };
        let (key, label, value) = stage_progress(stage, fraction, previous);
        progress.fetch_max(value, Ordering::Relaxed);
        let stage_changed = self.last_stage != stage;
        let finished = current == total && current != self.last_current;
        if !stage_changed && !finished && self.emitted.elapsed() < Duration::from_millis(250) {
            return Ok(());
        }
        if !stage_changed && self.last_current == current {
            return Ok(());
        }
        self.last_stage = stage.to_string();
        self.last_current = current;
        self.emitted = Instant::now();
        sqlx::query("UPDATE documents SET stage=$2,progress=$3,updated_at=NOW(),last_heartbeat_at=NOW() WHERE id=$1")
            .bind(id).bind(key).bind(value).execute(&state.pool).await?;
        events::append(
            &state.pool,
            id,
            EventInput {
                stage: key,
                state: if current == total && total > 0 {
                    "completed"
                } else {
                    "running"
                },
                level: "info",
                progress: value,
                message: label,
                detail: Some(&format!(
                    "{stage}：{current} / {total}；本阶段 {:.1}%",
                    fraction.clamp(0.0, 1.0) * 100.0
                )),
                current: Some(current as i64),
                total: Some(total as i64),
            },
        )
        .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ready() -> EngineEvent {
        EngineEvent::Ready {
            pages: 2,
            engine: "BabelDOC".into(),
            version: "0.6.4".into(),
        }
    }
    fn request(id: u64) -> EngineEvent {
        EngineEvent::Translate {
            request_id: id,
            text: "Original paragraph".into(),
        }
    }
    fn result() -> EngineEvent {
        EngineEvent::Result {
            mono: "mono.pdf".into(),
            dual: "dual.pdf".into(),
            pages: 2,
        }
    }

    #[test]
    fn validates_native_protocol_and_never_accepts_partial_pdf() {
        let mut state = ProtocolState::default();
        assert!(state.accept(&request(1)).is_err());
        state.accept(&ready()).unwrap();
        assert!(state.accept(&ready()).is_err());
        assert!(state.accept(&result()).is_err());
        state.accept(&request(1)).unwrap();
        assert!(state.accept(&request(1)).is_err());
        assert!(state.accept(&result()).is_err());
        assert!(state.complete(&[1], &[(2, "译文".into())]).is_err());
        state.complete(&[1], &[(1, "译文".into())]).unwrap();
        state.accept(&result()).unwrap();
        assert!(state.accept(&request(2)).is_err());
        assert!(state.accept(&result()).is_err());
    }

    #[test]
    fn rejects_untrusted_paths_versions_and_progress_in_engine_messages() {
        assert!(
            serde_json::from_str::<EngineEvent>(
                r#"{"type":"ready","pages":2,"engine":"BabelDOC","version":"0.6.4","api_key":"x"}"#
            )
            .is_err()
        );
        let mut state = ProtocolState::default();
        assert!(
            state
                .accept(&EngineEvent::Ready {
                    pages: 2,
                    engine: "BabelDOC".into(),
                    version: "latest".into()
                })
                .is_err()
        );
        state.accept(&ready()).unwrap();
        assert!(
            state
                .accept(&EngineEvent::Result {
                    mono: "../../secret.pdf".into(),
                    dual: "dual.pdf".into(),
                    pages: 2
                })
                .is_err()
        );
        assert!(
            state
                .accept(&EngineEvent::Progress {
                    stage: "step".into(),
                    current: 4,
                    total: 1,
                    percent: 50.0
                })
                .is_err()
        );
        assert!(
            state
                .accept(&EngineEvent::Progress {
                    stage: "step".into(),
                    current: 1,
                    total: 1,
                    percent: f64::NAN
                })
                .is_err()
        );
    }

    #[tokio::test]
    async fn json_lines_have_a_hard_byte_bound_and_accept_split_reads() {
        let (mut output, input) = tokio::io::duplex(8);
        let writer = tokio::spawn(async move {
            output
                .write_all(b"{\"type\":\"ready\"}\nlast")
                .await
                .unwrap();
        });
        let mut input = BufReader::new(input);
        assert_eq!(
            read_bounded_line(&mut input).await.unwrap().unwrap(),
            b"{\"type\":\"ready\"}\n"
        );
        assert_eq!(
            read_bounded_line(&mut input).await.unwrap().unwrap(),
            b"last"
        );
        assert!(read_bounded_line(&mut input).await.unwrap().is_none());
        writer.await.unwrap();
        let bytes = vec![b'x'; MAX_LINE_BYTES + 1];
        assert!(
            read_bounded_line(&mut BufReader::new(bytes.as_slice()))
                .await
                .is_err()
        );
    }

    #[test]
    fn tail_batches_flush_without_waiting_for_more_pdf_callbacks() {
        let now = Instant::now();
        let mut pending = VecDeque::from([QueuedParagraph {
            arrived: now,
            request: NativeRequest {
                request_id: 1,
                text: "tail".into(),
            },
        }]);
        assert!(take_ready_batch(&mut pending, 100, now).is_none());
        assert_eq!(
            take_ready_batch(&mut pending, 100, now + BATCH_FLUSH)
                .unwrap()
                .len(),
            1
        );
        assert!(pending.is_empty());
        for id in 0..5 {
            pending.push_back(QueuedParagraph {
                arrived: now,
                request: NativeRequest {
                    request_id: id,
                    text: "text".into(),
                },
            });
        }
        assert_eq!(
            take_ready_batch(&mut pending, 3, now)
                .unwrap()
                .iter()
                .map(|r| r.request_id)
                .collect::<Vec<_>>(),
            vec![0, 1, 2]
        );
        assert!(take_ready_batch(&mut pending, 3, now).is_none());
        assert_eq!(
            take_ready_batch(&mut pending, 3, now + BATCH_FLUSH)
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn stage_progress_is_monotonic_and_never_marks_unverified_results_complete() {
        let mut previous = 9;
        for (stage, fraction) in [
            ("Parse Page Layout", 0.5),
            ("Parse Paragraphs", 1.0),
            ("Translate Paragraphs", 0.5),
            ("Translate Paragraphs", 0.25),
            ("Typesetting", 1.0),
            ("Generate drawing instructions", 1.0),
            ("Subset font", 1.0),
            ("Save PDF", 1.0),
            ("future internal step", 1.0),
        ] {
            let (_, _, next) = stage_progress(stage, fraction, previous);
            assert!(next >= previous && next < 90);
            previous = next;
        }
        assert_eq!(previous, 89);
    }

    #[tokio::test]
    async fn renderer_stderr_is_bounded_without_stalling_the_pipe() {
        let input = vec![b'x'; STDERR_TAIL_BYTES * 4];
        let tail = Arc::new(Mutex::new(VecDeque::new()));
        collect_stderr(input.as_slice(), tail.clone()).await;
        assert_eq!(tail.lock().unwrap().len(), STDERR_TAIL_BYTES);
    }
}
