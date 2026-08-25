use anyhow::{Context, Result};
use sqlx::PgPool;

// The Rust service originally replaced an Alembic-managed Python service. The
// first SQLx migration is intentionally additive, so these legacy base tables
// must exist before SQLx applies its own migrations. Keep this bootstrap
// idempotent: it also runs when upgrading an existing Alembic database.
const LEGACY_SCHEMA: &[&str] = &[
    r#"CREATE TABLE IF NOT EXISTS app_settings (
        key VARCHAR(128) PRIMARY KEY,
        value TEXT NOT NULL,
        encrypted BOOLEAN NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
    )"#,
    r#"CREATE TABLE IF NOT EXISTS documents (
        id VARCHAR(36) PRIMARY KEY,
        title VARCHAR(512) NOT NULL,
        original_filename VARCHAR(512) NOT NULL,
        source_path VARCHAR(1024) NOT NULL UNIQUE,
        source_size INTEGER NOT NULL,
        mime_type VARCHAR(255),
        status VARCHAR(32) NOT NULL,
        stage VARCHAR(64) NOT NULL,
        progress INTEGER NOT NULL,
        failure_reason TEXT,
        translate_requested BOOLEAN NOT NULL,
        translated BOOLEAN NOT NULL,
        mineru_task_id VARCHAR(128),
        mineru_model VARCHAR(64) NOT NULL,
        pages_processed INTEGER,
        pages_total INTEGER,
        image_count INTEGER NOT NULL,
        content_html TEXT,
        excerpt TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        completed_at TIMESTAMPTZ
    )"#,
    "CREATE INDEX IF NOT EXISTS ix_documents_created_at ON documents (created_at)",
    "CREATE INDEX IF NOT EXISTS ix_documents_status ON documents (status)",
    "CREATE INDEX IF NOT EXISTS ix_documents_title ON documents (title)",
    r#"CREATE TABLE IF NOT EXISTS admin_users (
        id INTEGER PRIMARY KEY,
        username VARCHAR(128) NOT NULL UNIQUE,
        password_hash VARCHAR(512) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        CONSTRAINT ck_admin_users_singleton CHECK (id = 1)
    )"#,
    r#"CREATE TABLE IF NOT EXISTS processing_events (
        id BIGSERIAL PRIMARY KEY,
        document_id VARCHAR(36) NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
        stage VARCHAR(64) NOT NULL,
        state VARCHAR(24) NOT NULL,
        level VARCHAR(16) NOT NULL,
        progress INTEGER NOT NULL,
        message TEXT NOT NULL,
        detail TEXT,
        current BIGINT,
        total BIGINT,
        created_at TIMESTAMPTZ NOT NULL
    )"#,
    "CREATE INDEX IF NOT EXISTS ix_processing_events_created_at ON processing_events (created_at)",
    "CREATE INDEX IF NOT EXISTS ix_processing_events_document_id ON processing_events (document_id)",
    "CREATE INDEX IF NOT EXISTS ix_processing_events_stage ON processing_events (stage)",
];

pub async fn ensure_legacy_schema(pool: &PgPool) -> Result<()> {
    let mut transaction = pool.begin().await.context("无法开始基础数据库事务")?;

    // Serialize first-start bootstrap attempts without holding a session lock
    // after this transaction completes.
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(0x444F_4346_4C4F_5701_i64)
        .execute(&mut *transaction)
        .await
        .context("无法锁定基础数据库迁移")?;

    for (index, statement) in LEGACY_SCHEMA.iter().enumerate() {
        sqlx::query(statement)
            .execute(&mut *transaction)
            .await
            .with_context(|| format!("无法执行基础数据库语句 {}", index + 1))?;
    }

    transaction
        .commit()
        .await
        .context("无法提交基础数据库结构")?;
    tracing::info!("legacy base schema verified");
    Ok(())
}
