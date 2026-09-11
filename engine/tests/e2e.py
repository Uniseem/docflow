#!/usr/bin/env python3
"""End-to-end check of docflow-engine over its stdio JSON-RPC protocol.

Default: local fake translations (DOCFLOW_FAKE_PROVIDERS=1) and a synthetic
MinerU result, so no API keys or network access are needed.

--mock: real HTTP against local stand-ins for the OpenAI-compatible,
Anthropic and Gemini APIs (tests/mock_providers.py). The stand-ins
rate-limit, truncate, drop segments, damage placeholders and refuse on
purpose, so the engine's repair paths are exercised.

The native PDF route runs the real BabelDOC runtime when --resources points at
a built runtime and --pdf names a text-layer PDF.

    python engine/tests/e2e.py --engine engine/target/debug/docflow-engine.exe \
        --resources runtime/build/windows-x64/resources --work-dir D:/tmp/docflow-e2e [--mock]
"""

from __future__ import annotations

import argparse
import io
import json
import os
import queue
import subprocess
import sys
import threading
import time
import urllib.request
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mock_providers  # noqa: E402

MARKDOWN = r"""# Concurrent Translation of Scientific Documents

## 1 Introduction

Long academic documents require structure-preserving parsing, image
localization and concurrent translation. The throughput is
$T=\sum_{i=1}^{n} c_i / p_i$, where $c_i$ is the chunk size.

$$
\mathcal{L}=\frac{1}{N}\sum_{i=1}^{N}\left\|y_i-\hat{y}_i\right\|_2^2+\lambda\Omega(\theta)
$$

![](images/figure.png)

Figure 1. Throughput of the shared pools.

<table><tr><th>Method</th><th colspan="2">Result</th></tr><tr><td rowspan="2">Serial</td><td>$O(n)$</td><td>slow</td></tr><tr><td>$O(1)$</td><td>fast</td></tr></table>

## 2 Conclusion

- Sources are archived locally.
- Formulas such as $E = mc^2$ survive translation.
"""


def stress_markdown() -> str:
    long_paragraph = " ".join(
        f"Sentence {index} explains how the pipeline keeps $x_{{{index}}}$ intact while long paragraphs are split and translated."
        for index in range(70)
    )
    short = [f"Short paragraph {index} about batching requests." for index in range(40)]
    short.insert(20, "A paragraph that the stand-in leaves out of batched replies: DROP_ME and see whether it is retried alone.")
    many_short = "\n\n".join(short)
    return f"""# Stress Test Document

## 1 Long paragraph

{long_paragraph}

## 2 Batches

{many_short}

## 3 Damaged placeholders

DAMAGE_MARKERS: the energy $E = mc^2$ and the [project page](https://example.com/docflow) must survive.

LOSE_MARKERS: the loss $\\mathcal{{L}}(\\theta)$ and `inline code` must not be lost when placeholders vanish.

## 4 Refusal

This first sentence is harmless and should be translated normally. The next sentence carries REFUSE_ME, which the stand-in refuses every time. The last sentence is harmless again and should be translated as well, after the refused part is isolated.

## 5 Structure

```python
def keep(x):
    return x  # code stays untouched
```

| Method | Result |
| --- | --- |
| Serial | slow |
| Parallel | fast |

Footnote reference[^1] and a bare URL https://example.org/paper survive.

[^1]: The footnote text is translated too.
"""


def png_bytes() -> bytes:
    """A small valid PNG without third-party packages."""
    import struct
    import zlib

    width, height = 64, 32
    raw = b"".join(
        b"\x00" + b"".join(bytes((x * 4 % 256, y * 8 % 256, 200)) for x in range(width))
        for y in range(height)
    )

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


def mineru_zip(path: Path, markdown: str) -> None:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("paper/full.md", markdown)
        archive.writestr("paper/images/figure.png", png_bytes())
    path.write_bytes(buffer.getvalue())


class RpcFailure(RuntimeError):
    def __init__(self, method: str, error: dict):
        super().__init__(f"{method}: {error}")
        self.error = error


class Engine:
    def __init__(self, engine: Path, data: Path, resources: Path | None, env: dict[str, str]):
        args = [str(engine), "--data-dir", str(data)]
        if resources:
            args += ["--resources", str(resources)]
        self.process = subprocess.Popen(
            args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env
        )
        self.responses: dict[int, dict] = {}
        self.notifications: queue.Queue = queue.Queue()
        self.lock = threading.Condition()
        self.next_id = 1
        threading.Thread(target=self._read, daemon=True).start()
        threading.Thread(target=lambda: self.process.stderr.read(), daemon=True).start()

    def _read(self) -> None:
        for line in self.process.stdout:
            message = json.loads(line)
            if "id" in message and message["id"] is not None:
                with self.lock:
                    self.responses[message["id"]] = message
                    self.lock.notify_all()
            else:
                self.notifications.put(message)

    def call(self, method: str, params=None, timeout: float = 60):
        request_id = self.next_id
        self.next_id += 1
        line = json.dumps({"id": request_id, "method": method, "params": params or {}}, ensure_ascii=False)
        self.process.stdin.write((line + "\n").encode("utf-8"))
        self.process.stdin.flush()
        deadline = time.monotonic() + timeout
        with self.lock:
            while request_id not in self.responses:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError(method)
                self.lock.wait(remaining)
            response = self.responses.pop(request_id)
        if "error" in response:
            raise RpcFailure(method, response["error"])
        return response["result"]

    def close(self) -> None:
        try:
            self.process.stdin.close()
            self.process.wait(timeout=15)
        except Exception:
            self.process.kill()


def wait_for(engine: Engine, document_id: str, timeout: float) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        view = engine.call("documents.get", {"id": document_id})
        if view["status"] in {"completed", "failed", "cancelled"}:
            return view
        time.sleep(1)
    raise TimeoutError(f"document {document_id} did not finish")


def all_events(engine: Engine, document_id: str) -> list[dict]:
    events, after = [], 0
    while True:
        page = engine.call("documents.events", {"id": document_id, "after_id": after})
        events += page["items"]
        after = page["next_after_id"]
        if not page["has_more"]:
            return events


class Checks:
    def __init__(self) -> None:
        self.failures: list[str] = []

    def expect(self, condition: bool, label: str) -> None:
        print(("  ok   " if condition else "  FAIL ") + label)
        if not condition:
            self.failures.append(label)


def provider(id_: str, name: str, kind: str, base_url: str, models: list[str], concurrency: int = 100) -> dict:
    return {
        "id": id_,
        "name": name,
        "type": kind,
        "base_url": base_url,
        "models": [{"id": model} for model in models],
        "concurrency": concurrency,
    }


def check_document(engine: Engine, checks: Checks, label: str, view: dict, work: Path, mock: bool) -> None:
    files = view["files"]
    print(f"{label}: {view['status']} ({view['progress']}%) [{view.get('translator_label')}] {view.get('failure_reason') or ''}")
    checks.expect(view["status"] == "completed", f"{label} completed")
    if view["status"] != "completed":
        return
    native = view["processing_mode"] == "pdf2zh"
    for key in (["mono_pdf", "dual_pdf"] if native else ["journal_pdf", "markdown", "reader_html", "markdown_translated"]):
        checks.expect(bool(files.get(key)), f"{label} has {key}")
    events = all_events(engine, view["id"])
    bundle = work / f"{view['id']}-bundle.zip"
    engine.call("documents.exportBundle", {"id": view["id"], "destination": str(bundle)})
    with zipfile.ZipFile(bundle) as archive:
        names = archive.namelist()
    print(f"  bundle {len(names)} files, {len(events)} events")
    if native or not files.get("markdown_translated"):
        return
    text = Path(files["markdown_translated"]).read_text(encoding="utf-8")
    for leak in ("DOCFLOWKEEP", "<segment", "</segment>", "<think>"):
        checks.expect(leak not in text, f"{label} output has no {leak}")
    if not mock:
        checks.expect("$E = mc^2$" in text, f"{label} keeps inline math")
        return
    checks.expect(mock_providers.MARK in text, f"{label} output is translated")
    for kept in ("$E = mc^2$", "$x_{69}$", "[project page](https://example.com/docflow)", "$\\mathcal{L}(\\theta)$",
                 "`inline code`", "return x  # code stays untouched", "https://example.org/paper", "[^1]"):
        checks.expect(kept in text, f"{label} keeps {kept}")
    for index in (0, 35, 69):
        checks.expect(f"Sentence {index} explains" in text, f"{label} keeps sentence {index} of the long paragraph")
    checks.expect("split and translated." + mock_providers.MARK in text.split("## 2")[0], f"{label} translated the long paragraph to its end")
    checks.expect(text.count("Short paragraph") == 40, f"{label} keeps all 40 short paragraphs")
    checks.expect(text.count("about batching requests." + mock_providers.MARK) == 40, f"{label} translated each short paragraph")
    checks.expect("DROP_ME and see whether it is retried alone." + mock_providers.MARK in text, f"{label} retried the dropped segment")
    checks.expect("| --- | --- |" in text and f"| Serial{mock_providers.MARK} | slow{mock_providers.MARK} |" in text,
                  f"{label} translated the pipe table cell by cell")
    checks.expect("# Stress Test Document" + mock_providers.MARK in text, f"{label} translated the title")
    kept_source =[event for event in events if "保留原文" in event["message"] or "保留了原文" in event["message"]]
    checks.expect(bool(kept_source), f"{label} reports the refused fragment kept as source")
    checks.expect("REFUSE_ME" in text, f"{label} keeps the refused fragment")
    checks.expect("The last sentence is harmless again" in text and "translated as well, after the refused part is isolated." + mock_providers.MARK in text,
                  f"{label} still translates around the refused fragment")


def expect_no_google(engine: Engine, checks: Checks, source: Path) -> None:
    """Google Translate is gone: the choice is refused before anything is queued."""
    try:
        engine.call("documents.create", {"path": str(source), "mode": "mineru", "translator": {"kind": "google"}})
        checks.expect(False, "Google Translate is refused")
    except RpcFailure as error:
        checks.expect(error.error.get("code") == "invalid_params", f"Google Translate is refused ({error.error.get('message', '')[:60]})")
    try:
        engine.call("google.check")
        checks.expect(False, "google.check no longer exists")
    except RpcFailure:
        checks.expect(True, "google.check no longer exists")


def run_fake(engine: Engine, checks: Checks, options, work: Path, caps: dict) -> None:
    source = work / "测试论文.docx"
    source.write_bytes(b"placeholder document; the MinerU result is synthetic")
    checks.expect(not caps["llm_ready"], "no model is ready before a provider is added")
    engine.call("providers.save", {"provider": provider("fake-llm", "测试模型", "openai", "https://llm.invalid/v1", ["fake"])})
    expect_no_google(engine, checks, source)
    documents = [
        ("mineru+llm", engine.call("documents.create", {"path": str(source), "mode": "mineru", "translator": {"kind": "llm", "provider_id": "fake-llm", "model": "fake"}})),
    ]
    if options.pdf and caps["pdf2zh_ready"]:
        documents.append(("pdf2zh+llm", engine.call("documents.create", {
            "path": str(options.pdf.resolve()), "mode": "pdf2zh",
            "translator": {"kind": "llm", "provider_id": "fake-llm", "model": "fake"},
        })))
    for label, created in documents:
        check_document(engine, checks, label, wait_for(engine, created["id"], options.timeout), work, mock=False)


def run_mock(engine: Engine, checks: Checks, options, work: Path, caps: dict, base: str) -> None:
    source = work / "压力测试.docx"
    source.write_bytes(b"placeholder document; the MinerU result is synthetic")
    expect_no_google(engine, checks, source)

    print("model lists")
    listed = engine.call("providers.models", {"type": "openai", "base_url": f"{base}/v1/", "api_key": "test-key"})
    checks.expect([model["id"] for model in listed["models"]] == ["mock-model", "mock-reasoner"], "OpenAI-compatible model list")
    listed = engine.call("providers.models", {"type": "anthropic", "base_url": f"{base}/anthropic", "api_key": "claude-key"})
    checks.expect([model["id"] for model in listed["models"]] == ["claude-mock", "claude-mock-2"], "Anthropic model list with pagination")
    listed = engine.call("providers.models", {"type": "gemini", "base_url": f"{base}/gemini", "api_key": "gemini-key"})
    checks.expect([model["id"] for model in listed["models"]] == ["gemini-mock"], "Gemini model list filtered to generateContent")
    try:
        engine.call("providers.models", {"type": "openai", "base_url": f"{base}/v1", "api_key": "wrong-key"})
        checks.expect(False, "wrong key is reported when listing models")
    except RpcFailure as error:
        checks.expect("API Key" in error.error["message"], f"wrong key is reported when listing models ({error.error['message'][:60]})")
    try:
        engine.call("providers.models", {"type": "openai", "base_url": f"{base}/nowhere", "api_key": "test-key"})
        checks.expect(False, "missing model list endpoint is reported")
    except RpcFailure as error:
        checks.expect("手动添加" in error.error["message"], "missing model list endpoint suggests adding models by hand")

    print("providers")
    engine.call("providers.save", {"provider": provider("mock-openai", "模拟 OpenAI", "openai", f"{base}/v1", ["mock-model", "mock-reasoner"])})
    engine.call("providers.save", {"provider": provider("mock-claude", "模拟 Claude", "anthropic", f"{base}/anthropic", ["claude-mock"], concurrency=2)})
    engine.call("providers.save", {"provider": provider("mock-gemini", "模拟 Gemini", "gemini", f"{base}/gemini", ["gemini-mock"])})
    engine.call("providers.save", {"provider": provider("mock-badkey", "错误密钥", "openai", f"{base}/v1", ["mock-model"])})
    engine.call("providers.save", {"provider": provider("mock-multikey", "多个密钥", "openai", f"{base}/v1", ["mock-model"])})
    for name, value in [("provider:mock-openai", "test-key"), ("provider:mock-claude", "claude-key"),
                        ("provider:mock-gemini", "gemini-key"), ("provider:mock-badkey", "wrong-key"),
                        ("provider:mock-multikey", "sk-revoked-0000000000001, test-key")]:
        view = engine.call("secrets.set", {"name": name, "value": value})
    checks.expect(view["capabilities"]["llm_ready"], "llm_ready after keys are set")
    view = engine.call("providers.save", {
        "provider": provider("mock-gemini", "模拟 Gemini", "gemini", f"{base}/gemini", ["gemini-mock"]),
        "extra_body_json": '{"generationConfig": {"temperature": 0.2}}',
    })
    gemini = next(item for item in view["providers"] if item["id"] == "mock-gemini")
    checks.expect(gemini.get("extra_body") == {"generationConfig": {"temperature": 0.2}} and '"generationConfig"' in gemini["extra_body_json"],
                  "extra parameters sent as JSON text keep their key spelling")
    try:
        engine.call("providers.save", {"provider": provider("Upper", "大写", "openai", f"{base}/v1", [])})
        checks.expect(False, "provider ids must be lower case")
    except RpcFailure:
        checks.expect(True, "provider ids must be lower case")
    masked = {item["id"]: item["key_masked"] for item in view["providers"]}
    checks.expect(all(value and "-key" not in value for value in masked.values()), f"keys are masked ({masked['mock-openai']})")
    result = engine.call("providers.check", {"provider_id": "mock-gemini", "type": "gemini", "base_url": f"{base}/gemini", "model": "gemini-mock"})
    checks.expect(result["ok"], "saved provider check uses the stored key")
    try:
        engine.call("providers.check", {"provider_id": "mock-badkey", "type": "openai", "base_url": f"{base}/v1", "model": "mock-model"})
        checks.expect(False, "provider check reports a wrong key")
    except RpcFailure as error:
        checks.expect("API Key" in error.error["message"], "provider check reports a wrong key")

    def llm(provider_id: str, model: str) -> dict:
        return {"kind": "llm", "provider_id": provider_id, "model": model}

    jobs = [
        ("openai", llm("mock-openai", "mock-reasoner")),
        ("anthropic", llm("mock-claude", "claude-mock")),
        ("gemini", llm("mock-gemini", "gemini-mock")),
    ]
    created = [(label, engine.call("documents.create", {"path": str(source), "mode": "mineru", "translator": translator}))
               for label, translator in jobs]
    bad = engine.call("documents.create", {"path": str(source), "mode": "mineru", "translator": llm("mock-badkey", "mock-model")})
    multikey = engine.call("documents.create", {"path": str(source), "mode": "mineru", "translator": llm("mock-multikey", "mock-model")})
    try:
        engine.call("documents.create", {"path": str(source), "mode": "mineru", "translator": llm("mock-openai", "not-listed")})
        checks.expect(False, "unknown model is rejected")
    except RpcFailure:
        checks.expect(True, "unknown model is rejected")

    for label, document in created:
        check_document(engine, checks, f"mineru+{label}", wait_for(engine, document["id"], options.timeout), work, mock=True)
    view = wait_for(engine, bad["id"], options.timeout)
    print(f"bad key: {view['status']} {view.get('failure_reason')}")
    checks.expect(view["status"] == "failed" and "API Key" in (view.get("failure_reason") or ""), "wrong key stops the document with a clear reason")
    view = wait_for(engine, multikey["id"], options.timeout)
    benched = [event for event in all_events(engine, multikey["id"]) if "暂停使用" in (event.get("detail") or "")]
    print(f"one revoked key of two: {view['status']}; {benched[0]['detail'][:90] if benched else 'no bench event'}")
    checks.expect(view["status"] == "completed" and bool(benched), "a revoked key is set aside and the other key finishes the document")

    if options.pdf and caps["pdf2zh_ready"]:
        native = engine.call("documents.create", {"path": str(options.pdf.resolve()), "mode": "pdf2zh", "translator": llm("mock-openai", "mock-model")})
        check_document(engine, checks, "pdf2zh+openai", wait_for(engine, native["id"], options.timeout), work, mock=True)

    with urllib.request.urlopen(f"{base}/stats") as response:
        stats = json.load(response)
    print("stand-in stats:", json.dumps(stats, ensure_ascii=False))
    for key in ("rate_limited", "truncated", "dropped", "damaged", "lost_markers", "refused"):
        checks.expect(stats.get(key, 0) > 0, f"stand-ins exercised {key}")
    checks.expect(stats["peak"].get("anthropic", 0) <= 2, f"Anthropic stayed within its concurrency of 2 (peak {stats['peak'].get('anthropic')})")
    checks.expect(stats["peak"].get("openai", 0) > 2, f"OpenAI-compatible requests ran concurrently (peak {stats['peak'].get('openai')})")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--engine", type=Path, required=True)
    parser.add_argument("--resources", type=Path)
    parser.add_argument("--work-dir", type=Path, required=True)
    parser.add_argument("--pdf", type=Path, help="text-layer PDF for the native route")
    parser.add_argument("--mock", action="store_true", help="use local HTTP stand-ins instead of fake translations")
    parser.add_argument("--timeout", type=float, default=900)
    options = parser.parse_args()

    work = options.work_dir.resolve()
    work.mkdir(parents=True, exist_ok=False)
    fixture = work / "mineru-result.zip"
    mineru_zip(fixture, stress_markdown() if options.mock else MARKDOWN)

    env = dict(os.environ, DOCFLOW_FAKE_MINERU_ZIP=str(fixture))
    env.pop("DOCFLOW_FAKE_PROVIDERS", None)
    server = None
    if options.mock:
        server = mock_providers.serve()
        base = f"http://127.0.0.1:{server.server_address[1]}"
        env["NO_PROXY"] = "127.0.0.1,localhost"
    else:
        env["DOCFLOW_FAKE_PROVIDERS"] = "1"

    engine = Engine(options.engine.resolve(), work / "data", options.resources, env)
    checks = Checks()
    try:
        init = engine.call("engine.initialize", {"secrets": {}})
        caps = init["settings"]["capabilities"]
        print("engine", init["version"], "protocol", init["protocol"], "pdf2zh_ready", caps["pdf2zh_ready"], caps["pdf2zh_issue"] or "")
        checks.expect(init["protocol"] == 3, "protocol 3")
        settings = init["settings"]
        checks.expect("google" not in settings["translation_runtime"] and "google_ready" not in caps,
                      "no Google Translate settings or capability")
        checks.expect(settings["preferences"]["default_translator"] is None, "no default model before one is chosen")
        if options.mock:
            run_mock(engine, checks, options, work, caps, base)
        else:
            run_fake(engine, checks, options, work, caps)
        listed = engine.call("documents.list", {"filter": "completed"})
        print("completed documents:", listed["total"], listed["counts"])
    finally:
        engine.close()
        if server:
            server.shutdown()
    if checks.failures:
        print("FAILED:", checks.failures)
        return 1
    print("OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
