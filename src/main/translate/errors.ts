import { SNIPPET_CHARS } from '../../shared/constants'

export type ErrorKind =
  | 'transient'
  | 'rateLimited'
  | 'oversized'
  | 'output'
  | 'refused'
  | 'rejected'
  | 'credential'
  | 'fatal'

export class ProviderError extends Error {
  readonly kind: ErrorKind
  readonly status?: number
  readonly retryAfterMs?: number
  readonly snippet: string

  constructor(
    kind: ErrorKind,
    message: string,
    options: { status?: number; retryAfterMs?: number; snippet?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ProviderError'
    this.kind = kind
    this.snippet = options.snippet ?? ''
    if (options.status !== undefined) this.status = options.status
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs
  }

  get retryable(): boolean {
    return this.kind === 'transient' || this.kind === 'rateLimited'
  }
}

export function redact(text: string, keys: readonly string[]): string {
  let out = text
  for (const key of keys) {
    if (!key) continue
    out = out.split(key).join('[redacted]')
  }
  return out
}

export function snippet(text: string, limit = SNIPPET_CHARS): string {
  const trimmed = text.trim()
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}…`
}

export function userFacingProviderError(error: ProviderError): string {
  const status = error.status === undefined ? '' : `（HTTP ${error.status}）`
  const detail = error.snippet ? `：${error.snippet}` : ''
  return `翻译服务返回错误${status}${detail}`
}

export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, 300_000)
  }
  const when = Date.parse(header)
  if (Number.isNaN(when)) return undefined
  return Math.min(Math.max(0, when - now), 300_000)
}

export function classifyHttpError(input: {
  status: number
  body: string
  retryAfter?: string | null
  now?: number
}): ProviderError {
  const body = input.body
  const lower = body.toLowerCase()
  const retryAfterMs = parseRetryAfter(input.retryAfter ?? null, input.now)
  const text = snippet(body)
  const status = input.status

  const fromBody = classifyBody(lower)

  let kind: ErrorKind
  if (status === 401 || status === 402) kind = 'credential'
  else if (status === 403) {
    kind = lower.includes('rate') && lower.includes('limit') ? 'rateLimited' : 'credential'
  } else if (status === 404) kind = 'fatal'
  else if (status === 408 || status === 409 || status === 425 || isTransientStatus(status)) {
    kind = 'transient'
  } else if (status === 429) {
    kind =
      lower.includes('insufficient') || lower.includes('exceeded your current quota')
        ? 'credential'
        : 'rateLimited'
  } else if (status === 413) kind = 'oversized'
  else if (status === 400 || status === 422) kind = fromBody ?? 'rejected'
  else if (status >= 400 && status < 500) kind = 'rejected'
  else kind = 'transient'

  const statusPart = `（HTTP ${status}）`
  const detail = text ? `：${text}` : ''
  const retry = kind === 'rateLimited' ? (retryAfterMs ?? 5_000) : retryAfterMs
  return new ProviderError(kind, `翻译服务返回错误${statusPart}${detail}`, {
    status,
    snippet: text,
    ...(retry === undefined ? {} : { retryAfterMs: retry }),
  })
}

function isTransientStatus(status: number): boolean {
  return (
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    (status >= 520 && status <= 529)
  )
}

export function classifyBody(lower: string): ErrorKind | undefined {
  if (
    /context length|context_length|maximum context|too many tokens|token limit|max_tokens|input is too long|prompt is too long/.test(
      lower,
    )
  ) {
    return 'oversized'
  }
  if (/content_filter|content filter|safety|sensitive|violat|inappropriate|blocked/.test(lower)) {
    return 'refused'
  }
  if (
    /invalid api key|invalid_api_key|incorrect api key|authentication|unauthorized|api key not valid|permission denied/.test(
      lower,
    )
  ) {
    return 'credential'
  }
  if (
    /model not found|does not exist|no such model|unknown model|not supported model|model_not_found/.test(
      lower,
    )
  ) {
    return 'fatal'
  }
  if (/rate limit|rate_limit|too many requests|quota exceeded|throttl/.test(lower)) {
    return 'rateLimited'
  }
  if (lower.includes('insufficient') && /balance|quota|credit/.test(lower)) return 'credential'
  return undefined
}

export function classifyNetworkError(error: unknown): ProviderError {
  const message = error instanceof Error ? error.message : String(error)
  return new ProviderError('transient', `翻译服务返回错误：${snippet(message)}`, {
    snippet: snippet(message),
    cause: error,
  })
}
