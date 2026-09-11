//! The Python child owns PDF layout only. Rust owns credentials, persistent
//! settings, paragraph batching, retries and the two site-wide provider pools.
use std::{
    collections::{HashSet, VecDeque},
    future::Future,
    path::{Path, PathBuf},
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
    document_root, permanent,
    translate::{
        Translator,
        native::{MAX_PARAGRAPH_CHARS, NativeRequest, NativeSession},
    },
    verify_pdf,
};
use crate::{
    config::is_ascii_path,
    events::{self, EventInput},
    now,
    state::AppState,
};
use sha2::{Digest, Sha256};

/// Runner error codes caused by the input document or the installation.
/// Retrying cannot succeed; the user has to pick MinerU or fix the setup.
const PERMANENT_ENGINE_ERRORS: &[&str] = &[
    "input_missing",
    "pdf_header",
    "pdf_encrypted",
    "pdf_empty",
    "page_geometry",
    "scanned_pdf",
    "text_layer",
    "pdf_open",
    "vertical_text",
    "no_paragraphs",
    "path",
    "engine_missing",
    "engine_version",
    "assets_not_ready",
    "asset_manifest",
    "asset_missing",
    "asset_checksum",
];

const MAX_LINE_BYTES: usize = 1_048_576;
const MAX_PENDING: usize = 512;
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
        #[serde(default)]
        code: Option<String>,
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
            EngineEvent::Error { message, code } => {
                let message = message.chars().take(600).collect::<String>();
                if code
                    .as_deref()
                    .is_some_and(|code| PERMANENT_ENGINE_ERRORS.contains(&code))
                {
                    return Err(permanent(message));
                }
                anyhow::bail!("{message}")
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

pub async fn process(state: &Arc<AppState>, id: &str, source: &Path, translator: Translator) -> Result<()> {
    if !state.config.pdf2zh_available() {
        return Err(permanent(
            "PDF 原生翻译运行环境未安装或不完整（缺少内置 Python 运行时或 BabelDOC 离线资源），请重新安装应用",
        ));
    }
    events::progress(
        &state.pool,
        id,
        "pdf2zh_preflight_queued",
        5,
        "PDF 原生翻译已排队，等待本机排版执行位",
        Some("原生排版使用本机 CPU；段落翻译请求与 MinerU 解析翻译共用同一个服务队列和并发设置"),
    )
    .await?;
    let permit = state
        .native_pdf_slots
        .acquire()
        .await
        .context("PDF 原生排版执行队列已停止")?;
    let progress = Arc::new(AtomicI32::new(5));
    let session = NativeSession::new(state.clone(), id, translator, progress.clone()).await?;
    // A failed attempt can have complete files even if archive publication
    // failed. Never overwrite that attempt; paragraph caches live separately.
    prepare_native_work_root(&state.config).await?;
    let attempt_root = document_root(&state.config.native_work_root, id)?
        .join("native-pdf")
        .join(uuid::Uuid::new_v4().simple().to_string());
    let final_root = attempt_root.join("final");
    tokio::fs::create_dir_all(attempt_root.join("tmp")).await?;
    let assets = native_assets(state, id).await?;
    // The library copy of the source may sit under a non-ASCII path.
    let runner_source = if is_ascii_path(source) {
        source.to_path_buf()
    } else {
        let copy = attempt_root.join("source.pdf");
        tokio::fs::copy(source, &copy).await.context("无法把源文件复制到 PDF 原生翻译工作目录")?;
        copy
    };
    events::progress(&state.pool, id, "pdf2zh_preflight_started", 6, "检查 PDF 文本层并加载本地原生排版内核",
        Some(&format!("BabelDOC 0.6.4；翻译服务：{}；最多 {} 个排版回调；本篇最多 {} 个翻译请求并行，单次最多 {} 段；模型与字体随应用安装，不在任务期间下载", session.translator_label(), session.callback_workers(), session.runtime.per_document_concurrency, session.batch_limit()))).await?;
    progress.store(6, Ordering::Relaxed);
    let output = run_engine(
        state,
        id,
        NativePaths {
            source: &runner_source,
            output: &final_root,
            assets: &assets,
            temp: &attempt_root.join("tmp"),
        },
        session.clone(),
    )
    .await?;
    session.ensure_mostly_translated()?;
    drop(permit);
    events::progress(
        &state.pool,
        id,
        "pdf2zh_verified_started",
        90,
        "原生排版完成，检查中文 PDF 和双语 PDF",
        Some("两份文件均须通过文件头、结束标记、完整页数及页面尺寸检查，才会写入文档库"),
    )
    .await?;
    let mono = final_root.join("mono.pdf");
    let dual = final_root.join("dual.pdf");
    for path in [&mono, &dual] {
        let metadata = tokio::fs::symlink_metadata(path)
            .await
            .context("原生 PDF 输出缺失")?;
        anyhow::ensure!(metadata.file_type().is_file(), "原生 PDF 输出不是普通文件");
        verify_pdf(path).await?;
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

/// BabelDOC's font and model loaders need ASCII paths on every platform, and
/// the runner resolves 8.3 short names back to their long form, so a short
/// path alias cannot be used as a workaround. Non-ASCII libraries and app
/// folders are handled by `prepare_native_work_root` and `native_assets`.
fn ascii_path(path: &Path, what: &str) -> Result<PathBuf> {
    match path.to_str() {
        Some(text) if text.is_ascii() => Ok(PathBuf::from(text)),
        _ => Err(permanent(format!(
            "PDF 原生翻译要求{what}位于纯英文（ASCII）路径，当前为 {}。请在设置中把文档库移到纯英文目录，或把应用放到纯英文目录后重试",
            path.display()
        ))),
    }
}

struct NativePaths<'a> {
    source: &'a Path,
    output: &'a Path,
    assets: &'a Path,
    /// TEMP/TMP of the worker: inside the attempt, so never a non-ASCII
    /// profile folder.
    temp: &'a Path,
}

/// A native work root outside the library (see `Config::native_work_root`)
/// is created readable by this user only, since %ProgramData% is shared.
async fn prepare_native_work_root(config: &crate::config::Config) -> Result<()> {
    let root = &config.native_work_root;
    if root == &config.work_root || root.is_dir() {
        return Ok(());
    }
    if let Some(parent) = root.parent() {
        tokio::fs::create_dir_all(parent).await.context("无法创建 PDF 原生翻译工作目录")?;
    }
    let path = root.clone();
    tokio::task::spawn_blocking(move || create_private_dir(&path))
        .await?
        .with_context(|| format!("无法创建 PDF 原生翻译工作目录 {}", root.display()))
}

#[cfg(windows)]
fn create_private_dir(path: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::{
        Foundation::{ERROR_ALREADY_EXISTS, LocalFree},
        Security::{
            Authorization::{ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1},
            PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES,
        },
        Storage::FileSystem::CreateDirectoryW,
    };
    // Protected DACL: full control for the owner, SYSTEM and administrators.
    let sddl = "D:P(A;OICI;FA;;;OW)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"
        .encode_utf16()
        .chain([0])
        .collect::<Vec<_>>();
    let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    // SAFETY: valid NUL-terminated input; the descriptor is freed below.
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), SDDL_REVISION_1, &mut descriptor, std::ptr::null_mut())
    } == 0
    {
        return Err(std::io::Error::last_os_error());
    }
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor,
        bInheritHandle: 0,
    };
    let wide = path.as_os_str().encode_wide().chain([0]).collect::<Vec<_>>();
    // SAFETY: both pointers stay valid for the duration of the call.
    let created = unsafe { CreateDirectoryW(wide.as_ptr(), &attributes) };
    let error = std::io::Error::last_os_error();
    // SAFETY: allocated by ConvertStringSecurityDescriptorToSecurityDescriptorW.
    unsafe { LocalFree(descriptor) };
    if created == 0 && error.raw_os_error() != Some(ERROR_ALREADY_EXISTS as i32) {
        return Err(error);
    }
    Ok(())
}

#[cfg(not(windows))]
fn create_private_dir(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    std::fs::DirBuilder::new().mode(0o700).create(path)
}

/// BabelDOC's offline assets at an ASCII path. An app installed in a
/// non-ASCII folder gets a mirror under %ProgramData%\DocFlow, built once
/// per asset version from hard links (or copies across drives).
async fn native_assets(state: &AppState, id: &str) -> Result<PathBuf> {
    let installed = state.config.pdf2zh_asset_dir.clone();
    if is_ascii_path(&installed) {
        return Ok(installed);
    }
    let Some(base) = crate::config::ascii_fallback_root() else {
        return ascii_path(&installed, "BabelDOC 离线资源（应用安装目录）");
    };
    let manifest = tokio::fs::read(installed.join("manifest.json"))
        .await
        .context("BabelDOC 离线资源缺少清单文件，请重新安装应用")?;
    let version = hex::encode(&Sha256::digest(&manifest)[..8]);
    let target = base.join("pdf-assets").join(&version);
    if target.join(".ready").is_file() {
        return Ok(target);
    }
    events::progress(
        &state.pool,
        id,
        "pdf2zh_assets_mirroring",
        6,
        "首次使用：正在把 BabelDOC 离线资源准备到纯英文路径",
        Some(&format!(
            "应用安装目录含有非英文字符，BabelDOC 无法直接读取；资源将链接或复制到 {}，只需一次",
            target.display()
        )),
    )
    .await?;
    tokio::task::spawn_blocking(move || mirror_assets(&installed, &target))
        .await?
        .context("无法准备 BabelDOC 离线资源，请把应用放到纯英文目录后重试")
}

fn mirror_assets(source: &Path, target: &Path) -> Result<PathBuf> {
    let parent = target.parent().context("资源目录无效")?;
    std::fs::create_dir_all(parent)?;
    let staging = parent.join(format!(".staging-{}", uuid::Uuid::new_v4().simple()));
    let build = || -> Result<()> {
        for entry in walkdir::WalkDir::new(source).follow_links(false) {
            let entry = entry?;
            let relative = entry.path().strip_prefix(source)?;
            // The ready marker goes in last, after every file is in place.
            if relative.as_os_str() == ".ready" {
                continue;
            }
            let destination = staging.join(relative);
            if entry.file_type().is_dir() {
                std::fs::create_dir_all(&destination)?;
            } else if entry.file_type().is_file() {
                if std::fs::hard_link(entry.path(), &destination).is_err() {
                    std::fs::copy(entry.path(), &destination)?;
                }
                anyhow::ensure!(
                    std::fs::metadata(&destination)?.len() == entry.metadata()?.len(),
                    "资源文件 {} 复制不完整",
                    relative.display()
                );
            }
        }
        std::fs::copy(source.join(".ready"), staging.join(".ready"))?;
        Ok(())
    };
    let result = build().and_then(|()| match std::fs::rename(&staging, target) {
        Ok(()) => Ok(()),
        // Another engine finished the same mirror first.
        Err(_) if target.join(".ready").is_file() => Ok(()),
        Err(error) => Err(error.into()),
    });
    if staging.exists() {
        let _ = std::fs::remove_dir_all(&staging);
    }
    result?;
    // Older asset versions are no longer needed (other users' may be in use
    // or not ours to delete; failures are fine).
    if let Ok(entries) = std::fs::read_dir(parent) {
        for entry in entries.flatten() {
            if entry.path() != target && !entry.file_name().to_string_lossy().starts_with('.') {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
    Ok(target.to_path_buf())
}

// Cancelling or deleting a document aborts the task, which must also abort
// the pipe readers. The child itself has kill_on_drop enabled below.
struct AbortTask(tokio::task::AbortHandle);
impl Drop for AbortTask {
    fn drop(&mut self) {
        self.0.abort();
    }
}

async fn run_engine(
    state: &Arc<AppState>,
    id: &str,
    paths: NativePaths<'_>,
    session: Arc<NativeSession>,
) -> Result<EngineResult> {
    let source = ascii_path(paths.source, "源文件")?;
    let output = ascii_path(paths.output, "处理目录")?;
    let assets = ascii_path(paths.assets, "BabelDOC 离线资源")?;
    let temp = ascii_path(paths.temp, "临时目录")?;
    let mut command = Command::new(&state.config.pdf2zh_python_binary);
    command
        // No user site-packages and no bytecode next to the bundled runtime.
        .arg("-s")
        .arg("-B")
        .arg(&state.config.pdf2zh_runner_script)
        .arg("--input")
        .arg(&source)
        .arg("--output")
        .arg(&output)
        .arg("--workers")
        .arg(session.callback_workers().to_string())
        .arg("--asset-dir")
        .arg(&assets)
        .env_clear()
        .env("PYTHONUTF8", "1")
        .env("PYTHONUNBUFFERED", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // The worker is a console program; never flash a console window.
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    // Do not inherit cloud credentials, proxy variables or Python overrides.
    for key in ["PATH", "SystemRoot", "WINDIR", "LANG", "LC_ALL"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    for key in ["TEMP", "TMP", "TMPDIR"] {
        command.env(key, &temp);
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
                        events::document_changed(id);
                        session.progress.fetch_max(9, Ordering::Relaxed);
                        events::progress(&state.pool, id, "pdf2zh_preflight_completed", 9, "PDF 文本层与本地排版环境检查通过",
                            Some(&format!("原文共 {pages} 页；不调用 MinerU；段落通过全局共享任务池翻译"))).await?;
                    }
                    EngineEvent::Translate { request_id, text } => {
                        anyhow::ensure!(pending.len() + active.len() < MAX_PENDING && protocol.waiting.len() <= MAX_PENDING, "PDF 原生回调队列超过安全容量");
                        if session.progress.load(Ordering::Relaxed) < 30 {
                            session.progress.fetch_max(30, Ordering::Relaxed);
                            events::progress(&state.pool, id, "pdf2zh_translation_started", 30, "开始翻译 PDF 原文段落", Some("按当前任务设置快照组批；不足一批的尾段会定时提交，不会等待其他文档凑批")).await?;
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
        sqlx::query(concat!(
            "UPDATE documents SET stage=$2,progress=$3,updated_at=",
            now!(),
            " WHERE id=$1 AND status='processing'"
        ))
        .bind(id)
        .bind(key)
        .bind(value)
        .execute(&state.pool)
        .await?;
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
