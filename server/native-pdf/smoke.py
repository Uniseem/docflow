#!/usr/bin/env python3
"""Exercise real CPU PDF layout with deterministic, local-only mock translations.

This is not a translation-quality benchmark. It verifies the pinned engine,
assets, JSONL bridge, Chinese font embedding, page geometry, dual output, and
fail-closed handling without sending any text to a cloud API. Use an empty,
disposable ASCII directory. Outputs are retained for visual inspection.
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

import pymupdf

MAX_LINE = 1_048_576
MARKERS = re.compile(r"\{\s*v\s*\d+\s*\}|<style\b[^>]*>|</style\s*>", re.IGNORECASE)


def fixture(path: Path) -> None:
    document = pymupdf.open()
    for index in range(2):
        page = document.new_page(width=595, height=842)
        page.insert_text(
            (42, 52),
            f"DocFlow Native PDF Check {index + 1}",
            fontsize=19,
            fontname="tibo",
        )
        page.insert_text(
            (42, 75),
            "CPU layout fixture - deterministic local mock translation",
            fontsize=10,
            fontname="tiro",
        )
        page.draw_line((42, 86), (552, 86), width=0.5, color=(0.3, 0.3, 0.3))
        for column in range(2):
            left = 42 + column * 263
            page.insert_text(
                (left, 115),
                f"{column + 1}. Layout and translation",
                fontsize=13,
                fontname="tibo",
            )
            for row in range(3):
                top = 135 + row * 115
                text = (
                    "This document verifies local PDF layout and shared translation callbacks. "
                    "The source page geometry, text columns and embedded diagram must remain readable. "
                    "No real translation API is used in this reproducible test."
                )
                remaining = page.insert_textbox(
                    pymupdf.Rect(left, top, left + 245, top + 100),
                    text,
                    fontsize=11,
                    fontname="tiro",
                    lineheight=1.4,
                )
                if remaining < 0:
                    raise AssertionError("fixture paragraph does not fit")
            page.insert_text(
                (left, 510), "Energy balance: E = m c^2", fontsize=11, fontname="tiit"
            )
        page.draw_rect(pymupdf.Rect(64, 552, 531, 702), color=(0.2, 0.3, 0.5), width=1)
        page.draw_line((90, 673), (505, 673), color=(0.1, 0.1, 0.1))
        page.draw_line((90, 673), (90, 575), color=(0.1, 0.1, 0.1))
        page.draw_polyline(
            [(95, 657), (180, 628), (280, 639), (385, 595), (498, 579)],
            color=(0.1, 0.35, 0.75),
            width=2,
        )
        page.insert_text(
            (95, 692), "0          1          2          3          4", fontsize=10
        )
        page.insert_text(
            (72, 724),
            "Figure 1. A vector diagram retained in both PDF variants.",
            fontsize=10,
            fontname="tiro",
        )
        page.insert_text((290, 795), str(index + 1), fontsize=10, fontname="tiro")
    document.save(str(path), garbage=4, deflate=True)
    document.close()


def scanned_fixture(path: Path) -> None:
    document = pymupdf.open()
    page = document.new_page(width=595, height=842)
    # A page-number-only text layer over a full-page raster remains a scan.
    pixel = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 8, 8), False)
    pixel.clear_with(220)
    page.insert_image(page.rect, pixmap=pixel)
    page.insert_text((280, 800), "1", fontsize=10)
    document.save(str(path))
    document.close()


def mock_translation(text: str) -> str:
    """Preserve engine markers, replace prose with size-bounded Chinese text."""

    def prose(value: str) -> str:
        if not value.strip() or not any(char.isalpha() for char in value):
            return value
        if len(value) < 65:
            return "原生翻译测试"
        sentence = "本地原生翻译测试验证页面布局、分栏、字体与段落回填。"
        return sentence * max(1, len(value) // 110)

    result = []
    cursor = 0
    for marker in MARKERS.finditer(text):
        result.extend([prose(text[cursor : marker.start()]), marker.group(0)])
        cursor = marker.end()
    result.append(prose(text[cursor:]))
    return "".join(result)


def run_case(
    runner: Path,
    assets: Path,
    source: Path,
    output: Path,
    *,
    fail_reply: bool = False,
    expect_error: str | None = None,
    timeout: int = 180,
) -> dict:
    print(f"native-smoke: starting {output.name}", flush=True)
    environment = {
        key: os.environ[key]
        for key in ("PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "LANG", "LC_ALL")
        if key in os.environ
    }
    environment.update(PYTHONUTF8="1", PYTHONUNBUFFERED="1")
    process = subprocess.Popen(
        [
            sys.executable,
            str(runner),
            "--input",
            str(source),
            "--output",
            str(output),
            "--workers",
            "4",
            "--asset-dir",
            str(assets),
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=environment,
    )
    messages: queue.Queue = queue.Queue(maxsize=128)
    tail = bytearray()

    def stdout_reader():
        try:
            while True:
                line = process.stdout.readline(MAX_LINE + 1)
                if not line:
                    break
                if len(line) > MAX_LINE:
                    raise AssertionError("engine JSONL frame exceeds limit")
                messages.put(json.loads(line))
        except (OSError, ValueError, AssertionError) as exc:
            messages.put(exc)
        finally:
            messages.put(None)

    def stderr_reader():
        while data := process.stderr.read(4096):
            tail.extend(data)
            del tail[:-16_384]

    readers = [
        threading.Thread(target=stdout_reader, daemon=True),
        threading.Thread(target=stderr_reader, daemon=True),
    ]
    for reader in readers:
        reader.start()
    deadline = time.monotonic() + timeout
    ready = None
    result = None
    error = None
    seen: set[int] = set()
    stages: set[str] = set()
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AssertionError("native PDF smoke test timed out")
            message = messages.get(timeout=remaining)
            if message is None:
                break
            if isinstance(message, BaseException):
                raise message
            kind = message["type"]
            if kind == "ready":
                assert (
                    ready is None
                    and message["engine"] == "BabelDOC"
                    and message["version"] == "0.6.4"
                )
                ready = message
                print(f"native-smoke: ready, {message['pages']} pages", flush=True)
            elif kind == "translate":
                assert ready is not None and result is None
                identifier = message["request_id"]
                assert identifier not in seen
                seen.add(identifier)
                response = (
                    {
                        "type": "error",
                        "request_id": identifier,
                        "message": "synthetic shared-pool failure",
                    }
                    if fail_reply
                    else {
                        "type": "translation",
                        "request_id": identifier,
                        "text": mock_translation(message["text"]),
                    }
                )
                try:
                    process.stdin.write(
                        (json.dumps(response, ensure_ascii=False) + "\n").encode(
                            "utf-8"
                        )
                    )
                    process.stdin.flush()
                except BrokenPipeError:
                    if not fail_reply:
                        raise
            elif kind == "progress":
                assert 0 <= message["current"] <= message["total"]
                assert 0 <= message["percent"] <= 100
                if message["stage"] not in stages:
                    print(f"native-smoke: {message['stage']}", flush=True)
                    stages.add(message["stage"])
            elif kind == "result":
                assert (
                    result is None
                    and message["mono"] == "mono.pdf"
                    and message["dual"] == "dual.pdf"
                )
                result = message
                # Match the Rust protocol: terminal result is acknowledged by
                # EOF, so the engine can join its reader before interpreter exit.
                process.stdin.close()
            elif kind == "error":
                error = message["message"]
                print(f"native-smoke: error: {error}", flush=True)
                process.stdin.close()
            else:
                raise AssertionError(f"unexpected native protocol message: {kind}")
        status = process.wait(timeout=max(1, deadline - time.monotonic()))
        if fail_reply or expect_error:
            assert status != 0 and result is None, (
                "a failed callback or invalid source must not publish a PDF"
            )
            assert (
                not (output / "mono.pdf").exists()
                and not (output / "dual.pdf").exists()
            )
            if expect_error:
                assert error and expect_error in error, (
                    f"missing actionable preflight error: {error}"
                )
                assert not seen, "preflight rejection must happen before provider calls"
        else:
            assert status == 0 and result is not None and seen, (
                f"native engine failed: {error}; {tail.decode('utf-8', 'replace')}"
            )
            assert result["pages"] == ready["pages"]
        return {
            "exit_code": status,
            "callbacks": len(seen),
            "pages": ready["pages"] if ready else None,
            "stages": sorted(stages),
            "error": error,
        }
    finally:
        if process.poll() is None:
            if os.name == "nt":
                # Windows venv launchers have a real interpreter child. Kill
                # only the process tree created by this test, not all Python.
                subprocess.run(
                    ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=10,
                    check=False,
                )
            else:
                process.kill()
        process.wait(timeout=10)
        for stream in (process.stdin, process.stdout, process.stderr):
            stream.close()
        for reader in readers:
            reader.join(timeout=1)
        if result is None and tail:
            print(tail.decode("utf-8", "replace"), file=sys.stderr, flush=True)


def verify_artifacts(source: Path, output: Path) -> None:
    with (
        pymupdf.open(str(source)) as original,
        pymupdf.open(str(output / "mono.pdf")) as mono,
        pymupdf.open(str(output / "dual.pdf")) as dual,
    ):
        assert mono.page_count == original.page_count
        assert dual.page_count == original.page_count * 2
        for index, page in enumerate(original):
            assert tuple(mono[index].rect) == tuple(page.rect)
            assert "原生" in mono[index].get_text(), (
                "Chinese font/text must survive final PDF writing"
            )
            # Both versions must still contain the vector diagram.
            assert len(mono[index].get_drawings()) >= 3
            pair = [dual[index * 2], dual[index * 2 + 1]]
            assert any(
                f"DocFlow Native PDF Check {index + 1}" in candidate.get_text()
                for candidate in pair
            )
            assert any("原生" in candidate.get_text() for candidate in pair)
            assert all(tuple(candidate.rect) == tuple(page.rect) for candidate in pair)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--asset-dir", type=Path, required=True)
    parser.add_argument("--work-dir", type=Path, required=True)
    parser.add_argument("--failure-checks", action="store_true")
    parser.add_argument(
        "--runner", type=Path, default=Path(__file__).with_name("runner.py")
    )
    parser.add_argument("--timeout", type=int, default=180)
    options = parser.parse_args()
    assets, root = options.asset_dir.resolve(), options.work_dir.resolve()
    if not str(assets).isascii() or not str(root).isascii():
        parser.error("asset and work directories must use ASCII absolute paths")
    root.mkdir(parents=True, exist_ok=False)
    source = root / "source.pdf"
    fixture(source)
    runner = options.runner.resolve()
    summary = {
        "success": run_case(
            runner, assets, source, root / "output", timeout=options.timeout
        )
    }
    verify_artifacts(source, root / "output")
    if options.failure_checks:
        summary["callback_failure"] = run_case(
            runner, assets, source, root / "callback-failure", fail_reply=True
        )
        scanned = root / "scanned.pdf"
        scanned_fixture(scanned)
        summary["scanned"] = run_case(
            runner, assets, scanned, root / "scan-rejection", expect_error="扫描"
        )
        encrypted = root / "encrypted.pdf"
        with pymupdf.open(str(source)) as document:
            document.save(
                str(encrypted),
                encryption=pymupdf.PDF_ENCRYPT_AES_256,
                owner_pw="owner-test-fixture",
                user_pw="user-test-fixture",
            )
        summary["encrypted"] = run_case(
            runner,
            assets,
            encrypted,
            root / "encryption-rejection",
            expect_error="加密",
        )
    print(
        json.dumps(
            {"work_dir": str(root), "results": summary}, ensure_ascii=False, indent=2
        )
    )


if __name__ == "__main__":
    main()
