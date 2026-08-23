"""initial schema

Revision ID: 0001_initial
Revises:
"""
from alembic import op
import sqlalchemy as sa


revision = "0001_initial"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "app_settings",
        sa.Column("key", sa.String(length=128), nullable=False),
        sa.Column("value", sa.Text(), nullable=False),
        sa.Column("encrypted", sa.Boolean(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("key"),
    )
    op.create_table(
        "documents",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("title", sa.String(length=512), nullable=False),
        sa.Column("original_filename", sa.String(length=512), nullable=False),
        sa.Column("source_path", sa.String(length=1024), nullable=False),
        sa.Column("source_size", sa.Integer(), nullable=False),
        sa.Column("mime_type", sa.String(length=255), nullable=True),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("stage", sa.String(length=64), nullable=False),
        sa.Column("progress", sa.Integer(), nullable=False),
        sa.Column("failure_reason", sa.Text(), nullable=True),
        sa.Column("translate_requested", sa.Boolean(), nullable=False),
        sa.Column("translated", sa.Boolean(), nullable=False),
        sa.Column("mineru_task_id", sa.String(length=128), nullable=True),
        sa.Column("mineru_model", sa.String(length=64), nullable=False),
        sa.Column("pages_processed", sa.Integer(), nullable=True),
        sa.Column("pages_total", sa.Integer(), nullable=True),
        sa.Column("image_count", sa.Integer(), nullable=False),
        sa.Column("content_html", sa.Text(), nullable=True),
        sa.Column("excerpt", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("source_path"),
    )
    op.create_index(op.f("ix_documents_created_at"), "documents", ["created_at"], unique=False)
    op.create_index(op.f("ix_documents_status"), "documents", ["status"], unique=False)
    op.create_index(op.f("ix_documents_title"), "documents", ["title"], unique=False)


def downgrade() -> None:
    raise RuntimeError("文流采用不可删除数据策略，不提供降级删除表操作")

