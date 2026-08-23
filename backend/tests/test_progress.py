from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.api import get_document_events
from app.database import Base
from app.models import Document
from app.progress import append_processing_event


def _document() -> Document:
    return Document(
        id="00000000-0000-0000-0000-000000000001",
        title="测试文档",
        original_filename="test.pdf",
        source_path="sources/test/test.pdf",
        source_size=1024,
        status="processing",
        stage="queued",
        progress=2,
        translate_requested=True,
        translated=False,
        mineru_model="vlm",
        image_count=0,
    )


def test_processing_events_are_permanent_and_incrementally_readable() -> None:
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        document = _document()
        db.add(document)
        append_processing_event(
            db,
            document,
            stage="queued",
            progress=2,
            state="completed",
            level="success",
            message="任务已进入队列",
        )
        append_processing_event(
            db,
            document,
            stage="mineru_running",
            progress=25,
            message="MinerU 正在解析第 2 / 10 页",
            current=2,
            total=10,
        )
        db.commit()

        first_page = get_document_events(document.id, after_id=0, limit=1, db=db)
        assert first_page.total == 2
        assert first_page.has_more is True
        assert first_page.items[0].message == "任务已进入队列"

        second_page = get_document_events(
            document.id,
            after_id=first_page.next_after_id,
            limit=10,
            db=db,
        )
        assert second_page.has_more is False
        assert second_page.items[0].current == 2
        assert second_page.items[0].total == 10
