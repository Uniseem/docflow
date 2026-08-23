from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import BigInteger, Boolean, CheckConstraint, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Document(Base):
    __tablename__ = "documents"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    title: Mapped[str] = mapped_column(String(512), index=True)
    original_filename: Mapped[str] = mapped_column(String(512))
    source_path: Mapped[str] = mapped_column(String(1024), unique=True)
    source_size: Mapped[int] = mapped_column(Integer)
    mime_type: Mapped[str | None] = mapped_column(String(255), nullable=True)

    status: Mapped[str] = mapped_column(String(32), default="queued", index=True)
    stage: Mapped[str] = mapped_column(String(64), default="queued")
    progress: Mapped[int] = mapped_column(Integer, default=0)
    failure_reason: Mapped[str | None] = mapped_column(Text, nullable=True)

    translate_requested: Mapped[bool] = mapped_column(Boolean, default=False)
    translated: Mapped[bool] = mapped_column(Boolean, default=False)
    mineru_task_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    mineru_model: Mapped[str] = mapped_column(String(64), default="vlm")
    pages_processed: Mapped[int | None] = mapped_column(Integer, nullable=True)
    pages_total: Mapped[int | None] = mapped_column(Integer, nullable=True)
    image_count: Mapped[int] = mapped_column(Integer, default=0)

    content_html: Mapped[str | None] = mapped_column(Text, nullable=True)
    excerpt: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    events: Mapped[list["ProcessingEvent"]] = relationship(
        back_populates="document",
        order_by="ProcessingEvent.id",
    )


class ProcessingEvent(Base):
    __tablename__ = "processing_events"

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"),
        primary_key=True,
        autoincrement=True,
    )
    document_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("documents.id", ondelete="RESTRICT"),
        index=True,
    )
    stage: Mapped[str] = mapped_column(String(64), index=True)
    state: Mapped[str] = mapped_column(String(24), default="running")
    level: Mapped[str] = mapped_column(String(16), default="info")
    progress: Mapped[int] = mapped_column(Integer)
    message: Mapped[str] = mapped_column(Text)
    detail: Mapped[str | None] = mapped_column(Text, nullable=True)
    current: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    total: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)

    document: Mapped[Document] = relationship(back_populates="events")


class AppSetting(Base):
    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(String(128), primary_key=True)
    value: Mapped[str] = mapped_column(Text)
    encrypted: Mapped[bool] = mapped_column(Boolean, default=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class AdminUser(Base):
    __tablename__ = "admin_users"
    __table_args__ = (CheckConstraint("id = 1", name="ck_admin_users_singleton"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username: Mapped[str] = mapped_column(String(128), unique=True)
    password_hash: Mapped[str] = mapped_column(String(512))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
