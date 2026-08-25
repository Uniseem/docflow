-- The administrator selects one global translation quality tier. Each job
-- snapshots that tier so later setting changes cannot alter queued work.
ALTER TABLE documents
    ADD COLUMN IF NOT EXISTS translation_tier SMALLINT NOT NULL DEFAULT 1;

ALTER TABLE documents
    ADD COLUMN IF NOT EXISTS translation_guidance TEXT;

UPDATE documents
SET translation_tier = CASE
    WHEN translation_provider = 'deepseek' THEN 2
    ELSE 1
END;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'ck_documents_translation_tier'
    ) THEN
        ALTER TABLE documents
            ADD CONSTRAINT ck_documents_translation_tier
            CHECK (translation_tier BETWEEN 1 AND 4);
    END IF;
END
$$;

