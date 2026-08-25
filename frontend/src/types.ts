export interface PublicConfig {
  app_name: string
  mineru_configured: boolean
  translation_available: boolean
  default_translate: boolean
  translation_provider: 'google' | 'deepseek'
  documents_public_by_default: boolean
  r2_configured: boolean
  accepting_uploads: boolean
  max_upload_mb: number
  accepted_extensions: string[]
  api_version: string
  api_docs: string
}

export type DocumentStatus = 'queued' | 'processing' | 'retrying' | 'completed' | 'failed'

export interface DocumentSummary {
  id: string
  title: string
  original_filename: string
  display_filename: string
  source_size: number
  mime_type: string | null
  status: DocumentStatus
  stage: string
  progress: number
  failure_reason: string | null
  translate_requested: boolean
  translation_provider: 'google' | 'deepseek' | 'none'
  translated: boolean
  is_public: boolean
  mineru_model: string
  pages_processed: number | null
  pages_total: number | null
  image_count: number
  excerpt: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
  archive_status: string
  archive_error: string | null
  local_archive_status: string
  r2_mirror_status: string
  r2_mirror_error: string | null
  upload_sha256: string | null
  api_version: string
}

export interface DocumentDetail extends DocumentSummary {
  content_html: string | null
  markdown_available?: { original: boolean; translated: boolean; normalized: boolean }
}

export interface ProcessingEvent {
  id: number
  document_id: string
  stage: string
  state: 'running' | 'completed' | 'warning' | 'failed'
  level: 'info' | 'success' | 'warning' | 'error'
  progress: number
  message: string
  detail: string | null
  current: number | null
  total: number | null
  created_at: string
}

export interface ProcessingEventList {
  items: ProcessingEvent[]
  total: number
  next_after_id: number
  has_more: boolean
}

export interface DocumentList {
  items: DocumentSummary[]
  total: number
  page: number
  page_size: number
}

export interface AdminSettings {
  mineru_configured: boolean
  mineru_api_key_masked: string | null
  mineru_model: string
  deepseek_configured: boolean
  deepseek_api_key_masked: string | null
  deepseek_model: string
  translation_provider: 'google' | 'deepseek'
  r2_configured: boolean
  r2_account_id: string
  r2_access_key_id_masked: string | null
  r2_secret_access_key_masked: string | null
  r2_bucket: string
  r2_public_base_url: string
}

export interface AdminStatus {
  initialized: boolean
}
