from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from celery.utils.log import get_task_logger

from .celery_app import celery
from .config import get_settings
from .database import SessionLocal
from .models import Document
from .progress import append_processing_event
from .services.markdown import format_and_render
from .services.mineru import MinerUClient
from .services.processing import download_public_file, temporary_workdir, unpack_and_localize
from .services.translation import translate_markdown
from .settings_store import DEEPSEEK_API_KEY, DEEPSEEK_MODEL, MINERU_API_KEY, get_value


logger = get_task_logger(__name__)


def _human_bytes(value: int | None) -> str:
    if value is None:
        return "大小未知"
    if value < 1024:
        return f"{value} B"
    if value < 1024 * 1024:
        return f"{value / 1024:.1f} KB"
    return f"{value / 1024 / 1024:.1f} MB"


def record_progress(
    document_id: str,
    *,
    stage: str,
    progress: int | None,
    message: str,
    event_state: str = "running",
    level: str = "info",
    detail: str | None = None,
    current: int | None = None,
    total: int | None = None,
    **document_values: object,
) -> None:
    with SessionLocal() as db:
        document = db.get(Document, document_id)
        if document is None:
            return
        progress_value = document.progress if progress is None else max(0, min(100, progress))
        document.stage = stage
        document.progress = progress_value
        for key, value in document_values.items():
            setattr(document, key, value)
        document.updated_at = datetime.now(timezone.utc)
        append_processing_event(
            db,
            document,
            stage=stage,
            progress=progress_value,
            message=message,
            state=event_state,
            level=level,
            detail=detail,
            current=current,
            total=total,
        )
        db.commit()


def process_document(document_id: str) -> None:
    settings = get_settings()
    with SessionLocal() as db:
        document = db.get(Document, document_id)
        if document is None:
            raise RuntimeError(f"document not found: {document_id}")
        if document.status == "completed":
            return
        mineru_key = get_value(db, MINERU_API_KEY)
        if not mineru_key:
            raise RuntimeError("管理员尚未配置 MinerU API Key")
        deepseek_key = get_value(db, DEEPSEEK_API_KEY) if document.translate_requested else None
        deepseek_model = get_value(db, DEEPSEEK_MODEL, "deepseek-v4-flash") or "deepseek-v4-flash"
        source = settings.data_root / document.source_path
        mineru_model = document.mineru_model
        batch_id = document.mineru_task_id
        fallback_title = document.title
        source_size = document.source_size
        translate_requested = document.translate_requested

    record_progress(
        document_id,
        status="processing",
        stage="worker_started",
        progress=3,
        message="Worker 已领取任务，开始检查处理环境",
        event_state="completed",
        level="success",
        detail=(
            f"源文件 {_human_bytes(source_size)}；MinerU 模型 {mineru_model}；"
            f"中文翻译 {'开启' if translate_requested else '关闭'}"
        ),
        failure_reason=None,
    )
    if not source.is_file():
        raise RuntimeError("永久源文件不存在，无法继续处理")
    record_progress(
        document_id,
        stage="source_verified",
        progress=4,
        message="永久源文件存在性检查通过",
        event_state="completed",
        level="success",
        detail=f"准备读取 {source.name}，记录大小 {_human_bytes(source_size)}",
        current=source_size,
        total=source_size,
    )

    with MinerUClient(mineru_key) as mineru:
        if not batch_id:
            record_progress(
                document_id,
                stage="mineru_uploading",
                progress=5,
                message="正在向 MinerU 申请安全上传地址并提交源文件",
                detail=f"模型 {mineru_model}；启用公式识别、表格识别；文件 {_human_bytes(source_size)}",
                current=0,
                total=source_size,
            )
            batch_id = mineru.submit_local_file(source, data_id=document_id, model=mineru_model)
            record_progress(
                document_id,
                stage="mineru_uploaded",
                progress=10,
                message="源文件已上传到 MinerU，解析批次创建成功",
                event_state="completed",
                level="success",
                detail=f"批次 ID 尾号 …{batch_id[-12:]}；接下来每次轮询都会记录状态与等待时长",
                current=source_size,
                total=source_size,
                mineru_task_id=batch_id,
            )
        else:
            record_progress(
                document_id,
                stage="mineru_resuming",
                progress=None,
                message="检测到已有 MinerU 批次，跳过重复上传并恢复结果轮询",
                event_state="completed",
                level="success",
                detail=f"批次 ID 尾号 …{batch_id[-12:]}",
            )

        def mineru_progress(
            stage: str,
            percent: int,
            processed: int | None,
            total: int | None,
            poll_count: int,
            elapsed: int,
        ) -> None:
            state_messages = {
                "mineru_waiting": "MinerU 尚未返回任务详情",
                "mineru_waiting-file": "MinerU 正在接收上传文件",
                "mineru_pending": "MinerU 任务正在队列中等待",
                "mineru_running": "MinerU 正在逐页解析文档",
                "mineru_converting": "MinerU 正在生成结构化结果",
                "mineru_retrying": "查询 MinerU 状态时网络暂时异常",
                "mineru_done": "MinerU 解析完成并返回结果压缩包",
            }
            pages = (
                f"；页面 {processed or 0} / {total}"
                if isinstance(total, int) and total > 0
                else "；暂未返回总页数"
            )
            is_done = stage == "mineru_done"
            is_retry = stage == "mineru_retrying"
            record_progress(
                document_id,
                stage=stage,
                progress=percent,
                message=f"第 {poll_count} 次状态查询：{state_messages.get(stage, 'MinerU 正在处理')}" + pages,
                event_state="completed" if is_done else ("warning" if is_retry else "running"),
                level="success" if is_done else ("warning" if is_retry else "info"),
                detail=(
                    f"已等待 {elapsed} 秒；轮询间隔 {settings.mineru_poll_seconds} 秒；"
                    f"最长等待 {settings.mineru_max_wait_seconds} 秒"
                ),
                current=processed,
                total=total,
                pages_processed=processed,
                pages_total=total,
            )

        zip_url = mineru.wait_for_result(
            batch_id,
            data_id=document_id,
            poll_seconds=settings.mineru_poll_seconds,
            max_wait_seconds=settings.mineru_max_wait_seconds,
            progress=mineru_progress,
        )

    with temporary_workdir(settings.temp_root, document_id) as work_value:
        work_dir = Path(work_value)
        zip_path = work_dir / "mineru-result.zip"
        record_progress(
            document_id,
            stage="result_download_starting",
            progress=54,
            message="已创建隔离临时目录，准备下载 MinerU 结果压缩包",
            event_state="completed",
            detail="压缩包和 Markdown 只在临时目录处理，完成或失败后都会清理",
        )
        download_bucket = -1

        def download_progress(written: int, total: int | None) -> None:
            nonlocal download_bucket
            if total and total > 0:
                bucket = min(100, round(written / total * 100))
                percent = 55 + round(bucket / 100 * 5)
            else:
                bucket = written // (5 * 1024 * 1024)
                percent = 55
            if bucket == download_bucket and (total is None or written != total):
                return
            download_bucket = bucket
            total_text = _human_bytes(total) if total else "服务器未声明总大小"
            record_progress(
                document_id,
                stage="downloading_result",
                progress=percent,
                message=f"正在下载 MinerU 结果：{_human_bytes(written)} / {total_text}",
                event_state="completed" if total and written >= total else "running",
                level="success" if total and written >= total else "info",
                detail="下载过程按块写入临时文件，并持续检查 1 GB 上限",
                current=written,
                total=total,
            )

        download_public_file(
            zip_url,
            zip_path,
            max_bytes=1024 * 1024 * 1024,
            on_progress=download_progress,
        )
        record_progress(
            document_id,
            stage="result_downloaded",
            progress=60,
            message="MinerU 结果压缩包下载完成",
            event_state="completed",
            level="success",
            detail=f"临时压缩包大小 {_human_bytes(zip_path.stat().st_size)}；开始安全检查、解压和图片本地化",
            current=zip_path.stat().st_size,
            total=zip_path.stat().st_size,
        )

        def processing_event(
            phase: str,
            current: int,
            total: int | None,
            message: str,
            detail: str | None,
        ) -> None:
            if phase == "archive_inspected":
                percent = 61
            elif phase == "archive_extracting":
                percent = 61 + round(current / max(total or 1, 1) * 3)
            elif phase == "markdown_selected":
                percent = 64
            elif phase == "images_discovered":
                percent = 65
            elif phase == "image_converted":
                percent = 65 + round(current / max(total or 1, 1) * 5)
            elif phase == "remote_image_localized":
                percent = 69
            else:
                percent = 70
            record_progress(
                document_id,
                stage=phase,
                progress=percent,
                message=message,
                event_state="completed" if phase != "archive_extracting" else "running",
                level="success" if phase in {"markdown_selected", "image_converted", "images_verified"} else "info",
                detail=detail,
                current=current,
                total=total,
            )

        markdown, image_count = unpack_and_localize(
            zip_path,
            work_dir=work_dir,
            permanent_images=settings.articles_root / document_id / "images",
            public_prefix=f"/media/{document_id}/images",
            quality=settings.webp_quality,
            on_event=processing_event,
        )
        record_progress(
            document_id,
            stage="content_localized",
            progress=70,
            message="MinerU 内容读取完成，图片本地化结果已写入永久目录",
            event_state="completed",
            level="success",
            detail=f"Markdown {len(markdown):,} 个字符；本地 WebP 图片 {image_count} 张",
            current=image_count,
            total=image_count,
            image_count=image_count,
        )

        translated = False
        if deepseek_key:
            record_progress(
                document_id,
                stage="translation_preparing",
                progress=71,
                message="正在保护公式、代码、图片和链接并规划翻译分块",
                detail=f"模型 {deepseek_model}；每块最多 {settings.translation_chunk_chars:,} 个字符",
            )

            def translation_progress(
                phase: str,
                current: int,
                total: int,
                data: dict[str, int | str],
            ) -> None:
                done_ratio = current / max(total, 1)
                percent = min(92, 72 + round(done_ratio * 20))
                characters = data.get("characters")
                placeholders = data.get("placeholders")
                attempt = data.get("attempt")
                if phase == "prepared":
                    message = f"翻译分块规划完成：共 {total} 块"
                    detail = (
                        f"原文 {characters} 个字符；保护 {placeholders} 个公式、代码、图片或链接占位符；"
                        f"单块上限 {data.get('chunk_limit')} 字符"
                    )
                    state, level = "completed", "success"
                elif phase == "chunk_started":
                    message = f"开始翻译第 {current} / {total} 块"
                    detail = f"本块 {characters} 个字符；包含 {placeholders} 个受保护占位符"
                    state, level = "running", "info"
                elif phase == "chunk_attempt":
                    message = f"第 {current} / {total} 块：发起第 {attempt} 次模型调用"
                    detail = f"模型 {deepseek_model}；本块 {characters} 个字符；占位符 {placeholders} 个"
                    state, level = "running", "info"
                elif phase == "api_retry":
                    message = f"第 {current} / {total} 块：DeepSeek 暂时不可用，等待后重试"
                    detail = (
                        f"分块调用第 {attempt} 轮；API 内部第 {data.get('api_attempt')} 次；"
                        f"HTTP {data.get('http_status')}；{data.get('delay_seconds')} 秒后继续"
                    )
                    state, level = "warning", "warning"
                elif phase in {"chunk_retry", "chunk_failed"}:
                    message = (
                        f"第 {current} / {total} 块校验失败，使用严格占位符规则重试"
                        if phase == "chunk_retry"
                        else f"第 {current} / {total} 块连续两次校验失败"
                    )
                    detail = f"第 {attempt} 次结果：{data.get('error')}"
                    state, level = ("warning", "warning") if phase == "chunk_retry" else ("failed", "error")
                elif phase == "chunk_completed":
                    message = f"第 {current} / {total} 块翻译及占位符校验通过"
                    detail = (
                        f"耗时 {data.get('seconds')} 秒；本块 {characters} 个字符；"
                        f"{placeholders} 个占位符全部按原数量恢复"
                    )
                    state, level = "completed", "success"
                else:
                    message = f"全部 {total} 个翻译分块已完成并合并"
                    detail = f"已处理 {characters} 个原文字符；复核 {placeholders} 个受保护占位符"
                    state, level = "completed", "success"
                record_progress(
                    document_id,
                    stage=f"translation_{phase}",
                    progress=percent,
                    message=message,
                    event_state=state,
                    level=level,
                    detail=detail,
                    current=current,
                    total=total,
                )

            markdown = translate_markdown(
                markdown,
                api_key=deepseek_key,
                model=deepseek_model,
                chunk_chars=settings.translation_chunk_chars,
                on_progress=translation_progress,
            )
            translated = True
        elif translate_requested:
            raise RuntimeError("翻译已被选择，但 DeepSeek 配置不可用")
        else:
            record_progress(
                document_id,
                stage="translation_skipped",
                progress=92,
                message="本任务未选择中文翻译，已跳过 DeepSeek 分块处理",
                event_state="completed",
                level="success",
            )

        formatting_steps = {
            "formula_normalized": 93,
            "math_protected": 94,
            "cjk_spacing": 95,
            "markdown_formatted": 96,
            "math_restored": 97,
            "unsafe_links_removed": 97,
            "html_rendered": 98,
            "html_sanitized": 99,
            "metadata_extracted": 99,
        }

        def markdown_progress(phase: str, message: str, detail: str | None) -> None:
            record_progress(
                document_id,
                stage=phase,
                progress=formatting_steps[phase],
                message=message,
                event_state="completed",
                level="success",
                detail=detail,
            )

        record_progress(
            document_id,
            stage="formatting_started",
            progress=93,
            message="开始执行 Markdown 规范化与安全发布流水线",
            detail="依次处理公式语法、中英文间距、GFM / CommonMark 结构、HTML 渲染和白名单消毒",
        )
        article = format_and_render(
            markdown,
            fallback_title=fallback_title,
            on_event=markdown_progress,
        )

    record_progress(
        document_id,
        title=article.title,
        excerpt=article.excerpt,
        content_html=article.html,
        translated=translated,
        status="completed",
        stage="completed",
        progress=100,
        completed_at=datetime.now(timezone.utc),
        failure_reason=None,
        message="文章发布完成：HTML 与永久元数据已写入数据库",
        event_state="completed",
        level="success",
        detail=(
            f"最终标题：{article.title[:300]}；本地图片 {image_count} 张；"
            f"中文翻译 {'已完成' if translated else '未启用'}；临时 ZIP 和 Markdown 已清理"
        ),
    )


@celery.task(bind=True, max_retries=2, name="documents.process")
def process_document_task(self, document_id: str) -> str:
    try:
        process_document(document_id)
        return document_id
    except Exception as exc:
        logger.exception("document processing failed: %s", document_id)
        if self.request.retries < self.max_retries:
            next_retry = self.request.retries + 1
            delay = 20 * next_retry
            record_progress(
                document_id,
                status="processing",
                stage="retrying",
                progress=None,
                message=f"处理发生异常，{delay} 秒后执行第 {next_retry} / {self.max_retries} 次任务重试",
                event_state="warning",
                level="warning",
                detail=f"{type(exc).__name__}：{str(exc)[:1500]}",
                current=next_retry,
                total=self.max_retries,
                failure_reason=f"处理暂时失败，正在重试：{str(exc)[:500]}",
            )
            raise self.retry(exc=exc, countdown=delay)
        record_progress(
            document_id,
            status="failed",
            stage="failed",
            progress=None,
            message="所有自动重试均已用尽，任务最终失败",
            event_state="failed",
            level="error",
            detail=f"{type(exc).__name__}：{str(exc)[:2000]}",
            current=self.max_retries,
            total=self.max_retries,
            failure_reason=str(exc)[:2000],
        )
        raise
