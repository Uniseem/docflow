#!/usr/bin/env python3
"""PDF-native layout worker. stdout is exclusively DocFlow's JSONL protocol."""

from __future__ import annotations

import argparse
import contextlib
import functools
import logging
import math
import os
import shutil
import sys
import tempfile
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO

from asset_bundle import (
    ENGINE_VERSION,
    check_engine_version,
    configure_cpu_runtime,
    configure_storage,
    install_network_guard,
    install_process_guard,
    verify_bundle,
)
from bridge import (
    FailureState,
    JsonlWriter,
    NativePdfError,
    PoolTranslator,
    TranslationBridge,
)


@dataclass(frozen=True)
class PdfInfo:
    pages: int
    dimensions: tuple[tuple[float, float], ...]


def absolute_ascii_path(value: str) -> Path:
    path = Path(value)
    if not value.isascii() or not path.is_absolute():
        raise NativePdfError(
            "path", "原生 PDF 输入、输出和资源路径必须为 ASCII 绝对路径。"
        )
    resolved = path.resolve()
    if not str(resolved).isascii():
        raise NativePdfError("path", "原生 PDF 路径解析后不是 ASCII 路径。")
    return resolved


def image_coverage(page) -> float:
    page_area = float(page.rect.width) * float(page.rect.height)
    if page_area <= 0:
        raise NativePdfError(
            "page_geometry", "PDF 页面尺寸无效，请尝试 MinerU 文档转换。"
        )
    image_area = 0.0
    # This reads image placement metadata, not image/OCR content.
    for image in page.get_image_info():
        x0, y0, x1, y1 = image["bbox"]
        left = max(float(page.rect.x0), float(x0))
        right = min(float(page.rect.x1), float(x1))
        top = max(float(page.rect.y0), float(y0))
        bottom = min(float(page.rect.y1), float(y1))
        image_area += max(0.0, right - left) * max(0.0, bottom - top)
    return min(1.0, image_area / page_area)


def preflight_pdf(path: Path, pymupdf, failure: FailureState) -> PdfInfo:
    try:
        if not path.is_file():
            raise NativePdfError("input_missing", "原生 PDF 输入文件不存在。")
        with path.open("rb") as source:
            if not source.read(8).startswith(b"%PDF-"):
                raise NativePdfError("pdf_header", "输入文件不是有效 PDF。")
        with pymupdf.open(str(path)) as document:
            if document.is_encrypted or document.needs_pass:
                raise NativePdfError(
                    "pdf_encrypted", "原生翻译暂不支持加密 PDF，请先自行解密。"
                )
            if document.page_count < 1:
                raise NativePdfError("pdf_empty", "PDF 没有可处理的页面。")
            dimensions = []
            total_text = 0
            for page in document:
                failure.check()
                width, height = float(page.rect.width), float(page.rect.height)
                if not all(
                    math.isfinite(value) and value > 0 for value in (width, height)
                ):
                    raise NativePdfError(
                        "page_geometry", "PDF 页面尺寸无效，请尝试 MinerU 文档转换。"
                    )
                dimensions.append((width, height))
                text_count = sum(
                    character.isalnum() for character in page.get_text("text")
                )
                total_text += text_count
                # A page-number-only text layer does not make a scan translatable.
                # Blank/vector-only pages can coexist with real text pages.
                if text_count < 20 and image_coverage(page) >= 0.75:
                    raise NativePdfError(
                        "scanned_pdf",
                        "检测到缺少可用文本层的扫描页，请改用 MinerU 文档转换。",
                    )
            if total_text == 0:
                raise NativePdfError(
                    "text_layer", "PDF 没有可用文本层，请改用 MinerU 文档转换。"
                )
            return PdfInfo(document.page_count, tuple(dimensions))
    except NativePdfError:
        raise
    except Exception as exc:
        raise NativePdfError(
            "pdf_open", "无法读取 PDF 或文本层，请尝试 MinerU 文档转换。"
        ) from exc


class EngineLogGuard(logging.Handler):
    """Catch upstream swallowed errors without leaking paragraph-bearing logs."""

    def __init__(self, failure: FailureState):
        super().__init__(logging.WARNING)
        self.failure = failure

    def emit(self, record: logging.LogRecord) -> None:
        if not record.name.startswith("babeldoc"):
            return
        strict_layout = any(
            part in record.name
            for part in (
                ".typesetting",
                ".pdf_creater",
                ".paragraph_finder",
                ".layout_parser",
            )
        )
        if record.levelno >= logging.ERROR or (
            strict_layout and record.levelno >= logging.WARNING
        ):
            # Never format record.msg, record.args or exc_info: upstream errors
            # often contain the entire original paragraph or extracted objects.
            self.failure.fail(
                NativePdfError(
                    "engine_layout", "原生 PDF 引擎报告解析或排版错误，未生成最终 PDF。"
                )
            )


def install_safe_logging(failure: FailureState) -> None:
    root = logging.getLogger()
    root.handlers.clear()
    root.setLevel(logging.WARNING)
    root.addHandler(EngineLogGuard(failure))
    logging.getLogger("babeldoc").setLevel(logging.WARNING)
    # Existing loggers can have their own handlers; those are not permitted to
    # print source text or provider prompts in this single-purpose process.
    for logger in list(logging.Logger.manager.loggerDict.values()):
        if isinstance(logger, logging.Logger):
            logger.handlers.clear()
            logger.propagate = True


def progress_message(event: dict) -> dict | None:
    if event.get("type") not in {"progress_start", "progress_update", "progress_end"}:
        return None
    stage = event.get("stage")
    current, total = event.get("stage_current"), event.get("stage_total")
    percent = event.get("stage_progress", 0)
    if (
        not isinstance(stage, str)
        or not stage
        or len(stage) > 200
        or type(current) is not int
        or type(total) is not int
        or min(current, total) < 0
        or isinstance(percent, bool)
        or not isinstance(percent, (int, float))
        or not math.isfinite(percent)
    ):
        raise NativePdfError("engine_progress", "原生 PDF 引擎返回了不兼容的进度消息。")
    return {
        "type": "progress",
        "stage": stage,
        "current": min(current, total),
        "total": total,
        "percent": min(100.0, max(0.0, float(percent))),
    }


def install_strict_pdf_writer(pdf_creator, failure: FailureState) -> None:
    """Avoid unmanaged grandchildren and fail-open save/subset fallbacks.

    Rust supervises this whole worker with a deadline and kill-on-cancel. The
    pinned engine's two helpers otherwise spawn multiprocessing children whose
    failures are converted to best-effort PDFs. Run the same PyMuPDF operations
    here so a hard cancel terminates every operation and every error is visible.
    """

    def subset_fonts_in_subprocess(pdf, translation_config, tag):
        failure.check()
        translation_config.raise_if_cancelled()
        try:
            pdf.subset_fonts(fallback=False)
        except Exception as exc:
            error = NativePdfError(
                "font_subset", "原生 PDF 字体处理失败，未生成最终 PDF。"
            )
            failure.fail(error)
            raise error from exc
        failure.check()
        return pdf

    def save_pdf_with_timeout(
        pdf,
        output_path,
        translation_config,
        garbage=1,
        deflate=True,
        clean=True,
        deflate_fonts=True,
        linear=False,
        timeout=120,
        tag="",
    ):
        failure.check()
        translation_config.raise_if_cancelled()
        try:
            pdf.save(
                str(output_path),
                garbage=garbage,
                deflate=deflate,
                clean=clean,
                deflate_fonts=deflate_fonts,
                linear=linear,
            )
        except Exception as exc:
            error = NativePdfError("pdf_save", "原生 PDF 保存失败，未生成最终 PDF。")
            failure.fail(error)
            raise error from exc
        failure.check()
        return True

    pdf_creator.subset_fonts_in_subprocess = staticmethod(subset_fonts_in_subprocess)
    pdf_creator.save_pdf_with_timeout = staticmethod(save_pdf_with_timeout)


def paragraph_has_body_text(paragraph) -> bool:
    """Ignore recognized formula objects and numeric-only rotation labels."""
    compositions = getattr(paragraph, "pdf_paragraph_composition", None)
    if not compositions:
        return any(
            character.isalpha()
            for character in (getattr(paragraph, "unicode", "") or "")
        )
    for composition in compositions:
        if getattr(composition, "pdf_formula", None) is not None:
            continue
        grouped = getattr(composition, "pdf_line", None) or getattr(
            composition, "pdf_same_style_characters", None
        )
        if grouped is not None:
            text = "".join(
                (getattr(character, "char_unicode", "") or "")
                for character in (getattr(grouped, "pdf_character", None) or [])
            )
        elif getattr(composition, "pdf_character", None) is not None:
            text = getattr(composition.pdf_character, "char_unicode", "") or ""
        elif (
            getattr(composition, "pdf_same_style_unicode_characters", None) is not None
        ):
            text = (
                getattr(composition.pdf_same_style_unicode_characters, "unicode", "")
                or ""
            )
        else:
            # An unknown composition must not silently hide readable text.
            text = getattr(paragraph, "unicode", "") or ""
        if any(character.isalpha() for character in text):
            return True
    return False


def install_vertical_text_guard(translator_class, failure: FailureState) -> None:
    original = translator_class.pre_translate_paragraph

    @functools.wraps(original)
    def pre_translate_paragraph(self, paragraph, tracker, page_font_map, xobj_font_map):
        if getattr(paragraph, "vertical", False) and paragraph_has_body_text(paragraph):
            error = NativePdfError(
                "vertical_text",
                "PDF 含不支持的竖排或旋转正文，请改用 MinerU 文档转换。",
            )
            failure.fail(error)
            raise error
        return original(self, paragraph, tracker, page_font_map, xobj_font_map)

    translator_class.pre_translate_paragraph = pre_translate_paragraph


def run_engine(
    input_path: Path,
    engine_output: Path,
    scratch: Path,
    workers: int,
    writer: JsonlWriter,
    bridge: TranslationBridge,
    failure: FailureState,
):
    from babeldoc.format.pdf.document_il.backend.pdf_creater import PDFCreater
    from babeldoc.format.pdf.document_il.midend.il_translator import ILTranslator
    from babeldoc.format.pdf.high_level import do_translate, get_translation_stage
    from babeldoc.format.pdf.translation_config import (
        TranslationConfig,
        WatermarkOutputMode,
    )
    from babeldoc.progress_monitor import ProgressMonitor

    install_strict_pdf_writer(PDFCreater, failure)
    install_vertical_text_guard(ILTranslator, failure)
    config = TranslationConfig(
        translator=PoolTranslator(bridge),
        input_file=input_path,
        lang_in="en",
        lang_out="zh-CN",
        doc_layout_model=None,
        output_dir=engine_output,
        working_dir=scratch / "engine-work",
        debug=False,
        no_dual=False,
        no_mono=False,
        use_rich_pbar=False,
        report_interval=0.2,
        min_text_length=1,
        use_alternating_pages_dual=True,
        watermark_output_mode=WatermarkOutputMode.NoWatermark,
        pool_max_workers=workers,
        auto_extract_glossary=False,
        save_auto_extracted_glossary=False,
        auto_enable_ocr_workaround=False,
        ocr_workaround=False,
        skip_scanned_detection=False,
    )

    def on_progress(**event):
        failure.check()
        message = progress_message(event)
        if message is not None:
            try:
                writer.emit(message)
            except NativePdfError as exc:
                failure.fail(exc)
                raise

    def on_finish(**event):
        # v0.6.4 calls on_finish with a cancellation sentinel even on success.
        # The synchronous return/exception and our independent latch are the
        # authoritative result; no engine "finish" event is forwarded blindly.
        return None

    cancel_event = threading.Event()
    with ProgressMonitor(
        get_translation_stage(config),
        progress_change_callback=on_progress,
        finish_callback=on_finish,
        cancel_event=cancel_event,
    ) as monitor:
        config.progress_monitor = monitor
        failure.add_listener(config.cancel_translation)
        failure.check()
        # Cold NumPy / OpenCV DLL initialization can take CRT stdio locks on
        # Windows. Do it, and model construction, before a background thread
        # starts blocking on stdin. Translation itself still uses the reader.
        bridge.start()
        result = do_translate(monitor, config)
    failure.check()
    return result


def verified_output_path(value, engine_output: Path) -> Path:
    if value is None:
        raise NativePdfError(
            "output_missing", "原生 PDF 引擎未生成完整的单语及双语文件。"
        )
    path = Path(value)
    try:
        resolved = path.resolve(strict=True)
        if (
            path.is_symlink()
            or not resolved.is_relative_to(engine_output.resolve())
            or not resolved.is_file()
            or resolved.stat().st_size == 0
        ):
            raise OSError("invalid output")
    except (OSError, ValueError) as exc:
        raise NativePdfError(
            "output_path", "原生 PDF 输出文件缺失或路径无效。"
        ) from exc
    return resolved


def verify_output_pdf(path: Path, expected: PdfInfo, multiplier: int, pymupdf) -> None:
    try:
        with path.open("rb") as source:
            if not source.read(8).startswith(b"%PDF-"):
                raise ValueError("missing PDF header")
        with pymupdf.open(str(path)) as document:
            if (
                document.needs_pass
                or document.is_encrypted
                or document.page_count != expected.pages * multiplier
            ):
                raise ValueError("incomplete page set")
            for index, page in enumerate(document):
                width, height = expected.dimensions[index // multiplier]
                if (
                    abs(float(page.rect.width) - width) > 1.0
                    or abs(float(page.rect.height) - height) > 1.0
                ):
                    raise ValueError("page dimensions changed")
                # Force each page to parse; a valid catalog alone is insufficient.
                page.get_text("text")
    except Exception as exc:
        raise NativePdfError(
            "output_invalid", "原生 PDF 输出未通过页数、页面尺寸或可读性检查。"
        ) from exc


def publish_outputs(
    mono: Path, dual: Path, output: Path, failure: FailureState
) -> None:
    output.mkdir(exist_ok=True)
    if any(output.iterdir()):
        raise NativePdfError(
            "output_exists", "原生 PDF 输出目录非空，拒绝覆盖已有文件。"
        )
    created: list[Path] = []
    try:
        for source, name in ((mono, "mono.pdf"), (dual, "dual.pdf")):
            failure.check()
            target = output / name
            with source.open("rb") as incoming, target.open("xb") as outgoing:
                created.append(target)
                shutil.copyfileobj(incoming, outgoing, 1_048_576)
                outgoing.flush()
                os.fsync(outgoing.fileno())
        failure.check()
    except BaseException:
        # Only files opened exclusively by this invocation may be removed.
        for target in created:
            if target.parent.resolve() == output.resolve() and not target.is_symlink():
                target.unlink(missing_ok=True)
        raise


def execute(options, writer: JsonlWriter, reader: BinaryIO) -> int:
    input_path = absolute_ascii_path(options.input)
    output = absolute_ascii_path(options.output)
    asset_dir = absolute_ascii_path(options.asset_dir)
    if (
        not output.parent.is_dir()
        or output == input_path
        or output == asset_dir
        or output.parent == asset_dir
    ):
        raise NativePdfError("path", "原生 PDF 工作目录无效。")
    if output.exists() and (not output.is_dir() or any(output.iterdir())):
        raise NativePdfError(
            "output_exists", "原生 PDF 输出目录非空，拒绝覆盖已有文件。"
        )
    failure = FailureState()
    install_safe_logging(failure)
    bridge = TranslationBridge(reader, writer, failure, options.workers)
    scratch = Path(tempfile.mkdtemp(prefix="native-pdf-", dir=output.parent))
    previous_cwd = Path.cwd()
    try:
        sys.dont_write_bytecode = True
        os.chdir(scratch)
        check_engine_version()
        configure_storage(asset_dir, scratch)
        import pymupdf

        pymupdf.TOOLS.mupdf_display_errors(False)
        pymupdf.TOOLS.mupdf_display_warnings(False)
        info = preflight_pdf(input_path, pymupdf, failure)
        verify_bundle(asset_dir)
        failure.check()
        configure_cpu_runtime()
        install_network_guard(failure)
        install_process_guard(failure)
        writer.emit(
            {
                "type": "ready",
                "pages": info.pages,
                "engine": "BabelDOC",
                "version": ENGINE_VERSION,
            }
        )
        engine_output = scratch / "engine-output"
        result = run_engine(
            input_path, engine_output, scratch, options.workers, writer, bridge, failure
        )
        failure.check()
        mono = verified_output_path(result.mono_pdf_path, engine_output)
        dual = verified_output_path(result.dual_pdf_path, engine_output)
        verify_output_pdf(mono, info, 1, pymupdf)
        verify_output_pdf(dual, info, 2, pymupdf)
        failure.check()
        publish_outputs(mono, dual, output, failure)
        bridge.seal_success()
        writer.emit(
            {
                "type": "result",
                "mono": "mono.pdf",
                "dual": "dual.pdf",
                "pages": info.pages,
            }
        )
        # Rust acknowledges the result by closing stdin. Join before Python
        # finalizes its buffered streams; never leave a daemon reading stdin
        # while the interpreter is trying to close that same buffer.
        bridge.wait_closed()
        return 0
    except BaseException as exc:
        failure.fail(
            exc
            if isinstance(exc, NativePdfError)
            else NativePdfError(
                "worker_stopped", "原生 PDF 处理已中止，未确认最终文件。"
            )
        )
        # A cancellation raised by the engine may have been triggered by an
        # earlier swallowed layout/provider error. Preserve that safe cause.
        failure.check()
        raise
    finally:
        os.chdir(previous_cwd)
        resolved = scratch.resolve()
        if resolved.parent != output.parent.resolve() or not resolved.name.startswith(
            "native-pdf-"
        ):
            raise NativePdfError("cleanup_path", "原生 PDF 临时目录不符合清理约定。")
        shutil.rmtree(resolved)


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument(
        "--workers", required=True, type=int, choices=range(1, 65), metavar="1..64"
    )
    parser.add_argument("--asset-dir", required=True)
    return parser.parse_args(argv)


def main(argv=None) -> int:
    options = parse_args(argv)
    # Keep a duplicate of the protocol descriptor, then discard all incidental
    # Python/C-library stdout. Only JsonlWriter can reach the duplicate.
    protocol = os.fdopen(
        os.dup(sys.stdout.fileno()), "w", encoding="utf-8", buffering=1
    )
    try:
        with open(os.devnull, "w", encoding="utf-8") as discard:
            os.dup2(discard.fileno(), sys.stdout.fileno())
            with contextlib.redirect_stdout(discard):
                writer = JsonlWriter(protocol)
                try:
                    return execute(options, writer, sys.stdin.buffer)
                except NativePdfError as exc:
                    with contextlib.suppress(NativePdfError):
                        writer.emit({"type": "error", "message": exc.safe_message})
                    sys.stderr.write(f"native-pdf {exc.code}: {exc.safe_message}\n")
                except BaseException:  # noqa: BLE001 -- The worker boundary must suppress document-bearing errors.
                    # Do not expose upstream exception text or tracebacks; either
                    # can contain paragraph text. Rust reports the failed task.
                    message = "原生 PDF 处理失败，未确认最终文件。"
                    with contextlib.suppress(NativePdfError):
                        writer.emit({"type": "error", "message": message})
                    sys.stderr.write(f"native-pdf worker_failed: {message}\n")
    finally:
        with contextlib.suppress(OSError):
            protocol.close()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
