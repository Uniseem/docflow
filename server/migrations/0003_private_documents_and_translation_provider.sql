-- Documents are private unless an administrator explicitly publishes them.
-- New uploads receive a per-document capability token stored only as a SHA-256 hash.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS access_token_hash VARCHAR(64);
ALTER TABLE documents ADD COLUMN IF NOT EXISTS translation_provider VARCHAR(16) NOT NULL DEFAULT 'google';

-- Existing translated documents were produced by the previous DeepSeek-only pipeline.
UPDATE documents
SET translation_provider = CASE
    WHEN translate_requested OR translated THEN 'deepseek'
    ELSE 'none'
END;

-- Applying this migration intentionally makes all historical documents private.
UPDATE documents SET is_public = FALSE;

CREATE INDEX IF NOT EXISTS ix_documents_public_created
    ON documents (is_public, created_at DESC);

