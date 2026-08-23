-- Additive migration only: the existing Alembic-managed data remains intact.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS markdown_original TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS markdown_translated TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS markdown_normalized TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS upload_sha256 VARCHAR(64);
ALTER TABLE documents ADD COLUMN IF NOT EXISTS queue_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS queue_available_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE documents ADD COLUMN IF NOT EXISTS queue_locked_at TIMESTAMPTZ;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS queue_locked_by VARCHAR(128);
ALTER TABLE documents ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS archive_status VARCHAR(32) NOT NULL DEFAULT 'not_archived';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS archive_error TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS archive_manifest JSONB;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS r2_prefix VARCHAR(1024);
ALTER TABLE documents ADD COLUMN IF NOT EXISTS source_r2_key VARCHAR(1024);
ALTER TABLE documents ADD COLUMN IF NOT EXISTS article_r2_key VARCHAR(1024);
ALTER TABLE documents ADD COLUMN IF NOT EXISTS mineru_r2_key VARCHAR(1024);
ALTER TABLE documents ADD COLUMN IF NOT EXISTS api_version VARCHAR(16) NOT NULL DEFAULT 'v1';

CREATE INDEX IF NOT EXISTS ix_documents_queue_claim
    ON documents (status, queue_available_at, created_at);
CREATE INDEX IF NOT EXISTS ix_documents_archive_status
    ON documents (archive_status);

-- Existing Python jobs used source paths below /data/sources. New jobs use isolated
-- /data/work directories and are archived to R2 before local cleanup.
UPDATE documents
SET archive_status = CASE
    WHEN status = 'completed' THEN 'legacy_local'
    ELSE 'not_archived'
END
WHERE archive_status = 'not_archived' AND api_version = 'v1';

