from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class LoginRequest(BaseModel):
    username: str = Field(min_length=2, max_length=128)
    password: str = Field(min_length=1, max_length=512)


class RegisterRequest(BaseModel):
    username: str = Field(min_length=2, max_length=128)
    password: str = Field(min_length=10, max_length=512)


class AdminStatusResponse(BaseModel):
    initialized: bool


class LoginResponse(BaseModel):
    token: str


class PublicConfig(BaseModel):
    app_name: str
    mineru_configured: bool
    translation_available: bool
    default_translate: bool
    max_upload_mb: int
    accepted_extensions: list[str]


class MinerUSettingsRequest(BaseModel):
    api_key: str = Field(min_length=8, max_length=4096)
    model: str = Field(default="vlm", pattern="^(vlm|pipeline)$")


class DeepSeekSettingsRequest(BaseModel):
    api_key: str = Field(min_length=8, max_length=4096)
    model: str = Field(default="deepseek-v4-flash", min_length=1, max_length=128)


class AdminSettingsResponse(BaseModel):
    mineru_configured: bool
    mineru_api_key_masked: str | None
    mineru_model: str
    deepseek_configured: bool
    deepseek_api_key_masked: str | None
    deepseek_model: str


class DocumentSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    title: str
    original_filename: str
    source_size: int
    mime_type: str | None
    status: str
    stage: str
    progress: int
    failure_reason: str | None
    translate_requested: bool
    translated: bool
    mineru_model: str
    pages_processed: int | None
    pages_total: int | None
    image_count: int
    excerpt: str | None
    created_at: datetime
    updated_at: datetime
    completed_at: datetime | None


class DocumentDetail(DocumentSummary):
    content_html: str | None


class ProcessingEventResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    document_id: str
    stage: str
    state: str
    level: str
    progress: int
    message: str
    detail: str | None
    current: int | None
    total: int | None
    created_at: datetime


class ProcessingEventList(BaseModel):
    items: list[ProcessingEventResponse]
    total: int
    next_after_id: int
    has_more: bool


class DocumentList(BaseModel):
    items: list[DocumentSummary]
    total: int
    page: int
    page_size: int
