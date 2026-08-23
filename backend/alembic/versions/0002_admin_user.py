"""add the single administrator account

Revision ID: 0002_admin_user
Revises: 0001_initial
"""
from alembic import op
import sqlalchemy as sa


revision = "0002_admin_user"
down_revision = "0001_initial"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "admin_users",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("username", sa.String(length=128), nullable=False),
        sa.Column("password_hash", sa.String(length=512), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("id = 1", name="ck_admin_users_singleton"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("username"),
    )


def downgrade() -> None:
    raise RuntimeError("文流采用不可删除数据策略，不提供删除管理员表的降级操作")
