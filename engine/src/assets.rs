//! Files the engine ships inside its own binary and installs into the data
//! directory: the reading-view assets (KaTeX, stylesheet, script) and the
//! BabelDOC adapter scripts. Embedding them guarantees they always match the
//! engine version; only the Python runtime and the BabelDOC models/fonts are
//! external resources.

use std::path::Path;

use anyhow::{Context, Result};

use crate::config::Config;

macro_rules! embed {
    ($($path:literal),* $(,)?) => {
        &[$(($path, include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/", $path)) as &[u8])),*]
    };
}

const READER_FILES: &[(&str, &[u8])] = embed!(
    "reader/reader.css",
    "reader/reader.js",
    "reader/katex/katex.min.css",
    "reader/katex/katex.min.js",
    "reader/katex/LICENSE",
    "reader/katex/fonts/KaTeX_AMS-Regular.woff2",
    "reader/katex/fonts/KaTeX_Caligraphic-Bold.woff2",
    "reader/katex/fonts/KaTeX_Caligraphic-Regular.woff2",
    "reader/katex/fonts/KaTeX_Fraktur-Bold.woff2",
    "reader/katex/fonts/KaTeX_Fraktur-Regular.woff2",
    "reader/katex/fonts/KaTeX_Main-Bold.woff2",
    "reader/katex/fonts/KaTeX_Main-BoldItalic.woff2",
    "reader/katex/fonts/KaTeX_Main-Italic.woff2",
    "reader/katex/fonts/KaTeX_Main-Regular.woff2",
    "reader/katex/fonts/KaTeX_Math-BoldItalic.woff2",
    "reader/katex/fonts/KaTeX_Math-Italic.woff2",
    "reader/katex/fonts/KaTeX_SansSerif-Bold.woff2",
    "reader/katex/fonts/KaTeX_SansSerif-Italic.woff2",
    "reader/katex/fonts/KaTeX_SansSerif-Regular.woff2",
    "reader/katex/fonts/KaTeX_Script-Regular.woff2",
    "reader/katex/fonts/KaTeX_Size1-Regular.woff2",
    "reader/katex/fonts/KaTeX_Size2-Regular.woff2",
    "reader/katex/fonts/KaTeX_Size3-Regular.woff2",
    "reader/katex/fonts/KaTeX_Size4-Regular.woff2",
    "reader/katex/fonts/KaTeX_Typewriter-Regular.woff2",
);

const NATIVE_PDF_FILES: &[(&str, &[u8])] = embed!(
    "native-pdf/runner.py",
    "native-pdf/bridge.py",
    "native-pdf/asset_bundle.py",
    "native-pdf/BABELDOC-LICENSE",
    "native-pdf/NOTICE.md",
);

pub fn install(config: &Config) -> Result<()> {
    install_set(READER_FILES, "reader/", &config.reader_root)?;
    install_set(NATIVE_PDF_FILES, "native-pdf/", &config.native_pdf_root)?;
    Ok(())
}

/// Rewrites files only when their content differs, so a running viewer or a
/// concurrent reader never sees a truncated file.
fn install_set(files: &[(&str, &[u8])], prefix: &str, target: &Path) -> Result<()> {
    for (path, bytes) in files {
        let relative = path.strip_prefix(prefix).expect("embedded path prefix");
        let destination = target.join(relative);
        if std::fs::read(&destination).is_ok_and(|current| current == *bytes) {
            continue;
        }
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let partial = destination.with_extension("partial");
        std::fs::write(&partial, bytes)
            .with_context(|| format!("无法写入 {}", partial.display()))?;
        if std::fs::rename(&partial, &destination).is_err() {
            let _ = std::fs::remove_file(&destination);
            std::fs::rename(&partial, &destination)
                .with_context(|| format!("无法安装 {}", destination.display()))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installs_reader_and_adapter_files_idempotently() {
        let config = Config::for_tests();
        install(&config).unwrap();
        assert!(config.reader_root.join("katex/katex.min.js").is_file());
        assert!(config.reader_root.join("katex/fonts/KaTeX_Main-Regular.woff2").is_file());
        assert!(config.native_pdf_root.join("runner.py").is_file());
        std::fs::write(config.reader_root.join("reader.css"), b"stale").unwrap();
        install(&config).unwrap();
        assert_ne!(
            std::fs::read(config.reader_root.join("reader.css")).unwrap(),
            b"stale"
        );
        let _ = std::fs::remove_dir_all(&config.data_root);
    }
}
