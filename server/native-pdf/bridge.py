"""Bounded JSONL transport. This module deliberately has no provider clients."""

from __future__ import annotations

import contextlib
import json
import re
import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import BinaryIO, TextIO

MAX_LINE_BYTES = 1_048_576
MAX_TEXT_CHARS = 200_000
MAX_REQUEST_ID = (1 << 64) - 1
FORMULA_PATTERN = re.compile(r"\{\s*v\s*(\d+)\s*\}", re.IGNORECASE)


class NativePdfError(Exception):
    """Only fixed, non-document-bearing messages may cross the log boundary."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.safe_message = message


class FailureState:
    """A first-error latch shared by IPC, engine threads and log observers."""

    def __init__(self):
        self._lock = threading.Lock()
        self._error: NativePdfError | None = None
        self._listeners: list[Callable[[], None]] = []

    def add_listener(self, listener: Callable[[], None]) -> None:
        with self._lock:
            self._listeners.append(listener)
            failed = self._error is not None
        if failed:
            listener()

    def fail(self, error: NativePdfError) -> None:
        with self._lock:
            if self._error is not None:
                return
            self._error = error
            listeners = list(self._listeners)
        for listener in listeners:
            # Preserve the initiating error; never log its source document.
            with contextlib.suppress(Exception):
                listener()

    def check(self) -> None:
        with self._lock:
            error = self._error
        if error is not None:
            raise error

    @property
    def failed(self) -> bool:
        with self._lock:
            return self._error is not None


class JsonlWriter:
    def __init__(self, stream: TextIO):
        self._stream = stream
        self._lock = threading.Lock()

    def emit(self, message: dict) -> None:
        try:
            line = (
                json.dumps(
                    message, ensure_ascii=False, separators=(",", ":"), allow_nan=False
                )
                + "\n"
            )
            if len(line.encode("utf-8")) > MAX_LINE_BYTES:
                raise NativePdfError("ipc_size", "原生 PDF 处理消息超过安全大小限制。")
            with self._lock:
                self._stream.write(line)
                self._stream.flush()
        except NativePdfError:
            raise
        except (OSError, UnicodeError, ValueError, TypeError) as exc:
            raise NativePdfError(
                "ipc_write", "原生 PDF 处理连接已关闭或消息无效。"
            ) from exc


@dataclass
class PendingTranslation:
    source: str
    event: threading.Event = field(default_factory=threading.Event)
    translated: str | None = None


def validate_translation(source: str, translated: object) -> str:
    if not isinstance(translated, str) or not translated.strip():
        raise NativePdfError(
            "translation_empty", "翻译服务未返回有效段落，未生成最终 PDF。"
        )
    if len(translated) > MAX_TEXT_CHARS:
        raise NativePdfError(
            "translation_size", "翻译段落超过安全大小限制，未生成最终 PDF。"
        )
    expected = [int(match.group(1)) for match in FORMULA_PATTERN.finditer(source)]
    actual = [int(match.group(1)) for match in FORMULA_PATTERN.finditer(translated)]
    if expected != actual:
        raise NativePdfError(
            "formula_mismatch", "译文中的公式保护标记不完整，未生成最终 PDF。"
        )
    # The renderer accepts whitespace/case variants, but canonical output keeps
    # source-protection checks deterministic between the two runtimes.
    return FORMULA_PATTERN.sub(
        lambda match: "{v" + str(int(match.group(1))) + "}", translated
    )


class TranslationBridge:
    """One synchronous callback per engine thread; Rust owns every cloud queue."""

    def __init__(
        self,
        reader: BinaryIO,
        writer: JsonlWriter,
        failure: FailureState,
        max_pending: int,
    ):
        if type(max_pending) is not int or not 1 <= max_pending <= 64:
            raise NativePdfError(
                "workers", "原生 PDF 本地回调并发必须在 1 至 64 之间。"
            )
        self.reader = reader
        self.writer = writer
        self.failure = failure
        self.max_pending = max_pending
        self._lock = threading.Lock()
        self._pending: dict[int, PendingTranslation] = {}
        self._next_id = 1
        self._finished = False
        self.request_count = 0
        self.completed_count = 0
        self._thread: threading.Thread | None = None
        failure.add_listener(self._wake_all)

    def start(self) -> None:
        if self._thread is not None:
            raise NativePdfError("ipc_state", "原生 PDF 处理连接重复启动。")
        self._thread = threading.Thread(
            target=self._read_loop, name="native-pdf-replies", daemon=True
        )
        self._thread.start()

    def _wake_all(self) -> None:
        with self._lock:
            pending = list(self._pending.values())
        for item in pending:
            item.event.set()

    def translate(self, text: str) -> str:
        try:
            self.failure.check()
            if not isinstance(text, str) or len(text) > MAX_TEXT_CHARS:
                raise NativePdfError(
                    "paragraph_size", "原生 PDF 段落超过安全大小限制。"
                )
            if not text.strip() or not FORMULA_PATTERN.sub("", text).strip():
                return text
            with self._lock:
                if self._finished or len(self._pending) >= self.max_pending:
                    raise NativePdfError("ipc_state", "原生 PDF 回调超出本地并发限制。")
                if self._next_id > MAX_REQUEST_ID:
                    raise NativePdfError("ipc_state", "原生 PDF 请求编号超过安全范围。")
                request_id = self._next_id
                self._next_id += 1
                pending = PendingTranslation(text)
                self._pending[request_id] = pending
                self.request_count += 1
            try:
                self.writer.emit(
                    {"type": "translate", "request_id": request_id, "text": text}
                )
                pending.event.wait()
                self.failure.check()
                if pending.translated is None:
                    raise NativePdfError(
                        "ipc_closed", "翻译连接提前关闭，未生成最终 PDF。"
                    )
                return pending.translated
            finally:
                with self._lock:
                    self._pending.pop(request_id, None)
        except NativePdfError as exc:
            self.failure.fail(exc)
            raise
        except Exception as exc:
            safe = NativePdfError(
                "translation_callback", "原生 PDF 翻译回调失败，未生成最终 PDF。"
            )
            self.failure.fail(safe)
            raise safe from exc

    def accept(self, message: object) -> None:
        """Validate a single response. Exposed for dependency-free contract tests."""
        try:
            if not isinstance(message, dict) or message.get("type") not in {
                "translation",
                "error",
            }:
                raise NativePdfError("ipc_message", "翻译连接返回了未知消息。")
            request_id = message.get("request_id")
            if type(request_id) is not int or not 1 <= request_id <= MAX_REQUEST_ID:
                raise NativePdfError("ipc_id", "翻译连接返回了无效请求编号。")
            with self._lock:
                pending = self._pending.get(request_id)
                if pending is None or pending.event.is_set():
                    raise NativePdfError("ipc_id", "翻译连接返回了未知或重复请求编号。")
                if message["type"] == "error":
                    # Provider errors can contain quoted input. Do not retain or
                    # echo their free-form message; Rust already owns diagnostics.
                    raise NativePdfError(
                        "translation_failed", "翻译服务报告失败，未生成最终 PDF。"
                    )
                pending.translated = validate_translation(
                    pending.source, message.get("text")
                )
                self.completed_count += 1
                pending.event.set()
        except NativePdfError as exc:
            self.failure.fail(exc)
            raise

    def _read_loop(self) -> None:
        try:
            while True:
                line = self.reader.readline(MAX_LINE_BYTES + 1)
                with self._lock:
                    finished = self._finished
                if finished:
                    return
                if not line:
                    raise NativePdfError(
                        "ipc_eof", "翻译连接提前关闭，未生成最终 PDF。"
                    )
                if len(line) > MAX_LINE_BYTES or not line.endswith(b"\n"):
                    raise NativePdfError("ipc_size", "翻译连接消息过大或不完整。")
                try:
                    message = json.loads(line.decode("utf-8"))
                except (ValueError, UnicodeError) as exc:
                    raise NativePdfError(
                        "ipc_json", "翻译连接返回了无效 JSON。"
                    ) from exc
                self.accept(message)
        except NativePdfError as exc:
            self.failure.fail(exc)
        except Exception:  # noqa: BLE001 -- Every broken IPC read must wake waiting callbacks.
            self.failure.fail(
                NativePdfError("ipc_read", "读取翻译连接失败，未生成最终 PDF。")
            )

    def seal_success(self) -> None:
        self.failure.check()
        with self._lock:
            if self._pending or self.completed_count != self.request_count:
                raise NativePdfError("ipc_incomplete", "仍有未完成的 PDF 翻译段落。")
            if self.request_count == 0:
                raise NativePdfError(
                    "no_paragraphs", "未识别到可翻译段落，请尝试 MinerU 文档转换。"
                )
            self._finished = True
        self.failure.check()

    def wait_closed(self, timeout: float = 5.0) -> None:
        """Wait for the supervisor's EOF acknowledgement after a sealed result."""
        if self._thread is None:
            raise NativePdfError("ipc_state", "原生 PDF 翻译连接未启动。")
        self._thread.join(timeout)
        if self._thread.is_alive():
            self.failure.fail(
                NativePdfError(
                    "ipc_shutdown", "原生 PDF 结果确认连接未及时关闭，未发布结果。"
                )
            )
        self.failure.check()


class PoolTranslator:
    """BabelDOC's duck-typed non-LLM contract, with no cache/rate-limit parent."""

    name = "docflow_pool"
    model = "rust-managed"
    lang_in = "en"
    lang_out = "zh-CN"
    ignore_cache = True

    def __init__(self, bridge: TranslationBridge):
        self.bridge = bridge

    def translate(self, text, ignore_cache=False, rate_limit_params=None):
        return self.bridge.translate(text)

    def do_translate(self, text, rate_limit_params=None):
        return self.bridge.translate(text)

    def do_llm_translate(self, text, rate_limit_params=None):
        # BabelDOC probes with None. Returning None would enable its separate
        # LLM batching/prompts/glossary machinery, bypassing DocFlow settings.
        raise NotImplementedError("DocFlow owns LLM prompts and batching")

    def get_formular_placeholder(self, placeholder_id):
        return "{v" + str(placeholder_id) + "}", r"\{\s*v\s*" + str(
            placeholder_id
        ) + r"\s*\}"

    def get_rich_text_left_placeholder(self, placeholder_id):
        return (
            "<style id='" + str(placeholder_id) + "'>",
            r"<\s*style\s*id\s*=\s*'\s*" + str(placeholder_id) + r"\s*'\s*>",
        )

    def get_rich_text_right_placeholder(self, placeholder_id):
        return "</style>", r"<\s*/\s*style\s*>"
