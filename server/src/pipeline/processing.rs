use std::{
    collections::{HashMap, HashSet},
    fs::File,
    io::Write,
    net::IpAddr,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use anyhow::{Context, Result};
use futures::StreamExt;
use regex::Regex;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;
use url::Url;
use walkdir::WalkDir;
use zip::ZipArchive;

use crate::{
    db::AppState,
    events::{self, EventInput},
};

const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff"];

pub struct Extraction {
    pub original_markdown: String,
    pub localized_markdown: String,
    pub image_count: usize,
}

pub async fn download_public(
    state: &Arc<AppState>,
    id: &str,
    url: &str,
    destination: &Path,
    max_bytes: u64,
) -> Result<()> {
    events::progress(
        &state.pool,
        id,
        "result_download_starting",
        54,
        "开始下载 MinerU 结果压缩包",
        Some("逐次校验 HTTPS/HTTP 重定向和公网地址；最大允许 1 GiB"),
    )
    .await?;
    download_url(url, destination, max_bytes, Some((state, id))).await?;
    let size = tokio::fs::metadata(destination).await?.len();
    events::append(
        &state.pool,
        id,
        EventInput {
            stage: "result_downloaded",
            state: "completed",
            level: "success",
            progress: 59,
            message: "MinerU 结果下载完成",
            detail: Some(&format!("压缩包 {size} 字节；开始 ZIP 路径与解压规模检查")),
            current: Some(size as i64),
            total: Some(size as i64),
        },
    )
    .await?;
    Ok(())
}

async fn download_url(
    url: &str,
    destination: &Path,
    max_bytes: u64,
    progress: Option<(&Arc<AppState>, &str)>,
) -> Result<()> {
    let mut current = Url::parse(url).context("远程地址格式错误")?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(900))
        .no_proxy()
        .build()?;
    for _redirect in 0..6 {
        validate_public_url(&current).await?;
        let response = client.get(current.clone()).send().await?;
        if response.status().is_redirection() {
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .context("重定向缺少 Location")?;
            current = current.join(location)?;
            continue;
        }
        if !response.status().is_success() {
            anyhow::bail!("远程文件下载失败（HTTP {}）", response.status());
        }
        let declared = response.content_length();
        if declared.is_some_and(|v| v > max_bytes) {
            anyhow::bail!("远程文件超过允许大小");
        }
        if let Some(parent) = destination.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let partial = destination.with_extension("downloading");
        let mut output = tokio::fs::File::create(&partial).await?;
        let mut written = 0u64;
        let mut bucket = u64::MAX;
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            written += chunk.len() as u64;
            if written > max_bytes {
                let _ = tokio::fs::remove_file(&partial).await;
                anyhow::bail!("远程文件超过允许大小");
            }
            output.write_all(&chunk).await?;
            if let Some((state, id)) = progress {
                let new_bucket = written / (4 * 1024 * 1024);
                if new_bucket != bucket {
                    bucket = new_bucket;
                    let p = if let Some(total) = declared {
                        54 + (written * 5 / total.max(1)).min(5) as i32
                    } else {
                        55
                    };
                    events::append(
                        &state.pool,
                        id,
                        EventInput {
                            stage: "downloading_result",
                            state: "running",
                            level: "info",
                            progress: p,
                            message: "正在分块接收 MinerU 压缩包",
                            detail: Some(&format!(
                                "已写入 {written} 字节；服务器声明总量 {}",
                                declared
                                    .map(|v| v.to_string())
                                    .unwrap_or_else(|| "未知".into())
                            )),
                            current: Some(written as i64),
                            total: declared.map(|v| v as i64),
                        },
                    )
                    .await?;
                }
            }
        }
        output.flush().await?;
        drop(output);
        tokio::fs::rename(partial, destination).await?;
        return Ok(());
    }
    anyhow::bail!("远程文件重定向次数过多")
}

async fn validate_public_url(url: &Url) -> Result<()> {
    if !matches!(url.scheme(), "http" | "https") {
        anyhow::bail!("仅允许 HTTP/HTTPS 远程资源");
    }
    let host = url.host_str().context("远程地址没有主机名")?;
    let port = url.port_or_known_default().unwrap_or(443);
    let addresses = tokio::net::lookup_host((host, port)).await?;
    let mut found = false;
    for address in addresses {
        found = true;
        if !is_public_ip(address.ip()) {
            anyhow::bail!("远程地址解析到非公网 IP");
        }
    }
    if !found {
        anyhow::bail!("无法解析远程主机");
    }
    Ok(())
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => {
            !(v.is_private()
                || v.is_loopback()
                || v.is_link_local()
                || v.is_unspecified()
                || v.is_multicast()
                || v.octets()[0] == 0
                || v.octets()[0] >= 224)
        }
        IpAddr::V6(v) => {
            !(v.is_loopback()
                || v.is_unspecified()
                || v.is_multicast()
                || v.is_unique_local()
                || v.is_unicast_link_local())
        }
    }
}

pub async fn extract_and_localize(
    state: &Arc<AppState>,
    id: &str,
    zip_path: &Path,
    extract_root: &Path,
    final_root: &Path,
) -> Result<Extraction> {
    let zip = zip_path.to_owned();
    let out = extract_root.to_owned();
    let stats = tokio::task::spawn_blocking(move || extract_zip(&zip, &out)).await??;
    events::append(
        &state.pool,
        id,
        EventInput {
            stage: "archive_extracted",
            state: "completed",
            level: "success",
            progress: 63,
            message: "MinerU ZIP 安全检查与解压完成",
            detail: Some(&format!(
                "共 {} 个条目，解压 {} 字节；所有路径均限制在隔离目录内",
                stats.0, stats.1
            )),
            current: Some(stats.0 as i64),
            total: Some(stats.0 as i64),
        },
    )
    .await?;
    let markdown_path = find_primary_markdown(extract_root)?;
    let original = tokio::fs::read_to_string(&markdown_path)
        .await
        .context("MinerU Markdown 不是 UTF-8")?;
    events::append(
        &state.pool,
        id,
        EventInput {
            stage: "markdown_selected",
            state: "completed",
            level: "success",
            progress: 64,
            message: "已选择 MinerU 主 Markdown",
            detail: Some(&format!(
                "文件 {}；{} 个字符；原始 Markdown 立即写入数据库永久保存",
                markdown_path
                    .strip_prefix(extract_root)
                    .unwrap_or(&markdown_path)
                    .display(),
                original.chars().count()
            )),
            current: Some(original.chars().count() as i64),
            total: Some(original.chars().count() as i64),
        },
    )
    .await?;

    let image_dir = final_root.join("images");
    tokio::fs::create_dir_all(&image_dir).await?;
    let md_re = Regex::new(r#"!\[[^\]]*\]\(\s*<?([^\s)>]+)>?(?:\s+[\"'][^)]*[\"'])?\s*\)"#)?;
    let html_re = Regex::new(r#"(?i)<img\b[^>]*?\bsrc\s*=\s*[\"']([^\"']+)[\"'][^>]*>"#)?;
    let mut refs = Vec::new();
    for caps in md_re
        .captures_iter(&original)
        .chain(html_re.captures_iter(&original))
    {
        if let Some(value) = caps.get(1) {
            refs.push(value.as_str().to_string());
        }
    }
    refs.sort();
    refs.dedup();
    events::append(
        &state.pool,
        id,
        EventInput {
            stage: "images_discovered",
            state: "completed",
            level: "info",
            progress: 65,
            message: "图片引用扫描完成",
            detail: Some(&format!(
                "Markdown/HTML 中发现 {} 个不重复图片引用；还会扫描压缩包内未引用图片",
                refs.len()
            )),
            current: Some(refs.len() as i64),
            total: Some(refs.len() as i64),
        },
    )
    .await?;
    let mut mapping = HashMap::new();
    let mut names = HashSet::new();
    for (index, reference) in refs.iter().enumerate() {
        let source = if reference.starts_with("http://") || reference.starts_with("https://") {
            let target = extract_root
                .join("remote-images")
                .join(format!("{index}.image"));
            download_url(reference, &target, 50 * 1024 * 1024, None).await?;
            target
        } else {
            resolve_local_image(
                extract_root,
                markdown_path.parent().unwrap_or(extract_root),
                reference,
            )?
        };
        let destination =
            convert_image(source.clone(), image_dir.clone(), state.config.webp_quality).await?;
        let name = destination
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_string();
        names.insert(name.clone());
        mapping.insert(reference.clone(), name.clone());
        events::append(
            &state.pool,
            id,
            EventInput {
                stage: "image_converted",
                state: "completed",
                level: "success",
                progress: 65 + (((index + 1) * 5 / refs.len().max(1)) as i32),
                message: &format!("图片 {}/{} 已转为 WebP", index + 1, refs.len()),
                detail: Some(&format!(
                    "{} → {}；最终文章只使用本站稳定资源路径",
                    reference.chars().take(160).collect::<String>(),
                    name
                )),
                current: Some((index + 1) as i64),
                total: Some(refs.len() as i64),
            },
        )
        .await?;
    }
    for item in WalkDir::new(extract_root)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
    {
        let path = item.path();
        if is_image(path)
            && let Ok(destination) = convert_image(
                path.to_owned(),
                image_dir.clone(),
                state.config.webp_quality,
            )
            .await
        {
            names.insert(
                destination
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .to_string(),
            );
        }
    }
    let mut localized = original.clone();
    for (reference, name) in &mapping {
        localized = localized.replace(reference, &format!("/api/v1/jobs/{id}/assets/{name}"));
    }
    if localized.contains("mineru.net/") {
        tracing::warn!(document_id=%id,"localized markdown still contains non-image MinerU link");
    }
    events::append(
        &state.pool,
        id,
        EventInput {
            stage: "images_localized",
            state: "completed",
            level: "success",
            progress: 70,
            message: "所有可识别图片已本地转换并改写引用",
            detail: Some(&format!(
                "最终 {} 个唯一 WebP；文章图片全部指向本站 API，不使用 MinerU 图片链接",
                names.len()
            )),
            current: Some(names.len() as i64),
            total: Some(names.len() as i64),
        },
    )
    .await?;
    Ok(Extraction {
        original_markdown: original,
        localized_markdown: localized,
        image_count: names.len(),
    })
}

fn extract_zip(zip_path: &Path, root: &Path) -> Result<(usize, u64)> {
    std::fs::create_dir_all(root)?;
    let mut zip = ZipArchive::new(File::open(zip_path)?)?;
    if zip.len() > 20_000 {
        anyhow::bail!("ZIP 条目超过 20000");
    }
    let mut total = 0u64;
    for index in 0..zip.len() {
        let mut item = zip.by_index(index)?;
        let enclosed = item.enclosed_name().context("ZIP 包含越界路径")?.to_owned();
        total = total.saturating_add(item.size());
        if total > 4 * 1024 * 1024 * 1024 {
            anyhow::bail!("ZIP 解压后超过 4 GiB");
        }
        let output = root.join(enclosed);
        if item.is_dir() {
            std::fs::create_dir_all(&output)?;
            continue;
        }
        if let Some(parent) = output.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut file = File::create(&output)?;
        std::io::copy(&mut item, &mut file)?;
        file.flush()?;
    }
    Ok((zip.len(), total))
}

fn find_primary_markdown(root: &Path) -> Result<PathBuf> {
    WalkDir::new(root)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| {
            e.file_type().is_file()
                && e.path()
                    .extension()
                    .and_then(|v| v.to_str())
                    .is_some_and(|v| v.eq_ignore_ascii_case("md"))
        })
        .max_by_key(|e| e.metadata().map(|v| v.len()).unwrap_or(0))
        .map(|e| e.into_path())
        .context("MinerU ZIP 中没有 Markdown")
}

fn resolve_local_image(root: &Path, markdown_parent: &Path, reference: &str) -> Result<PathBuf> {
    let decoded = url::form_urlencoded::parse(reference.as_bytes())
        .map(|(a, b)| {
            if b.is_empty() {
                a.into_owned()
            } else {
                format!("{a}={b}")
            }
        })
        .collect::<Vec<_>>()
        .join("&");
    let clean = decoded
        .split(['#', '?'])
        .next()
        .unwrap_or(&decoded)
        .trim_start_matches('/');
    let candidates = [markdown_parent.join(clean), root.join(clean)];
    for candidate in candidates {
        if candidate.is_file() {
            let canonical = candidate.canonicalize()?;
            let base = root.canonicalize()?;
            if canonical.starts_with(base) {
                return Ok(canonical);
            }
        }
    }
    anyhow::bail!("Markdown 引用的图片不存在：{reference}")
}

fn is_image(path: &Path) -> bool {
    path.extension()
        .and_then(|v| v.to_str())
        .is_some_and(|v| IMAGE_EXTENSIONS.contains(&v.to_lowercase().as_str()))
}

async fn convert_image(source: PathBuf, image_dir: PathBuf, quality: u8) -> Result<PathBuf> {
    tokio::task::spawn_blocking(move || {
        let bytes = std::fs::read(&source)?;
        let hash = hex::encode(Sha256::digest(&bytes));
        let destination = image_dir.join(format!("{}.webp", &hash[..20]));
        if destination.exists() {
            return Ok(destination);
        }
        let image = image::load_from_memory(&bytes)
            .with_context(|| format!("无法解码图片 {}", source.display()))?;
        let encoded = webp::Encoder::from_image(&image)
            .map_err(|e| anyhow::anyhow!("WebP 编码器初始化失败：{e}"))?
            .encode(quality as f32);
        std::fs::write(&destination, &*encoded)?;
        Ok(destination)
    })
    .await?
}
