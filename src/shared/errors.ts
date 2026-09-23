export const ERROR_CODES = {
  pdf_encrypted: 'pdf_encrypted',
  pdf_invalid: 'pdf_invalid',
  pdf_empty: 'pdf_empty',
  pdf_too_long: 'pdf_too_long',
  pdf_open: 'pdf_open',
  page_geometry: 'page_geometry',
  scanned_pdf: 'scanned_pdf',
  no_paragraphs: 'no_paragraphs',
  font_embed_failed: 'font_embed_failed',
  inspect_timeout: 'inspect_timeout',
  analyze_timeout: 'analyze_timeout',
  compose_timeout: 'compose_timeout',
  verify_timeout: 'verify_timeout',
  verify_failed: 'verify_failed',
  worker_crashed: 'worker_crashed',
  mostly_untranslated: 'mostly_untranslated',
  cancelled: 'cancelled',
  keychain_unavailable: 'keychain_unavailable',
  models_unsupported: 'models_unsupported',
  models_failed: 'models_failed',
  not_found: 'not_found',
  internal: 'internal',
} as const

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]

const PERMANENT = new Set<string>([
  ERROR_CODES.pdf_encrypted,
  ERROR_CODES.pdf_invalid,
  ERROR_CODES.pdf_empty,
  ERROR_CODES.pdf_too_long,
  ERROR_CODES.pdf_open,
  ERROR_CODES.page_geometry,
  ERROR_CODES.scanned_pdf,
  ERROR_CODES.no_paragraphs,
  ERROR_CODES.font_embed_failed,
  ERROR_CODES.mostly_untranslated,
  ERROR_CODES.keychain_unavailable,
  ERROR_CODES.models_unsupported,
  ERROR_CODES.not_found,
])

const INTERNAL_MESSAGE = '发生内部错误，详情见日志'

export const ERROR_MESSAGES: Record<string, string> = {
  pdf_encrypted: '这个 PDF 已加密，请先用其他工具去除密码再翻译。',
  pdf_invalid: '文件不是有效的 PDF。',
  pdf_empty: 'PDF 没有页面。',
  pdf_too_long: 'PDF 超过 600 页，请拆分后再翻译。',
  pdf_open: '无法打开这个 PDF。',
  page_geometry: 'PDF 页面尺寸异常，无法处理。',
  scanned_pdf: '这个 PDF 没有可见的文本层（可能是扫描件），DocFlow 不支持 OCR。',
  no_paragraphs: '没有识别到可翻译的段落。',
  font_embed_failed: '内置中文字体无法使用，请重新安装 DocFlow。',
  inspect_timeout: '处理超时，稍后自动重试。',
  analyze_timeout: '处理超时，稍后自动重试。',
  compose_timeout: '处理超时，稍后自动重试。',
  verify_timeout: '处理超时，稍后自动重试。',
  verify_failed: '生成的 PDF 未通过校验，稍后自动重试。',
  worker_crashed: '处理进程意外退出，稍后自动重试。',
  mostly_untranslated: '有部分内容无法翻译，已停止处理。请换一个翻译服务或模型后重新处理。',
  cancelled: '已取消处理',
  keychain_unavailable: '这台电脑的系统钥匙串不可用，无法安全保存 API Key。',
  models_unsupported: '服务商不支持获取模型列表，请手动添加模型 ID。',
  models_failed: '获取模型列表失败，请检查服务地址、API Key 与网络后重试。',
  not_found: '找不到这个文档。',
  internal: INTERNAL_MESSAGE,
}

export function isPermanentCode(code: string): boolean {
  return PERMANENT.has(code)
}

export function messageForCode(code: string, fallback?: string): string {
  return ERROR_MESSAGES[code] ?? fallback ?? INTERNAL_MESSAGE
}

export class UserError extends Error {
  readonly user = true as const
  readonly code: string
  readonly permanent: boolean

  constructor(code: string, message?: string, permanent = isPermanentCode(code)) {
    super(message ?? messageForCode(code))
    this.name = 'UserError'
    this.code = code
    this.permanent = permanent
  }
}

export class PermanentError extends UserError {
  constructor(code: string, message?: string) {
    super(code, message, true)
    this.name = 'PermanentError'
  }
}

export class CancelledError extends UserError {
  constructor() {
    super(ERROR_CODES.cancelled, ERROR_MESSAGES.cancelled, true)
    this.name = 'CancelledError'
  }
}

export function isUserError(error: unknown): error is UserError {
  return error instanceof UserError
}
