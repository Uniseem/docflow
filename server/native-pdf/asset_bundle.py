"""Verified build-time assets and task-local BabelDOC runtime storage."""

from __future__ import annotations

import hashlib
import importlib
import importlib.metadata
import ipaddress
import json
import os
import socket
import sys
import tempfile
import types
from pathlib import Path
from unittest.mock import patch

from bridge import FailureState, NativePdfError

ENGINE_VERSION = "0.6.4"
READY_CONTENT = f"BabelDOC {ENGINE_VERSION}\n"
RESOURCE_FOLDERS = frozenset({"fonts", "models", "cmap", "tiktoken"})


def check_engine_version() -> None:
    try:
        version = importlib.metadata.version("babeldoc")
    except importlib.metadata.PackageNotFoundError as exc:
        raise NativePdfError(
            "engine_missing", "原生 PDF 引擎未安装，请重新构建服务镜像。"
        ) from exc
    if version != ENGINE_VERSION:
        raise NativePdfError(
            "engine_version", "原生 PDF 引擎版本与适配器不一致，请重新构建服务镜像。"
        )


def configure_storage(
    asset_dir: Path, scratch_dir: Path, *, building: bool = False
) -> None:
    """Must run before importing high_level/assets/translator modules.

    v0.6.4 creates a tiktoken folder during const import. Temporarily routing
    Path.home() for that single, synchronous import avoids touching /app or the
    real user's cache, without changing HOME. All subsequently imported cache
    constants point at this task's scratch area, not the immutable asset bundle.
    """
    scratch_dir.mkdir(parents=True, exist_ok=True)
    runtime_home = scratch_dir / "runtime"
    with patch.object(Path, "home", return_value=runtime_home):
        constants = importlib.import_module("babeldoc.const")
    cache_dir = scratch_dir / "cache"
    cache_dir.mkdir(exist_ok=True)
    constants.CACHE_FOLDER = cache_dir
    constants.TIKTOKEN_CACHE_FOLDER = asset_dir / "tiktoken"

    def get_cache_file_path(filename: str, sub_folder: str | None = None) -> Path:
        if (
            not isinstance(filename, str)
            or not filename
            or filename in {".", ".."}
            or "/" in filename
            or "\\" in filename
            or (sub_folder is not None and sub_folder not in RESOURCE_FOLDERS)
        ):
            raise NativePdfError("asset_path", "原生 PDF 引擎请求了未允许的资源路径。")
        if sub_folder in RESOURCE_FOLDERS:
            directory = asset_dir / sub_folder
            if building:
                directory.mkdir(parents=True, exist_ok=True)
        else:
            directory = cache_dir
        return directory / filename

    constants.get_cache_file_path = get_cache_file_path
    os.environ["TIKTOKEN_CACHE_DIR"] = str(asset_dir / "tiktoken")
    local_tmp = scratch_dir / "tmp"
    local_tmp.mkdir(exist_ok=True)
    tempfile.tempdir = str(local_tmp)
    for variable in ("TMPDIR", "TEMP", "TMP"):
        os.environ[variable] = str(local_tmp)
    if not building:
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
        install_disabled_translation_cache()


def install_disabled_translation_cache() -> None:
    """Prevent v0.6.4's import-time SQLite init and any accidental cache use."""
    module_name = "babeldoc.translator.cache"
    if module_name in sys.modules:
        raise NativePdfError(
            "engine_import_order", "原生 PDF 缓存模块导入顺序不符合适配器约定。"
        )
    disabled = types.ModuleType(module_name)

    class DisabledTranslationCache:
        def __init__(self, *args, **kwargs):
            raise NativePdfError(
                "engine_cache", "原生 PDF 引擎不能绕过统一翻译池建立缓存。"
            )

    disabled.TranslationCache = DisabledTranslationCache
    sys.modules[module_name] = disabled


def expected_manifest() -> dict:
    check_engine_version()
    metadata = importlib.import_module("babeldoc.assets.embedding_assets_metadata")
    files = [
        {
            "path": "models/doclayout_yolo_docstructbench_imgsz1024.onnx",
            "sha3_256": metadata.DOCLAYOUT_YOLO_DOCSTRUCTBENCH_IMGSZ1024ONNX_SHA3_256,
        }
    ]
    for folder, entries in (
        ("fonts", metadata.EMBEDDING_FONT_METADATA),
        ("cmap", metadata.CMAP_METADATA),
    ):
        files.extend(
            {"path": f"{folder}/{name}", "sha3_256": details["sha3_256"]}
            for name, details in entries.items()
        )
    files.extend(
        {"path": f"tiktoken/{name}", "sha3_256": checksum}
        for name, checksum in metadata.TIKTOKEN_CACHES.items()
    )
    return {
        "engine": "BabelDOC",
        "version": ENGINE_VERSION,
        "files": sorted(files, key=lambda item: item["path"]),
    }


def checksum(path: Path) -> str:
    digest = hashlib.sha3_256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1_048_576), b""):
            digest.update(block)
    return digest.hexdigest()


def verify_asset_files(asset_dir: Path, manifest: dict) -> None:
    root = asset_dir.resolve(strict=True)
    for entry in manifest["files"]:
        relative = Path(entry["path"])
        candidate = root / relative
        if relative.is_absolute() or ".." in relative.parts or candidate.is_symlink():
            raise NativePdfError("asset_path", "原生 PDF 离线资源路径无效。")
        try:
            if (
                not candidate.resolve(strict=True).is_relative_to(root)
                or not candidate.is_file()
            ):
                raise OSError("not an asset file")
            actual = checksum(candidate)
        except (OSError, ValueError) as exc:
            raise NativePdfError(
                "asset_missing", "原生 PDF 离线资源缺失，请重新构建服务镜像。"
            ) from exc
        if actual != entry["sha3_256"]:
            raise NativePdfError(
                "asset_checksum", "原生 PDF 离线资源校验失败，请重新构建服务镜像。"
            )


def verify_bundle(asset_dir: Path) -> None:
    expected = expected_manifest()
    try:
        marker = (asset_dir / ".ready").read_text(encoding="ascii")
        # The metadata is image-owned, but cap reads to reject accidental misuse.
        manifest_file = asset_dir / "manifest.json"
        if manifest_file.stat().st_size > 1_048_576:
            raise ValueError("manifest too large")
        manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeError) as exc:
        raise NativePdfError(
            "assets_not_ready", "原生 PDF 离线资源尚未准备完成，请重新构建服务镜像。"
        ) from exc
    if marker != READY_CONTENT or manifest != expected:
        raise NativePdfError(
            "asset_manifest", "原生 PDF 离线资源版本不匹配，请重新构建服务镜像。"
        )
    verify_asset_files(asset_dir, expected)


def install_network_guard(failure: FailureState) -> None:
    """Fail closed on Python network attempts; local event-loop sockets work.

    All supported translation traffic uses stdin/stdout. Asset preflight is
    complete before this guard is installed. This is defense in depth, not a
    replacement for container/network sandboxing of untrusted PDF parsers.
    """

    def local_host(host) -> bool:
        if host is None or host in {"", "localhost"}:
            return True
        try:
            return ipaddress.ip_address(host).is_loopback
        except (ValueError, TypeError):
            return False

    def deny() -> None:
        error = NativePdfError(
            "engine_network",
            "原生 PDF 引擎尝试访问网络；请检查离线资源，未生成最终 PDF。",
        )
        failure.fail(error)
        raise error

    def audit(event: str, args: tuple) -> None:
        if event == "socket.getaddrinfo" and not local_host(args[0]):
            deny()
        if event in {"socket.connect", "socket.sendto"}:
            connection, address = args[0], args[-1]
            if connection.family in {
                socket.AF_INET,
                socket.AF_INET6,
            } and not local_host(address[0]):
                deny()

    sys.addaudithook(audit)


def install_process_guard(failure: FailureState) -> None:
    """The Rust supervisor owns the sole process; no engine grandchildren."""
    import multiprocessing.process

    def deny(*args, **kwargs):
        error = NativePdfError(
            "engine_process", "原生 PDF 引擎尝试启动未受管理的子进程，已中止处理。"
        )
        failure.fail(error)
        raise error

    # multiprocessing's Windows implementation can bypass subprocess.Popen.
    multiprocessing.process.BaseProcess.start = deny

    def audit(event: str, args: tuple) -> None:
        if event in {
            "subprocess.Popen",
            "os.fork",
            "os.forkpty",
            "os.posix_spawn",
            "os.startfile",
            "os.startfile/2",
            "_winapi.CreateProcess",
        }:
            deny()

    sys.addaudithook(audit)


def configure_cpu_runtime() -> None:
    """Keep numerical helpers in-process and avoid hardware-probe subprocesses.

    Translation callback workers are controlled separately by Rust. They are
    not an invitation for every paragraph to launch its own BLAS/process pool.
    Joblib otherwise invokes lscpu/wmic even for a one-worker computation.
    """
    for key in (
        "OPENBLAS_NUM_THREADS",
        "OMP_NUM_THREADS",
        "MKL_NUM_THREADS",
        "NUMEXPR_NUM_THREADS",
        "LOKY_MAX_CPU_COUNT",
    ):
        os.environ[key] = "1"
    from joblib.externals.loky.backend import context

    # Loky honors the user limit except on a one-logical-core machine, where
    # it still probes physical cores. Cache the conservative one-core budget
    # before installing the subprocess guard; no shell command is necessary.
    context.physical_cores_cache = 1
