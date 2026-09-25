export const KEY_BENCH_MS = 600_000
export const MAX_EVENTS = 5_000
export const EVENT_KEEP = 4_000
export const MAX_ATTEMPTS = 3
export const RETRY_BASE_SECONDS = 20
export const POOL_QUEUE_CAPACITY = 4_096
export const REJECTED_STREAK_LIMIT = 6
export const SUBMIT_ATTEMPTS = 8
export const RETRY_NOTICES = 12
export const RATE_LIMIT_COOLDOWN_MS = 10_000
export const REQUEST_TIMEOUT_MS = 900_000
export const LIST_MODELS_TIMEOUT_MS = 45_000
export const CHECK_MODEL_TIMEOUT_MS = 90_000
export const SNIPPET_CHARS = 400
export const TITLE_MAX = 300
export const FILENAME_STEM_MAX = 120
export const MAX_PDF_BYTES = 500 * 1024 * 1024
export const SEARCH_DEBOUNCE_MS = 250
export const DOCUMENT_CHANGED_THROTTLE_MS = 200
export const SCHEDULER_TICK_MS = 1_000
export const STOP_GRACE_MS = 5_000
export const CACHE_FLUSH_MS = 2_000
export const CACHE_FLUSH_EVERY = 20
export const MAX_PROVIDERS = 64
export const MAX_MODELS_PER_PROVIDER = 500

export const EXTRA_BODY_FORBIDDEN = [
  'model',
  'messages',
  'stream',
  'contents',
  'system',
  'systemInstruction',
] as const

/**
 * Default prompt template: pdf2zh's BaseTranslator.prompt (string.Template variables
 * $lang_in, $lang_out, $text). Stored in settings as `translation.systemPrompt`.
 */
export const DEFAULT_SYSTEM_PROMPT =
  'You are a professional, authentic machine translation engine. ' +
  'Only Output the translated text, do not include any other text.' +
  '\n\n' +
  'Translate the following markdown source text to ${lang_out}. ' +
  'Keep the formula notation {v*} unchanged. ' +
  'Output translation directly without any additional text.' +
  '\n\n' +
  'Source Text: ${text}' +
  '\n\n' +
  'Translated Text:'

/** The 4.0.0 default (a system prompt for batched requests), replaced on load. */
export const LEGACY_SYSTEM_PROMPT = `你是严谨的学术文献译者。把用户提供的内容准确、流畅地翻译成简体中文：术语统一，保留原有的段落、标题、列表、表格和换行结构；不合并、不遗漏、不解释，不添加原文没有的内容。`

export const LOCALHOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])
