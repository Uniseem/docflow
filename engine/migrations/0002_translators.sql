-- Translation services: Google's free endpoint or a model of a configured
-- large-model provider. `translator` is the choice as JSON
-- ({"kind":"google"} or {"kind":"llm","provider_id":"…","model":"…"}),
-- `translator_label` its display name when the document was queued.
ALTER TABLE documents ADD COLUMN translator TEXT;
ALTER TABLE documents ADD COLUMN translator_label TEXT;
