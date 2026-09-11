-- Desktop library. Timestamps are UTC RFC 3339 text ("2026-01-02T03:04:05.678Z")
-- so that SQL-side and Rust-side values compare lexicographically.

CREATE TABLE documents (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL,
    title_custom INTEGER NOT NULL DEFAULT 0,
    original_filename TEXT NOT NULL,
    storage_key TEXT NOT NULL UNIQUE,
    -- Relative to the data directory; physical names are ASCII only.
    source_path TEXT NOT NULL,
    source_size INTEGER NOT NULL,
    source_sha256 TEXT NOT NULL,
    mime_type TEXT,
    processing_mode TEXT NOT NULL CHECK (processing_mode IN ('mineru', 'pdf2zh')),
    translation_tier INTEGER NOT NULL CHECK (translation_tier BETWEEN 1 AND 3),
    -- Runtime controls and prompt captured when the job was queued. Never keys.
    translation_runtime_snapshot TEXT,
    mineru_model TEXT NOT NULL DEFAULT 'vlm',
    mineru_task_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'retrying', 'completed', 'failed', 'cancelled')),
    stage TEXT NOT NULL,
    progress INTEGER NOT NULL DEFAULT 0,
    failure_reason TEXT,
    queue_attempts INTEGER NOT NULL DEFAULT 0,
    queue_available_at TEXT NOT NULL,
    pages_processed INTEGER,
    pages_total INTEGER,
    image_count INTEGER NOT NULL DEFAULT 0,
    excerpt TEXT,
    translated INTEGER NOT NULL DEFAULT 0,
    -- Relative to the data directory once the permanent archive is complete.
    archive_path TEXT,
    pdf_path TEXT,
    pdf_size INTEGER,
    dual_pdf_path TEXT,
    dual_pdf_size INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT
);

CREATE INDEX ix_documents_queue ON documents (status, queue_available_at, created_at);
CREATE INDEX ix_documents_created ON documents (created_at);

CREATE TABLE processing_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id TEXT NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
    stage TEXT NOT NULL,
    state TEXT NOT NULL,
    level TEXT NOT NULL,
    progress INTEGER NOT NULL,
    message TEXT NOT NULL,
    detail TEXT,
    current INTEGER,
    total INTEGER,
    created_at TEXT NOT NULL
);

CREATE INDEX ix_processing_events_document ON processing_events (document_id, id);

-- Non-secret preferences only. API keys live in the OS keychain of the host app.
CREATE TABLE app_settings (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
