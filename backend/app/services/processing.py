from __future__ import annotations

import hashlib
import ipaddress
import os
import re
import shutil
import socket
import tempfile
import urllib.parse
import zipfile
from collections.abc import Callable
from pathlib import Path

import httpx
from PIL import Image, ImageOps, UnidentifiedImageError


class ProcessingError(RuntimeError):
    pass


IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".jp2", ".webp", ".gif", ".bmp", ".tif", ".tiff"}
MARKDOWN_IMAGE_RE = re.compile(r"!\[(?P<alt>[^\]]*)\]\((?P<body>[^\n)]*)\)")
HTML_IMAGE_RE = re.compile(r"<img(?P<before>[^>]*?)\bsrc=(?P<quote>['\"])(?P<src>.*?)(?P=quote)(?P<after>[^>]*)>", re.I)
PipelineCallback = Callable[[str, int, int | None, str, str | None], None]
DownloadCallback = Callable[[int, int | None], None]


def _is_public_host(hostname: str) -> bool:
    try:
        addresses = {item[4][0] for item in socket.getaddrinfo(hostname, None, type=socket.SOCK_STREAM)}
    except socket.gaierror:
        return False
    if not addresses:
        return False
    for address in addresses:
        ip = ipaddress.ip_address(address)
        if not ip.is_global:
            return False
    return True


def _validate_remote_url(url: str) -> None:
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or not _is_public_host(parsed.hostname):
        raise ProcessingError("检测到不安全的远程资源地址")


def download_public_file(
    url: str,
    destination: Path,
    *,
    max_bytes: int,
    on_progress: DownloadCallback | None = None,
) -> None:
    current = url
    destination.parent.mkdir(parents=True, exist_ok=True)
    with httpx.Client(timeout=httpx.Timeout(600.0, connect=30.0), follow_redirects=False, trust_env=False) as client:
        for _ in range(5):
            _validate_remote_url(current)
            with client.stream("GET", current) as response:
                if response.status_code in {301, 302, 303, 307, 308}:
                    location = response.headers.get("location")
                    if not location:
                        raise ProcessingError("远程资源重定向缺少地址")
                    current = urllib.parse.urljoin(current, location)
                    continue
                if response.status_code >= 400:
                    raise ProcessingError(f"下载 MinerU 结果失败（HTTP {response.status_code}）")
                declared = response.headers.get("content-length")
                declared_bytes = int(declared) if declared else None
                if declared_bytes and declared_bytes > max_bytes:
                    raise ProcessingError("远程资源超过允许大小")
                written = 0
                if on_progress:
                    on_progress(0, declared_bytes)
                with destination.open("wb") as output:
                    for chunk in response.iter_bytes(1024 * 1024):
                        written += len(chunk)
                        if written > max_bytes:
                            raise ProcessingError("远程资源超过允许大小")
                        output.write(chunk)
                        if on_progress:
                            on_progress(written, declared_bytes)
                return
    raise ProcessingError("远程资源重定向次数过多")


def safe_extract_zip(
    zip_path: Path,
    destination: Path,
    *,
    on_event: PipelineCallback | None = None,
) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    root = destination.resolve()
    with zipfile.ZipFile(zip_path) as archive:
        members = archive.infolist()
        if len(members) > 20_000:
            raise ProcessingError("MinerU 结果文件数量异常")
        total_size = sum(member.file_size for member in members)
        if total_size > 2 * 1024 * 1024 * 1024:
            raise ProcessingError("MinerU 解压结果过大")
        if on_event:
            on_event(
                "archive_inspected",
                0,
                len(members),
                f"压缩包安全检查通过：{len(members)} 个条目",
                f"解压后总大小 {total_size:,} 字节；已检查文件数量、总体积和路径穿越风险",
            )
        report_every = max(1, len(members) // 50)
        for index, member in enumerate(members, start=1):
            target = (destination / member.filename).resolve()
            if os.path.commonpath([root, target]) != str(root):
                raise ProcessingError("MinerU 压缩包包含不安全路径")
            if member.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(member) as source, target.open("wb") as output:
                    shutil.copyfileobj(source, output, length=1024 * 1024)
            if on_event and (index == len(members) or index % report_every == 0):
                on_event(
                    "archive_extracting",
                    index,
                    len(members),
                    f"正在安全解压 MinerU 结果：{index} / {len(members)}",
                    f"最近处理：{member.filename[:500]}",
                )


def find_markdown(root: Path) -> Path:
    candidates = list(root.rglob("*.md"))
    if not candidates:
        raise ProcessingError("MinerU 结果中没有 Markdown 文件")
    full = [item for item in candidates if item.name.lower() == "full.md"]
    return max(full or candidates, key=lambda item: item.stat().st_size)


def _slug(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_-]+", "-", value).strip("-").lower()
    return cleaned[:48] or "image"


def convert_to_webp(source: Path, destination: Path, *, quality: int) -> None:
    try:
        with Image.open(source) as opened:
            image = ImageOps.exif_transpose(opened)
            if getattr(image, "is_animated", False):
                image.seek(0)
            has_alpha = image.mode in {"RGBA", "LA"} or (image.mode == "P" and "transparency" in image.info)
            image = image.convert("RGBA" if has_alpha else "RGB")
            destination.parent.mkdir(parents=True, exist_ok=True)
            image.save(destination, "WEBP", quality=quality, method=6, exact=has_alpha)
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise ProcessingError(f"图片转换为 WebP 失败：{source.name}") from exc


def _destination_parts(body: str) -> tuple[str, str]:
    stripped = body.strip()
    if stripped.startswith("<") and ">" in stripped:
        end = stripped.index(">")
        return stripped[1:end], stripped[end + 1 :]
    match = re.match(r"(\S+)(.*)", stripped, re.DOTALL)
    return (match.group(1), match.group(2)) if match else (stripped, "")


def _source_key(markdown_dir: Path, root: Path, target: str) -> str | None:
    decoded = urllib.parse.unquote(target).replace("\\", "/")
    try:
        candidate = (markdown_dir / decoded).resolve()
        if os.path.commonpath([root.resolve(), candidate]) != str(root.resolve()):
            return None
        return candidate.relative_to(root.resolve()).as_posix()
    except (ValueError, OSError):
        return None


def localize_images(
    markdown: str,
    *,
    extracted_root: Path,
    markdown_path: Path,
    permanent_images: Path,
    public_prefix: str,
    quality: int,
    on_event: PipelineCallback | None = None,
) -> tuple[str, int]:
    permanent_images.mkdir(parents=True, exist_ok=True)
    image_map: dict[str, str] = {}
    image_sources = [
        source
        for source in extracted_root.rglob("*")
        if source.is_file() and source.suffix.lower() in IMAGE_EXTENSIONS
    ]
    if on_event:
        on_event(
            "images_discovered",
            0,
            len(image_sources),
            f"已扫描解压目录，发现 {len(image_sources)} 个本地图片文件",
            f"所有图片将转换为 WebP（质量 {quality}），原格式只存在于临时目录",
        )
    for index, source in enumerate(image_sources, start=1):
        relative = source.resolve().relative_to(extracted_root.resolve()).as_posix()
        digest = hashlib.sha256(relative.encode("utf-8")).hexdigest()[:12]
        filename = f"{_slug(source.stem)}-{digest}.webp"
        output = permanent_images / filename
        convert_to_webp(source, output, quality=quality)
        image_map[relative] = f"{public_prefix.rstrip('/')}/{filename}"
        if on_event:
            on_event(
                "image_converted",
                index,
                len(image_sources),
                f"图片已转为 WebP：{index} / {len(image_sources)}",
                f"{relative[:500]} → {filename}",
            )

    remote_counter = 0

    def resolve_target(target: str) -> str:
        nonlocal remote_counter
        if target.startswith(("http://", "https://")):
            remote_counter += 1
            suffix = Path(urllib.parse.urlsplit(target).path).suffix.lower() or ".img"
            remote_source = extracted_root / f"remote-{remote_counter}{suffix}"
            download_public_file(target, remote_source, max_bytes=50 * 1024 * 1024)
            digest = hashlib.sha256(target.encode("utf-8")).hexdigest()[:12]
            output_name = f"remote-{digest}.webp"
            convert_to_webp(remote_source, permanent_images / output_name, quality=quality)
            if on_event:
                on_event(
                    "remote_image_localized",
                    remote_counter,
                    None,
                    f"外部图片已下载并转为 WebP：第 {remote_counter} 张",
                    f"已保存为 {output_name}，发布内容不再依赖原始外链",
                )
            return f"{public_prefix.rstrip('/')}/{output_name}"
        key = _source_key(markdown_path.parent, extracted_root, target)
        if key and key in image_map:
            return image_map[key]
        basename_matches = [url for path, url in image_map.items() if Path(path).name == Path(target).name]
        if len(basename_matches) == 1:
            return basename_matches[0]
        raise ProcessingError(f"无法在 MinerU 结果中定位图片：{target}")

    def replace_markdown(match: re.Match[str]) -> str:
        target, title = _destination_parts(match.group("body"))
        return f"![{match.group('alt')}]({resolve_target(target)}{title})"

    rewritten = MARKDOWN_IMAGE_RE.sub(replace_markdown, markdown)

    def replace_html(match: re.Match[str]) -> str:
        local = resolve_target(match.group("src"))
        quote = match.group("quote")
        return f"<img{match.group('before')}src={quote}{local}{quote}{match.group('after')}>"

    rewritten = HTML_IMAGE_RE.sub(replace_html, rewritten)
    if re.search(r"!\[[^\]]*\]\(https?://|<img\b[^>]*\bsrc=['\"]https?://", rewritten, re.I):
        raise ProcessingError("仍有图片未完成本地化")
    if on_event:
        total_images = len({url for url in image_map.values()}) + remote_counter
        on_event(
            "images_verified",
            total_images,
            total_images,
            f"图片链接复核完成：共 {total_images} 张，全部指向本地 WebP",
            "未发现仍依赖 MinerU 或其他远程站点的图片地址",
        )
    return rewritten, len({url for url in image_map.values()}) + remote_counter


def unpack_and_localize(
    zip_path: Path,
    *,
    work_dir: Path,
    permanent_images: Path,
    public_prefix: str,
    quality: int,
    on_event: PipelineCallback | None = None,
) -> tuple[str, int]:
    extracted = work_dir / "extracted"
    safe_extract_zip(zip_path, extracted, on_event=on_event)
    markdown_path = find_markdown(extracted)
    if on_event:
        on_event(
            "markdown_selected",
            1,
            1,
            f"已选定 MinerU 主 Markdown：{markdown_path.name}",
            f"相对路径 {markdown_path.relative_to(extracted).as_posix()}；大小 {markdown_path.stat().st_size:,} 字节",
        )
    try:
        markdown = markdown_path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        markdown = markdown_path.read_text(encoding="utf-8-sig")
    return localize_images(
        markdown,
        extracted_root=extracted,
        markdown_path=markdown_path,
        permanent_images=permanent_images,
        public_prefix=public_prefix,
        quality=quality,
        on_event=on_event,
    )


def temporary_workdir(root: Path, document_id: str) -> tempfile.TemporaryDirectory[str]:
    root.mkdir(parents=True, exist_ok=True)
    return tempfile.TemporaryDirectory(prefix=f"{document_id}-", dir=root)
