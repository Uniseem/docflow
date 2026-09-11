use std::{
    env,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result};

pub const GOOGLE_TRANSLATE_URL: &str = "https://translate.googleapis.com/translate_a/single";

/// Command line accepted from the host application.
#[derive(Debug, Default)]
pub struct Args {
    pub data_dir: Option<PathBuf>,
    pub resources_dir: Option<PathBuf>,
    pub version: bool,
}

impl Args {
    pub fn parse() -> Result<Self> {
        let mut args = Self::default();
        let mut iter = env::args_os().skip(1);
        while let Some(arg) = iter.next() {
            match arg.to_str() {
                Some("--data-dir") => {
                    args.data_dir = Some(iter.next().context("--data-dir 缺少路径")?.into());
                }
                Some("--resources") => {
                    args.resources_dir =
                        Some(iter.next().context("--resources 缺少路径")?.into());
                }
                Some("--version") => args.version = true,
                _ => anyhow::bail!("未知参数：{}", arg.to_string_lossy()),
            }
        }
        Ok(args)
    }
}

#[derive(Debug)]
pub struct Config {
    pub data_root: PathBuf,
    pub work_root: PathBuf,
    /// Where BabelDOC attempts run. BabelDOC needs real ASCII paths, so a
    /// library under a non-ASCII path (a Chinese Windows user name, say)
    /// runs them in a private folder under %ProgramData%\DocFlow instead.
    pub native_work_root: PathBuf,
    pub archive_root: PathBuf,
    pub reader_root: PathBuf,
    pub native_pdf_root: PathBuf,
    pub log_root: PathBuf,
    pub database_path: PathBuf,
    pub resources_root: PathBuf,
    pub max_upload_bytes: u64,
    pub translation_queue_capacity: usize,
    /// Google Translate's free endpoint (DOCFLOW_GOOGLE_URL overrides it for tests).
    pub google_translate_url: String,
    pub mineru_poll_seconds: u64,
    pub mineru_max_wait_seconds: u64,
    pub webp_quality: u8,
    pub pdf2zh_python_binary: PathBuf,
    pub pdf2zh_runner_script: PathBuf,
    pub pdf2zh_asset_dir: PathBuf,
    pub pdf2zh_timeout_seconds: u64,
    pub pdf2zh_concurrency: usize,
    /// Development and test aid: deterministic local translations and an
    /// optional local MinerU result archive. Never enabled by the apps.
    pub fake_providers: bool,
    pub fake_mineru_zip: Option<PathBuf>,
}

impl Config {
    pub fn new(args: &Args) -> Result<Self> {
        let data_root = match &args.data_dir {
            Some(path) => absolute(path)?,
            None => default_data_dir()?,
        };
        let resources_root = match args
            .resources_dir
            .clone()
            .or_else(|| env::var_os("DOCFLOW_RESOURCES").map(PathBuf::from))
        {
            Some(path) => absolute(&path)?,
            None => default_resources_dir()?,
        };
        let python = env::var_os("DOCFLOW_PYTHON")
            .map(PathBuf::from)
            .unwrap_or_else(|| bundled_python(&resources_root));
        let asset_dir = env::var_os("DOCFLOW_PDF_ASSETS")
            .map(PathBuf::from)
            .unwrap_or_else(|| resources_root.join("pdf-assets"));
        let native_pdf_root = data_root.join("native-pdf");
        Ok(Self {
            work_root: data_root.join("work"),
            native_work_root: native_work_root(&data_root),
            archive_root: data_root.join("archives"),
            reader_root: data_root.join("reader-assets"),
            log_root: data_root.join("logs"),
            database_path: data_root.join("docflow.db"),
            pdf2zh_runner_script: native_pdf_root.join("runner.py"),
            native_pdf_root,
            data_root,
            resources_root,
            max_upload_bytes: 200 * 1024 * 1024,
            translation_queue_capacity: 4_096,
            google_translate_url: env::var("DOCFLOW_GOOGLE_URL")
                .unwrap_or_else(|_| GOOGLE_TRANSLATE_URL.to_string()),
            mineru_poll_seconds: 5,
            mineru_max_wait_seconds: 7_200,
            webp_quality: 86,
            pdf2zh_python_binary: python,
            pdf2zh_asset_dir: asset_dir,
            pdf2zh_timeout_seconds: 7_200,
            pdf2zh_concurrency: 1,
            fake_providers: env::var("DOCFLOW_FAKE_PROVIDERS").is_ok_and(|value| value == "1"),
            fake_mineru_zip: env::var_os("DOCFLOW_FAKE_MINERU_ZIP").map(PathBuf::from),
        })
    }

    /// Configuration rooted in a fresh directory, with no Python runtime.
    #[cfg(test)]
    pub fn for_tests() -> Self {
        Self::rooted(
            std::env::temp_dir().join(format!("docflow-test-{}", uuid::Uuid::new_v4().simple())),
        )
    }

    #[cfg(test)]
    pub fn rooted(data_root: PathBuf) -> Self {
        let resources = data_root.join("resources");
        let native_pdf_root = data_root.join("native-pdf");
        Self {
            work_root: data_root.join("work"),
            native_work_root: data_root.join("work"),
            archive_root: data_root.join("archives"),
            reader_root: data_root.join("reader-assets"),
            log_root: data_root.join("logs"),
            database_path: data_root.join("docflow.db"),
            pdf2zh_runner_script: native_pdf_root.join("runner.py"),
            native_pdf_root,
            pdf2zh_python_binary: bundled_python(&resources),
            pdf2zh_asset_dir: resources.join("pdf-assets"),
            resources_root: resources,
            data_root,
            max_upload_bytes: 200 * 1024 * 1024,
            translation_queue_capacity: 4_096,
            google_translate_url: GOOGLE_TRANSLATE_URL.to_string(),
            mineru_poll_seconds: 1,
            mineru_max_wait_seconds: 60,
            webp_quality: 86,
            pdf2zh_timeout_seconds: 600,
            pdf2zh_concurrency: 1,
            fake_providers: true,
            fake_mineru_zip: None,
        }
    }

    pub fn max_upload_mb(&self) -> u64 {
        self.max_upload_bytes / 1024 / 1024
    }

    pub fn pdf2zh_available(&self) -> bool {
        self.pdf2zh_python_binary.is_file()
            && self.pdf2zh_runner_script.is_file()
            && self.pdf2zh_asset_dir.join(".ready").is_file()
    }

    /// Fonts shipped with the native PDF assets double as the CJK fonts of the
    /// typeset journal PDF, so both routes look the same on every platform.
    pub fn bundled_font_dir(&self) -> Option<PathBuf> {
        let fonts = self.pdf2zh_asset_dir.join("fonts");
        fonts.is_dir().then_some(fonts)
    }
}

pub fn is_ascii_path(path: &Path) -> bool {
    path.to_str().is_some_and(str::is_ascii)
}

/// An ASCII folder for BabelDOC when the library or the app is not under
/// one: %ProgramData%\DocFlow on Windows. Elsewhere user folders are ASCII.
pub fn ascii_fallback_root() -> Option<PathBuf> {
    if !cfg!(windows) {
        return None;
    }
    let base = PathBuf::from(env::var_os("ProgramData")?).join("DocFlow");
    is_ascii_path(&base).then_some(base)
}

fn native_work_root(data_root: &Path) -> PathBuf {
    let work = data_root.join("work");
    if is_ascii_path(&work) {
        return work;
    }
    // One folder per library, so two users (or two libraries) never share.
    let key = {
        use sha2::{Digest, Sha256};
        let digest = Sha256::digest(data_root.to_string_lossy().as_bytes());
        hex::encode(&digest[..8])
    };
    match ascii_fallback_root() {
        Some(base) => base.join("work").join(key),
        None => work,
    }
}

fn absolute(path: &Path) -> Result<PathBuf> {
    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        Ok(env::current_dir()?.join(path))
    }
}

fn default_data_dir() -> Result<PathBuf> {
    #[cfg(windows)]
    let base = env::var_os("LOCALAPPDATA").map(PathBuf::from);
    #[cfg(target_os = "macos")]
    let base = env::var_os("HOME")
        .map(|home| PathBuf::from(home).join("Library").join("Application Support"));
    #[cfg(not(any(windows, target_os = "macos")))]
    let base = env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share")));
    Ok(base.context("无法确定默认数据目录，请传入 --data-dir")?.join("DocFlow"))
}

fn default_resources_dir() -> Result<PathBuf> {
    let exe = env::current_exe().context("无法定位引擎程序")?;
    let dir = exe.parent().context("引擎程序路径无效")?;
    let beside = dir.join("resources");
    if beside.is_dir() {
        return Ok(beside);
    }
    // macOS: DocFlow.app/Contents/MacOS/docflow-engine → Contents/Resources/engine
    let bundle = dir.join("..").join("Resources").join("engine");
    if bundle.is_dir() {
        return Ok(bundle);
    }
    Ok(beside)
}

fn bundled_python(resources: &Path) -> PathBuf {
    if cfg!(windows) {
        resources.join("python").join("python.exe")
    } else {
        resources.join("python").join("bin").join("python3")
    }
}
