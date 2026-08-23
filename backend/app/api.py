from __future__ import annotations

import mimetypes
import os
import re
import uuid
from pathlib import Path

import aiofiles
from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .config import get_settings
from .database import get_db
from .models import AdminUser, Document, ProcessingEvent
from .progress import append_processing_event
from .schemas import (
    AdminStatusResponse,
    AdminSettingsResponse,
    DeepSeekSettingsRequest,
    DocumentDetail,
    DocumentList,
    DocumentSummary,
    LoginRequest,
    LoginResponse,
    MinerUSettingsRequest,
    ProcessingEventList,
    ProcessingEventResponse,
    PublicConfig,
    RegisterRequest,
)
from .security import (
    create_admin_token,
    hash_admin_password,
    require_admin,
    usernames_match,
    verify_admin_password,
)
from .services.mineru import MinerUClient, MinerUError
from .services.translation import TranslationError, validate_deepseek
from .settings_store import (
    DEEPSEEK_API_KEY,
    DEEPSEEK_MODEL,
    MINERU_API_KEY,
    MINERU_MODEL,
    get_value,
    is_configured,
    mask_secret,
    set_value,
)
from .tasks import process_document_task


router = APIRouter(prefix="/api")
settings = get_settings()
ACCEPTED_EXTENSIONS = {
    ".pdf", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", ".png", ".jpg", ".jpeg", ".jp2",
    ".webp", ".gif", ".bmp", ".html", ".htm",
}


@router.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/config/public", response_model=PublicConfig)
def public_config(db: Session = Depends(get_db)) -> PublicConfig:
    mineru_ready = is_configured(db, MINERU_API_KEY)
    translation_ready = is_configured(db, DEEPSEEK_API_KEY) and bool(get_value(db, DEEPSEEK_MODEL))
    return PublicConfig(
        app_name=settings.app_name,
        mineru_configured=mineru_ready,
        translation_available=translation_ready,
        default_translate=translation_ready,
        max_upload_mb=settings.max_upload_mb,
        accepted_extensions=sorted(ACCEPTED_EXTENSIONS),
    )


def _normalized_username(value: str) -> str:
    username = value.strip()
    if len(username) < 2 or any(character in username for character in "\r\n\t\x00"):
        raise HTTPException(status_code=400, detail="管理员名称格式不正确")
    return username


@router.get("/admin/status", response_model=AdminStatusResponse)
def admin_status(db: Session = Depends(get_db)) -> AdminStatusResponse:
    return AdminStatusResponse(initialized=db.get(AdminUser, 1) is not None)


@router.post("/admin/register", response_model=LoginResponse, status_code=status.HTTP_201_CREATED)
def register_admin(payload: RegisterRequest, db: Session = Depends(get_db)) -> LoginResponse:
    if db.get(AdminUser, 1) is not None:
        raise HTTPException(status_code=409, detail="管理员已经注册，请直接登录")
    username = _normalized_username(payload.username)
    admin = AdminUser(id=1, username=username, password_hash=hash_admin_password(payload.password))
    db.add(admin)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="管理员已被其他访问者抢先注册") from exc
    return LoginResponse(token=create_admin_token(username))


@router.post("/admin/login", response_model=LoginResponse)
def admin_login(payload: LoginRequest, db: Session = Depends(get_db)) -> LoginResponse:
    admin = db.get(AdminUser, 1)
    username = _normalized_username(payload.username)
    if admin is None:
        raise HTTPException(status_code=409, detail="系统尚未注册管理员")
    username_ok = usernames_match(username, admin.username)
    password_ok = verify_admin_password(payload.password, admin.password_hash)
    if not username_ok or not password_ok:
        raise HTTPException(status_code=401, detail="管理员名称或密码错误")
    return LoginResponse(token=create_admin_token(admin.username))


def _admin_settings(db: Session) -> AdminSettingsResponse:
    mineru_key = get_value(db, MINERU_API_KEY)
    deepseek_key = get_value(db, DEEPSEEK_API_KEY)
    return AdminSettingsResponse(
        mineru_configured=bool(mineru_key),
        mineru_api_key_masked=mask_secret(mineru_key),
        mineru_model=get_value(db, MINERU_MODEL, "vlm") or "vlm",
        deepseek_configured=bool(deepseek_key),
        deepseek_api_key_masked=mask_secret(deepseek_key),
        deepseek_model=get_value(db, DEEPSEEK_MODEL, "deepseek-v4-flash") or "deepseek-v4-flash",
    )


@router.get("/admin/settings", response_model=AdminSettingsResponse, dependencies=[Depends(require_admin)])
def get_admin_settings(db: Session = Depends(get_db)) -> AdminSettingsResponse:
    return _admin_settings(db)


@router.put("/admin/settings/mineru", response_model=AdminSettingsResponse, dependencies=[Depends(require_admin)])
def update_mineru_settings(payload: MinerUSettingsRequest, db: Session = Depends(get_db)) -> AdminSettingsResponse:
    try:
        MinerUClient.validate_token(payload.api_key.strip())
    except MinerUError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    set_value(db, MINERU_API_KEY, payload.api_key.strip(), secret=True)
    set_value(db, MINERU_MODEL, payload.model)
    return _admin_settings(db)


@router.put("/admin/settings/deepseek", response_model=AdminSettingsResponse, dependencies=[Depends(require_admin)])
def update_deepseek_settings(payload: DeepSeekSettingsRequest, db: Session = Depends(get_db)) -> AdminSettingsResponse:
    try:
        validate_deepseek(payload.api_key.strip(), payload.model.strip())
    except (TranslationError, Exception) as exc:
        raise HTTPException(status_code=400, detail=f"DeepSeek 配置验证失败：{exc}") from exc
    set_value(db, DEEPSEEK_API_KEY, payload.api_key.strip(), secret=True)
    set_value(db, DEEPSEEK_MODEL, payload.model.strip())
    return _admin_settings(db)


def _clean_filename(filename: str | None) -> str:
    value = Path(filename or "document").name.replace("\x00", "")
    value = re.sub(r"[\r\n]", "", value).strip()
    return value[:500] or "document"


@router.post("/documents", response_model=DocumentSummary, status_code=status.HTTP_202_ACCEPTED)
async def create_document(
    file: UploadFile = File(...),
    translate: bool = Form(False),
    title: str | None = Form(None),
    db: Session = Depends(get_db),
) -> Document:
    if not is_configured(db, MINERU_API_KEY):
        raise HTTPException(status_code=503, detail="管理员尚未配置 MinerU API Key")
    if translate and not is_configured(db, DEEPSEEK_API_KEY):
        raise HTTPException(status_code=400, detail="当前未配置中文翻译服务")

    filename = _clean_filename(file.filename)
    extension = Path(filename).suffix.lower()
    if extension not in ACCEPTED_EXTENSIONS:
        raise HTTPException(status_code=415, detail=f"不支持 {extension or '无扩展名'} 文件")

    document_id = str(uuid.uuid4())
    source_dir = settings.sources_root / document_id
    source_dir.mkdir(parents=True, exist_ok=False)
    permanent = source_dir / filename
    partial = source_dir / f".{filename}.uploading"
    size = 0
    try:
        async with aiofiles.open(partial, "wb") as output:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > settings.max_upload_bytes:
                    raise HTTPException(status_code=413, detail=f"文件不能超过 {settings.max_upload_mb} MB")
                await output.write(chunk)
        if size == 0:
            raise HTTPException(status_code=400, detail="文件为空")
        os.replace(partial, permanent)
    except Exception:
        if partial.exists():
            partial.unlink()
        if source_dir.exists() and not any(source_dir.iterdir()):
            source_dir.rmdir()
        raise
    finally:
        await file.close()

    display_title = (title or Path(filename).stem).strip()[:512] or Path(filename).stem[:512]
    source_path = permanent.relative_to(settings.data_root).as_posix()
    document = Document(
        id=document_id,
        title=display_title,
        original_filename=filename,
        source_path=source_path,
        source_size=size,
        mime_type=file.content_type or mimetypes.guess_type(filename)[0],
        status="queued",
        stage="queued",
        progress=1,
        translate_requested=translate,
        mineru_model=get_value(db, MINERU_MODEL, "vlm") or "vlm",
    )
    db.add(document)
    append_processing_event(
        db,
        document,
        stage="source_saved",
        state="completed",
        level="success",
        progress=1,
        message=f"源文件上传完成并永久保存：{filename}",
        detail=f"文件大小 {size:,} 字节；类型 {document.mime_type or '未知'}；翻译 {'已选择' if translate else '未选择'}",
        current=size,
        total=size,
    )
    db.commit()
    db.refresh(document)
    try:
        process_document_task.delay(document_id)
        append_processing_event(
            db,
            document,
            stage="queued",
            state="completed",
            level="success",
            progress=2,
            message="后台任务已写入 Redis 队列，正在等待 Worker 领取",
            detail="网页可以关闭；队列、任务状态和后续事件均持久化保存",
        )
        document.progress = 2
        db.commit()
    except Exception as exc:
        document.status = "failed"
        document.stage = "queue_unavailable"
        document.failure_reason = f"任务队列不可用，源文件已安全保留：{exc}"
        append_processing_event(
            db,
            document,
            stage="queue_unavailable",
            state="failed",
            level="error",
            progress=document.progress,
            message="后台任务写入队列失败",
            detail=document.failure_reason,
        )
        db.commit()
    return document


@router.get("/documents", response_model=DocumentList)
def list_documents(
    page: int = Query(1, ge=1),
    page_size: int = Query(12, ge=1, le=50),
    q: str | None = Query(None, max_length=200),
    db: Session = Depends(get_db),
) -> DocumentList:
    filters = []
    if q and q.strip():
        pattern = f"%{q.strip()}%"
        filters.append(or_(Document.title.ilike(pattern), Document.original_filename.ilike(pattern)))
    total = db.scalar(select(func.count(Document.id)).where(*filters)) or 0
    items = db.scalars(
        select(Document)
        .where(*filters)
        .order_by(Document.created_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()
    return DocumentList(
        items=[DocumentSummary.model_validate(item) for item in items],
        total=total,
        page=page,
        page_size=page_size,
    )


def _document_or_404(db: Session, document_id: str) -> Document:
    document = db.get(Document, document_id)
    if document is None:
        raise HTTPException(status_code=404, detail="文档不存在")
    return document


@router.get("/documents/{document_id}", response_model=DocumentDetail)
def get_document(document_id: str, db: Session = Depends(get_db)) -> Document:
    return _document_or_404(db, document_id)


@router.get("/documents/{document_id}/events", response_model=ProcessingEventList)
def get_document_events(
    document_id: str,
    after_id: int = Query(0, ge=0),
    limit: int = Query(500, ge=1, le=1000),
    db: Session = Depends(get_db),
) -> ProcessingEventList:
    _document_or_404(db, document_id)
    total = db.scalar(
        select(func.count(ProcessingEvent.id)).where(ProcessingEvent.document_id == document_id)
    ) or 0
    events = list(
        db.scalars(
            select(ProcessingEvent)
            .where(
                ProcessingEvent.document_id == document_id,
                ProcessingEvent.id > after_id,
            )
            .order_by(ProcessingEvent.id)
            .limit(limit + 1)
        ).all()
    )
    has_more = len(events) > limit
    items = events[:limit]
    next_after_id = items[-1].id if items else after_id
    return ProcessingEventList(
        items=[ProcessingEventResponse.model_validate(item) for item in items],
        total=total,
        next_after_id=next_after_id,
        has_more=has_more,
    )


@router.get("/documents/{document_id}/download")
def download_document(document_id: str, db: Session = Depends(get_db)) -> FileResponse:
    document = _document_or_404(db, document_id)
    source = settings.data_root / document.source_path
    if not source.is_file():
        raise HTTPException(status_code=404, detail="原始文件暂不可用")
    return FileResponse(source, filename=document.original_filename, media_type=document.mime_type)
