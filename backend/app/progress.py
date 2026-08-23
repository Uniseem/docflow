from __future__ import annotations

from sqlalchemy.orm import Session

from .models import Document, ProcessingEvent


def append_processing_event(
    db: Session,
    document: Document,
    *,
    stage: str,
    progress: int,
    message: str,
    state: str = "running",
    level: str = "info",
    detail: str | None = None,
    current: int | None = None,
    total: int | None = None,
) -> ProcessingEvent:
    event = ProcessingEvent(
        document_id=document.id,
        stage=stage,
        state=state,
        level=level,
        progress=max(0, min(100, progress)),
        message=message[:4000],
        detail=detail[:8000] if detail else None,
        current=current,
        total=total,
    )
    db.add(event)
    return event
