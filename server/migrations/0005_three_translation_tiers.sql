-- Replace the former four-tier experiment with three stable provider modes.
-- Historical tier-4 tasks are preserved and mapped to the new precise tier.
ALTER TABLE documents DROP CONSTRAINT IF EXISTS ck_documents_translation_tier;

UPDATE documents
SET translation_tier = 3,
    translation_provider = 'deepseek'
WHERE translation_tier = 4;

UPDATE app_settings
SET value = '3', updated_at = NOW()
WHERE key = 'translation_tier' AND value = '4';

INSERT INTO app_settings (key, value, encrypted, updated_at)
VALUES ('deepseek_model', 'deepseek-v4-flash', FALSE, NOW())
ON CONFLICT (key) DO UPDATE
SET value = EXCLUDED.value, encrypted = FALSE, updated_at = NOW();

ALTER TABLE documents
    ADD CONSTRAINT ck_documents_translation_tier
    CHECK (translation_tier BETWEEN 1 AND 3);
