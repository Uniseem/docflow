from __future__ import annotations

import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx


class MinerUError(RuntimeError):
    pass


ProgressCallback = Callable[[str, int, int | None, int | None, int, int], None]


class MinerUClient:
    base_url = "https://mineru.net/api/v4"

    def __init__(self, api_key: str, *, timeout: float = 60.0) -> None:
        self.client = httpx.Client(
            headers={"Authorization": f"Bearer {api_key}", "Accept": "application/json"},
            timeout=httpx.Timeout(timeout, connect=20.0),
            trust_env=False,
        )

    def close(self) -> None:
        self.client.close()

    def __enter__(self) -> "MinerUClient":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    @staticmethod
    def _json(response: httpx.Response) -> dict[str, Any]:
        try:
            payload = response.json()
        except ValueError as exc:
            raise MinerUError(f"MinerU 返回了非 JSON 响应（HTTP {response.status_code}）") from exc
        if response.status_code >= 400:
            message = payload.get("msg") or payload.get("message") or response.text[:300]
            raise MinerUError(f"MinerU 请求失败（HTTP {response.status_code}）：{message}")
        if payload.get("code") != 0:
            raise MinerUError(f"MinerU 请求失败：{payload.get('msg') or '未知错误'}")
        return payload

    @classmethod
    def validate_token(cls, api_key: str) -> None:
        """用只读的不存在任务查询验证鉴权，不创建解析任务。"""
        with httpx.Client(
            headers={"Authorization": f"Bearer {api_key}", "Accept": "application/json"},
            timeout=20.0,
            trust_env=False,
        ) as client:
            response = client.get(f"{cls.base_url}/extract/task/00000000-0000-0000-0000-000000000000")
        if response.status_code in (401, 403):
            raise MinerUError("MinerU API Key 无效或无权限")
        try:
            payload = response.json()
        except ValueError as exc:
            raise MinerUError("无法验证 MinerU API Key：服务返回异常") from exc
        message = str(payload.get("msg") or payload.get("message") or "")
        if any(word in message.lower() for word in ("token", "unauthorized", "forbidden")):
            raise MinerUError(f"MinerU API Key 验证失败：{message}")

    def submit_local_file(self, source: Path, *, data_id: str, model: str) -> str:
        payload = {
            "files": [{"name": source.name, "data_id": data_id}],
            "model_version": model,
            "enable_formula": True,
            "enable_table": True,
            "language": "ch",
        }
        response = self.client.post(f"{self.base_url}/file-urls/batch", json=payload)
        data = self._json(response).get("data") or {}
        batch_id = data.get("batch_id")
        upload_urls = data.get("file_urls") or data.get("files") or []
        if not batch_id or not upload_urls:
            raise MinerUError("MinerU 未返回上传地址或任务 ID")

        upload_url = upload_urls[0]
        try:
            with source.open("rb") as file_handle:
                with httpx.Client(timeout=httpx.Timeout(600.0, connect=30.0), trust_env=False) as upload_client:
                    upload_response = upload_client.put(upload_url, content=file_handle)
        except (OSError, httpx.HTTPError) as exc:
            raise MinerUError(f"上传文档到 MinerU 失败：{exc}") from exc
        if upload_response.status_code >= 300:
            raise MinerUError(f"上传文档到 MinerU 失败（HTTP {upload_response.status_code}）")
        return str(batch_id)

    def wait_for_result(
        self,
        batch_id: str,
        *,
        data_id: str,
        poll_seconds: int,
        max_wait_seconds: int,
        progress: ProgressCallback,
    ) -> str:
        started = time.monotonic()
        poll_count = 0
        deadline = time.monotonic() + max_wait_seconds
        while time.monotonic() < deadline:
            poll_count += 1
            elapsed = round(time.monotonic() - started)
            try:
                response = self.client.get(f"{self.base_url}/extract-results/batch/{batch_id}")
                data = self._json(response).get("data") or {}
            except httpx.HTTPError:
                progress("mineru_retrying", 15, None, None, poll_count, elapsed)
                time.sleep(poll_seconds)
                continue

            raw_results = data.get("extract_result") or data.get("extract_results") or []
            results = raw_results if isinstance(raw_results, list) else [raw_results]
            result = next((item for item in results if str(item.get("data_id", "")) == data_id), None)
            if result is None and results:
                result = results[0]
            if not result:
                progress("mineru_waiting", 12, None, None, poll_count, elapsed)
                time.sleep(poll_seconds)
                continue

            state = str(result.get("state") or "pending")
            if state == "done":
                zip_url = result.get("full_zip_url")
                if not zip_url:
                    raise MinerUError("MinerU 任务完成但未返回结果压缩包")
                progress("mineru_done", 52, None, None, poll_count, elapsed)
                return str(zip_url)
            if state == "failed":
                raise MinerUError(f"MinerU 解析失败：{result.get('err_msg') or '未知错误'}")

            extract_progress = result.get("extract_progress") or {}
            processed = extract_progress.get("extracted_pages")
            total = extract_progress.get("total_pages")
            if isinstance(processed, int) and isinstance(total, int) and total > 0:
                percent = 15 + min(35, round(processed / total * 35))
            else:
                percent = {"waiting-file": 10, "pending": 13, "converting": 16, "running": 25}.get(state, 15)
            progress(f"mineru_{state}", percent, processed, total, poll_count, elapsed)
            time.sleep(poll_seconds)

        raise MinerUError("等待 MinerU 解析超时，请稍后重试")
