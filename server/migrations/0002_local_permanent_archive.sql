-- Local storage is the canonical permanent archive. Human-facing names live in
-- PostgreSQL and are never used as physical paths.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS display_filename VARCHAR(512);
ALTER TABLE documents ADD COLUMN IF NOT EXISTS storage_key VARCHAR(64);
ALTER TABLE documents ADD COLUMN IF NOT EXISTS title_custom BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS local_archive_status VARCHAR(32) NOT NULL DEFAULT 'pending';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS local_archive_path VARCHAR(1024);
ALTER TABLE documents ADD COLUMN IF NOT EXISTS r2_mirror_status VARCHAR(32) NOT NULL DEFAULT 'disabled';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS r2_mirror_error TEXT;

UPDATE documents
SET display_filename = original_filename
WHERE display_filename IS NULL OR btrim(display_filename) = '';

UPDATE documents
SET storage_key = replace(id, '-', '')
WHERE storage_key IS NULL OR btrim(storage_key) = '';

UPDATE documents
SET local_archive_status = CASE
        WHEN status = 'completed' AND api_version = 'v1' THEN 'legacy_local'
        WHEN status = 'completed' AND archive_status LIKE 'archived%' THEN 'legacy_r2'
        ELSE local_archive_status
    END,
    local_archive_path = CASE
        WHEN api_version = 'v1' THEN 'articles/' || id
        ELSE local_archive_path
    END,
    r2_mirror_status = CASE
        WHEN r2_prefix IS NOT NULL THEN 'archived'
        ELSE 'disabled'
    END;

ALTER TABLE documents ALTER COLUMN display_filename SET NOT NULL;
ALTER TABLE documents ALTER COLUMN storage_key SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_documents_storage_key ON documents (storage_key);
CREATE INDEX IF NOT EXISTS ix_documents_local_archive_status ON documents (local_archive_status);
CREATE INDEX IF NOT EXISTS ix_documents_r2_mirror_status ON documents (r2_mirror_status);
