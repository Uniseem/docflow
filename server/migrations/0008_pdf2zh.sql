-- Keep historical documents on the MinerU pipeline. The existing PDF columns
-- remain the primary output (journal PDF for MinerU, mono PDF for pdf2zh).
ALTER TABLE documents
    ADD COLUMN IF NOT EXISTS processing_mode VARCHAR(16) NOT NULL DEFAULT 'mineru',
    ADD COLUMN IF NOT EXISTS dual_pdf_path TEXT,
    ADD COLUMN IF NOT EXISTS dual_pdf_size BIGINT;

ALTER TABLE documents
    ADD CONSTRAINT ck_documents_processing_mode
    CHECK (processing_mode IN ('mineru', 'pdf2zh'));
