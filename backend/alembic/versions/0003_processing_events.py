"""add permanent granular processing events

Revision ID: 0003_processing_events
Revises: 0002_admin_user
"""

from alembic import op
import sqlalchemy as sa


revision = "0003_processing_events"
down_revision = "0002_admin_user"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "processing_events",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("document_id", sa.String(length=36), nullable=False),
        sa.Column("stage", sa.String(length=64), nullable=False),
        sa.Column("state", sa.String(length=24), nullable=False),
        sa.Column("level", sa.String(length=16), nullable=False),
        sa.Column("progress", sa.Integer(), nullable=False),
        sa.Column("message", sa.Text(), nullable=False),
        sa.Column("detail", sa.Text(), nullable=True),
        sa.Column("current", sa.BigInteger(), nullable=True),
        sa.Column("total", sa.BigInteger(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["document_id"], ["documents.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_processing_events_created_at"), "processing_events", ["created_at"], unique=False)
    op.create_index(op.f("ix_processing_events_document_id"), "processing_events", ["document_id"], unique=False)
    op.create_index(op.f("ix_processing_events_stage"), "processing_events", ["stage"], unique=False)

    op.execute(
        sa.text(
            """
            INSERT INTO processing_events
                (document_id, stage, state, level, progress, message, detail, current, total, created_at)
            SELECT
                id,
                stage,
                CASE
                    WHEN status = 'completed' THEN 'completed'
                    WHEN status = 'failed' THEN 'failed'
                    ELSE 'running'
                END,
                CASE WHEN status = 'failed' THEN 'error' ELSE 'info' END,
                progress,
                CASE
                    WHEN status = 'completed' THEN '历史任务已完成；详细事件记录功能启用前的步骤无法回溯'
                    WHEN status = 'failed' THEN '历史任务处理失败；详细事件记录功能启用前的步骤无法回溯'
                    ELSE '历史任务状态已迁移；从当前步骤开始记录详细事件'
                END,
                failure_reason,
                pages_processed,
                pages_total,
                updated_at
            FROM documents
            """
        )
    )


def downgrade() -> None:
    raise RuntimeError("文流采用不可删除数据策略，不提供删除处理事件表的降级操作")
