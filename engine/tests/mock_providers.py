#!/usr/bin/env python3
"""Local stand-ins for the translation services, for integration tests.

Serves the OpenAI-compatible (/v1), Anthropic (/anthropic/v1) and Gemini
(/gemini/v1beta) APIs. The "translations" append 〔模拟译文〕 and misbehave
on purpose, so the engine's repair paths get exercised:

- every 9th request answers HTTP 429;
- a request longer than 3000 characters is cut in half (finish "length");
- a segment containing DROP_ME is left out of multi-segment replies;
- DAMAGE_MARKERS: placeholders come back with spaces inside;
- LOSE_MARKERS: placeholders are dropped from the reply;
- REFUSE_ME: the provider refuses (content filter);
- the model "mock-reasoner" wraps its answer in a <think> block.

GET /stats reports what happened, including the peak number of requests in
flight per API.
"""

from __future__ import annotations

import json
import re
import sys
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MARK = "〔模拟译文〕"
KEYS = {"openai": "test-key", "anthropic": "claude-key", "gemini": "gemini-key"}
# `mock_providers.py <port> --open` accepts any key (for trying the apps).
OPEN = "--open" in sys.argv
SEGMENT = re.compile(r'<segment id="(\d+)">\n(.*?)\n</segment>', re.S)
MARKER = re.compile(r"DOCFLOWKEEP\d{6}TOKEN")
TRUNCATE_ABOVE = 3000


class State:
    lock = threading.Lock()
    requests: dict[str, int] = {}
    in_flight: dict[str, int] = {}
    peak: dict[str, int] = {}
    stats: dict[str, int] = {}

    @classmethod
    def count(cls, key: str) -> None:
        with cls.lock:
            cls.stats[key] = cls.stats.get(key, 0) + 1

    @classmethod
    def enter(cls, api: str) -> int:
        with cls.lock:
            cls.requests[api] = cls.requests.get(api, 0) + 1
            cls.in_flight[api] = cls.in_flight.get(api, 0) + 1
            cls.peak[api] = max(cls.peak.get(api, 0), cls.in_flight[api])
            return cls.requests[api]

    @classmethod
    def leave(cls, api: str) -> None:
        with cls.lock:
            cls.in_flight[api] -= 1

    @classmethod
    def snapshot(cls) -> dict:
        with cls.lock:
            return {"requests": dict(cls.requests), "peak": dict(cls.peak), **cls.stats}


def translate_line(line: str) -> str:
    if not line.strip():
        return line
    body = line.rstrip()
    return body + MARK + line[len(body):]


def translate_text(text: str) -> str:
    """Marks every non-empty line, the way a real translation changes every line."""
    out = "\n".join(translate_line(line) for line in text.split("\n"))
    if "DAMAGE_MARKERS" in text and MARKER.search(out):
        State.count("damaged")
        out = out.replace("DOCFLOWKEEP", "DOCFLOW KEEP ")
    if "LOSE_MARKERS" in text and MARKER.search(out):
        State.count("lost_markers")
        out = MARKER.sub("", out)
    return out


def reply_for(user: str) -> tuple[str, str]:
    """(text, finish) for a chat request."""
    if "REFUSE_ME" in user:
        State.count("refused")
        return "", "content_filter"
    segments = SEGMENT.findall(user)
    if segments:
        parts = []
        for seg_id, text in segments:
            if "DROP_ME" in text and len(segments) > 1:
                State.count("dropped")
                continue
            parts.append(f'<segment id="{seg_id}">\n{translate_text(text)}\n</segment>')
        text = "\n".join(parts)
    else:
        text = translate_text(user)
    if len(user) > TRUNCATE_ABOVE:
        State.count("truncated")
        return text[: len(text) // 2], "length"
    return text, "stop"


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):  # quiet
        pass

    def send_body(self, status: int, body: bytes, content_type: str, headers: dict[str, str] | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, status: int, value, headers: dict[str, str] | None = None) -> None:
        body = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_body(status, body, "application/json", headers)

    def read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length)

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/v1/models":
            if not OPEN and self.headers.get("Authorization") != f"Bearer {KEYS['openai']}":
                return self.send_json(401, {"error": {"message": "Incorrect API key provided"}})
            return self.send_json(200, {"object": "list", "data": [
                {"id": "mock-model", "owned_by": "mock"},
                {"id": "mock-reasoner", "owned_by": "mock"},
            ]})
        if path == "/anthropic/v1/models":
            if not OPEN and self.headers.get("x-api-key") != KEYS["anthropic"]:
                return self.send_json(401, {"type": "error", "error": {"type": "authentication_error", "message": "invalid x-api-key"}})
            query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            if query.get("after_id") == ["claude-mock"]:
                return self.send_json(200, {"data": [{"id": "claude-mock-2", "display_name": "Claude Mock 2"}], "has_more": False})
            return self.send_json(200, {"data": [{"id": "claude-mock", "display_name": "Claude Mock"}], "has_more": True, "last_id": "claude-mock"})
        if path == "/gemini/v1beta/models":
            if not OPEN and self.headers.get("x-goog-api-key") != KEYS["gemini"]:
                return self.send_json(400, {"error": {"code": 400, "message": "API key not valid. Please pass a valid API key.", "status": "INVALID_ARGUMENT"}})
            return self.send_json(200, {"models": [
                {"name": "models/gemini-mock", "displayName": "Gemini Mock", "supportedGenerationMethods": ["generateContent", "countTokens"]},
                {"name": "models/embed-mock", "supportedGenerationMethods": ["embedContent"]},
            ]})
        if path == "/stats":
            return self.send_json(200, State.snapshot())
        self.send_json(404, {"error": {"message": "not found"}})

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        raw = self.read_body()
        api = "anthropic" if path.startswith("/anthropic/") else "gemini" if path.startswith("/gemini/") else "openai"
        number = State.enter(api)
        try:
            self.answer(api, number, path, raw)
        finally:
            State.leave(api)

    def answer(self, api: str, number: int, path: str, raw: bytes) -> None:
        if number % 9 == 0:
            State.count("rate_limited")
            return self.send_json(429, {"error": {"message": "Rate limit reached, please retry"}}, {"Retry-After": "1"})
        body = json.loads(raw or b"{}")
        if api == "openai" and path == "/v1/chat/completions":
            if not OPEN and self.headers.get("Authorization") != f"Bearer {KEYS['openai']}":
                return self.send_json(401, {"error": {"message": "Incorrect API key provided", "code": "invalid_api_key"}})
            if body.get("model") not in ("mock-model", "mock-reasoner"):
                return self.send_json(404, {"error": {"message": "The model does not exist", "code": "model_not_found"}})
            user = body["messages"][-1]["content"]
            text, finish = reply_for(user)
            if body["model"] == "mock-reasoner" and text:
                text = "<think>\n先分析段落结构。\n</think>\n" + text
            return self.send_json(200, {
                "choices": [{"message": {"role": "assistant", "content": text}, "finish_reason": finish}],
                "usage": {"prompt_tokens": len(user) // 4, "completion_tokens": len(text) // 2},
            })
        if api == "anthropic" and path == "/anthropic/v1/messages":
            if not OPEN and self.headers.get("x-api-key") != KEYS["anthropic"]:
                return self.send_json(401, {"type": "error", "error": {"type": "authentication_error", "message": "invalid x-api-key"}})
            if not body.get("max_tokens") or self.headers.get("anthropic-version") != "2023-06-01":
                return self.send_json(400, {"type": "error", "error": {"type": "invalid_request_error", "message": "max_tokens and anthropic-version are required"}})
            user = body["messages"][-1]["content"]
            text, finish = reply_for(user)
            stop = {"stop": "end_turn", "length": "max_tokens", "content_filter": "refusal"}[finish]
            return self.send_json(200, {
                "type": "message",
                "content": [{"type": "text", "text": text}] if text else [],
                "stop_reason": stop,
                "usage": {"input_tokens": 10, "output_tokens": 10},
            })
        match = re.fullmatch(r"/gemini/v1beta/models/([^/:]+):generateContent", path)
        if api == "gemini" and match:
            if not OPEN and self.headers.get("x-goog-api-key") != KEYS["gemini"]:
                return self.send_json(400, {"error": {"code": 400, "message": "API key not valid. Please pass a valid API key.", "status": "INVALID_ARGUMENT"}})
            user = body["contents"][-1]["parts"][0]["text"]
            text, finish = reply_for(user)
            if finish == "content_filter":
                return self.send_json(200, {"promptFeedback": {"blockReason": "SAFETY"}})
            reason = {"stop": "STOP", "length": "MAX_TOKENS"}[finish]
            return self.send_json(200, {
                "candidates": [{"content": {"parts": [{"text": text}], "role": "model"}, "finishReason": reason}],
                "usageMetadata": {"promptTokenCount": 10, "candidatesTokenCount": 10},
            })
        self.send_json(404, {"error": {"message": "not found"}})


def serve(port: int = 0) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


if __name__ == "__main__":
    ports = [argument for argument in sys.argv[1:] if argument.isdigit()]
    server = serve(int(ports[0]) if ports else 8765)
    print(f"mock providers on http://127.0.0.1:{server.server_address[1]}", flush=True)
    threading.Event().wait()
