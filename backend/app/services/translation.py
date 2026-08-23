from __future__ import annotations

import re
import time
from collections.abc import Callable

import httpx


class TranslationError(RuntimeError):
    pass


PROTECTED_RE = re.compile(
    r"```[^\n]*\n.*?\n```|~~~[^\n]*\n.*?\n~~~|"
    r"\$\$.*?\$\$|\\\[.*?\\\]|\\\(.*?\\\)|"
    r"`+[^`\n]+`+|(?<!\\)(?<!\$)\$(?!\$)(?:\\.|[^$\n])+?(?<!\\)\$|"
    r"!\[[^\]]*\]\([^\n)]*\)|<img\b[^>]*>",
    re.IGNORECASE | re.DOTALL,
)
LINK_DEST_RE = re.compile(r"(?<!!)\[([^\]]+)\]\(([^)\n]+)\)")
PLACEHOLDER_RE = re.compile(r"DOCFLOWKEEP\d{6}TOKEN")
TranslationCallback = Callable[[str, int, int, dict[str, int | str]], None]


def protect_markdown(markdown: str) -> tuple[str, dict[str, str]]:
    protected: dict[str, str] = {}

    def stash(value: str) -> str:
        token = f"DOCFLOWKEEP{len(protected):06d}TOKEN"
        protected[token] = value
        return token

    text = PROTECTED_RE.sub(lambda match: stash(match.group(0)), markdown)

    def protect_link(match: re.Match[str]) -> str:
        return f"[{match.group(1)}]({stash(match.group(2))})"

    text = LINK_DEST_RE.sub(protect_link, text)
    return text, protected


def restore_markdown(text: str, protected: dict[str, str], expected_source: str) -> str:
    expected = [token for token in protected if token in expected_source]
    text = text.replace("\u200b", "").replace("\ufeff", "")
    for token in expected:
        text = re.sub(re.escape(token), token, text, flags=re.IGNORECASE)
        text = re.sub(rf"`+{re.escape(token)}`+", token, text)
    broken = [token for token in expected if text.count(token) != 1]
    if broken:
        raise TranslationError(f"翻译结果破坏了 {len(broken)} 个公式、代码、图片或链接占位符")
    for token in expected:
        text = text.replace(token, protected[token])
    return text


def _hard_split_preserving_placeholders(text: str, limit: int) -> list[str]:
    pieces: list[str] = []
    current = ""
    parts = re.split(f"({PLACEHOLDER_RE.pattern})", text)
    for part in parts:
        if not part:
            continue
        units = [part] if PLACEHOLDER_RE.fullmatch(part) else [part[index : index + limit] for index in range(0, len(part), limit)]
        for unit in units:
            if current and len(current) + len(unit) > limit:
                pieces.append(current)
                current = ""
            current += unit
    if current:
        pieces.append(current)
    return pieces


def _split_oversized(text: str, limit: int) -> list[str]:
    if len(text) <= limit:
        return [text]
    sentences = re.split(r"(?<=[。！？.!?；;])(?=\s|[^\s])", text)
    if len(sentences) == 1:
        sentences = text.splitlines(keepends=True)
    if len(sentences) == 1:
        return _hard_split_preserving_placeholders(text, limit)
    pieces: list[str] = []
    current = ""
    for sentence in sentences:
        if len(sentence) > limit:
            if current:
                pieces.append(current)
                current = ""
            pieces.extend(_hard_split_preserving_placeholders(sentence, limit))
        elif current and len(current) + len(sentence) > limit:
            pieces.append(current)
            current = sentence
        else:
            current += sentence
    if current:
        pieces.append(current)
    return pieces


def chunk_markdown(markdown: str, limit: int) -> list[str]:
    blocks = re.split(r"\n{2,}", markdown)
    chunks: list[str] = []
    current: list[str] = []
    size = 0
    for block in blocks:
        for piece in _split_oversized(block, limit):
            addition = len(piece) + (2 if current else 0)
            if current and size + addition > limit:
                chunks.append("\n\n".join(current))
                current = []
                size = 0
            current.append(piece)
            size += len(piece) + (2 if len(current) > 1 else 0)
    if current:
        chunks.append("\n\n".join(current))
    return [chunk for chunk in chunks if chunk.strip()]


def _strip_code_wrapper(text: str) -> str:
    value = text.strip()
    match = re.fullmatch(r"```(?:markdown|md)?\s*\n(.*)\n```", value, re.DOTALL | re.IGNORECASE)
    return match.group(1).strip() if match else value


def call_deepseek(
    api_key: str,
    model: str,
    content: str,
    *,
    timeout: float = 180.0,
    strict_placeholders: bool = False,
    on_retry: Callable[[int, int, int], None] | None = None,
) -> str:
    placeholder_rule = (
        "这是占位符校验重试：不得改变任何 DOCFLOWKEEP 加六位数字再加 TOKEN 的连续字符串；"
        "不得改变大小写，不得在其中或两侧添加反引号、空格或标点；输出前逐个核对数量。"
        if strict_placeholders
        else "所有形如 DOCFLOWKEEP000000TOKEN 的占位符必须原样保留且各出现一次。"
    )
    payload = {
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": (
                    "你是专业文献译者。把用户提供的 Markdown 内容准确翻译为简体中文。"
                    "保留 Markdown 的标题层级、列表、表格、引用等结构；"
                    f"{placeholder_rule}不要解释，不要添加代码围栏，只输出翻译后的 Markdown。"
                ),
            },
            {"role": "user", "content": content},
        ],
        "temperature": 0.0 if strict_placeholders else 0.1,
        "max_tokens": 16_384,
        "stream": False,
        "thinking": {"type": "disabled"},
    }
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    last_error = ""
    with httpx.Client(timeout=httpx.Timeout(timeout, connect=20.0), trust_env=False) as client:
        for attempt in range(4):
            response = client.post("https://api.deepseek.com/chat/completions", headers=headers, json=payload)
            if response.status_code == 400 and "thinking" in response.text.lower():
                payload.pop("thinking", None)
                continue
            if response.status_code in (429, 500, 502, 503, 504):
                last_error = response.text[:300]
                delay = min(2**attempt, 8)
                if on_retry:
                    on_retry(attempt + 1, response.status_code, delay)
                time.sleep(delay)
                continue
            if response.status_code >= 400:
                raise TranslationError(f"DeepSeek 请求失败（HTTP {response.status_code}）：{response.text[:300]}")
            try:
                result = response.json()["choices"][0]["message"]["content"]
            except (KeyError, IndexError, TypeError, ValueError) as exc:
                raise TranslationError("DeepSeek 返回格式异常") from exc
            if not isinstance(result, str) or not result.strip():
                raise TranslationError("DeepSeek 返回了空翻译")
            return _strip_code_wrapper(result)
    raise TranslationError(f"DeepSeek 暂时不可用：{last_error or '重试后仍失败'}")


def validate_deepseek(api_key: str, model: str) -> None:
    result = call_deepseek(api_key, model, "只回复：好", timeout=45.0)
    if not result.strip():
        raise TranslationError("DeepSeek 模型未返回内容")


def translate_markdown(
    markdown: str,
    *,
    api_key: str,
    model: str,
    chunk_chars: int,
    on_progress: TranslationCallback,
) -> str:
    protected_text, protected = protect_markdown(markdown)
    chunks = chunk_markdown(protected_text, chunk_chars)
    on_progress(
        "prepared",
        0,
        len(chunks),
        {
            "characters": len(markdown),
            "placeholders": len(protected),
            "chunk_limit": chunk_chars,
        },
    )
    translated: list[str] = []
    for index, chunk in enumerate(chunks, start=1):
        last_error: Exception | None = None
        chunk_placeholders = len(PLACEHOLDER_RE.findall(chunk))
        on_progress(
            "chunk_started",
            index,
            len(chunks),
            {"characters": len(chunk), "placeholders": chunk_placeholders},
        )
        started = time.monotonic()
        for attempt in range(1, 3):
            on_progress(
                "chunk_attempt",
                index,
                len(chunks),
                {"attempt": attempt, "characters": len(chunk), "placeholders": chunk_placeholders},
            )
            try:
                def api_retry(api_attempt: int, status: int, delay: int) -> None:
                    on_progress(
                        "api_retry",
                        index,
                        len(chunks),
                        {
                            "attempt": attempt,
                            "api_attempt": api_attempt,
                            "http_status": status,
                            "delay_seconds": delay,
                        },
                    )

                result = call_deepseek(
                    api_key,
                    model,
                    chunk,
                    strict_placeholders=attempt > 1,
                    on_retry=api_retry,
                )
                translated.append(restore_markdown(result, protected, chunk))
                last_error = None
                break
            except TranslationError as exc:
                last_error = exc
                on_progress(
                    "chunk_retry" if attempt < 2 else "chunk_failed",
                    index,
                    len(chunks),
                    {"attempt": attempt, "error": str(exc)[:500]},
                )
        if last_error is not None:
            raise TranslationError(
                f"第 {index} / {len(chunks)} 个翻译分块连续 2 次校验失败：{last_error}"
            ) from last_error
        on_progress(
            "chunk_completed",
            index,
            len(chunks),
            {
                "seconds": round(time.monotonic() - started, 1),
                "characters": len(chunk),
                "placeholders": chunk_placeholders,
            },
        )
    on_progress(
        "completed",
        len(chunks),
        len(chunks),
        {"characters": len(markdown), "placeholders": len(protected)},
    )
    return "\n\n".join(translated)
