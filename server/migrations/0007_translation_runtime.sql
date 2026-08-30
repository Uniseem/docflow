-- Additive only: legacy tasks receive an immutable snapshot on first use.
-- This contains runtime controls and the administrator prompt, never provider API keys.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS translation_runtime_snapshot JSONB;
