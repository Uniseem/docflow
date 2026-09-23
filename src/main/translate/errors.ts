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

/**
 * `submit()` used up its attempts on a retryable error: the provider is unavailable, so the
 * document fails retryably (the scheduler tries again later) instead of the retry ladder
 * grinding through every paragraph and keeping the originals.
 */
export class RetriesExhaustedError extends ProviderError {
  constructor(last: ProviderError | undefined) {
    super('transient', `翻译请求多次重试后仍然失败：${last?.message ?? '未知错误'}`, {
      snippet: last?.snippet ?? '',
      ...(last === undefined ? {} : { cause: last }),
    })
    this.name = 'RetriesExhaustedError'
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

/**
 * Chinese message for a provider failure that ends a document. Only credential errors
 * (401/402, or a body that says so) blame the API Key; everything else keeps the server's
 * own reason and says what to try next.
 */
export function userFacingProviderError(error: ProviderError): string {
  const status = error.status === undefined ? '' : `（HTTP ${error.status}）`
  const detail = error.snippet ? `：${error.snippet}` : ''
  const blob = `${error.message} ${error.snippet}`.toLowerCase()
  if (error.kind === 'credential') {
    if (error.message.includes('API Key')) return error.message
    if (error.status === 402 || /insufficient|balance|credit|quota/.test(blob)) {
      return `账户余额不足或 API Key 已欠费${status}。请到服务商后台充值，或在设置中更换 API Key。`
    }
    return `API Key 无效或已欠费${status}。请在设置中检查密钥。`
  }
  if (error.kind === 'fatal' && /model|模型/.test(blob)) {
    return `找不到这个模型${status}${detail}。请在设置中重新选择模型。`
  }
  if (error.status === 403) {
    return `翻译服务拒绝了请求${status}${detail}。请检查代理设置、所在地区是否受这个服务支持，以及 API Key 是否有权使用这个模型。`
  }
  if (error.status === 404) {
    return `翻译服务返回错误${status}${detail}。请在设置中检查服务地址是否正确。`
  }
  if (error.kind === 'fatal') return `翻译服务返回了无法恢复的错误${status}${detail}。`
  // Network failures and summaries (retries exhausted) carry their own message.
  if (error.status === undefined) return error.message
  if (error.kind === 'rateLimited') {
    return `翻译服务返回错误${status}${detail}。请求过于频繁，请稍后重试或在设置中降低并发数。`
  }
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
    // Region blocks, proxies and model permissions also answer 403: only the body can
    // prove a bad key, otherwise the request is forbidden for good.
    kind = lower.includes('rate') && lower.includes('limit') ? 'rateLimited' : (fromBody ?? 'fatal')
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
  // A 2xx carrying an error object (some gateways): only its content says what went wrong.
  else if (status >= 200 && status < 300) kind = fromBody ?? 'transient'
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

/**
 * An `error` object inside an HTTP 200 body. Gateways that embed the real status (`code: 401`,
 * Gemini style) are classified as that status; otherwise the error text decides.
 */
export function classifyErrorObject(error: Record<string, unknown>): ProviderError {
  const embedded = [error.code, error.status].find(
    (value): value is number => typeof value === 'number' && value >= 400 && value < 600,
  )
  return classifyHttpError({ status: embedded ?? 200, body: JSON.stringify(error) })
}

/**
 * A request that never got an HTTP answer (DNS, refused connection, TLS, proxy, timeout).
 * The message is for the user; the technical reason stays in `snippet`.
 */
export function classifyNetworkError(error: unknown): ProviderError {
  const reason = snippet(networkReason(error))
  const name = error instanceof Error ? error.name : ''
  const message =
    name === 'TimeoutError' || name === 'AbortError'
      ? '翻译请求超时，请检查网络或代理设置后重试。'
      : `无法连接翻译服务${reason ? `（${reason}）` : ''}，请检查网络或代理设置，以及服务地址是否正确。`
  return new ProviderError('transient', message, { snippet: reason, cause: error })
}

/** Node's fetch hides the useful part (`ECONNREFUSED …`) in `cause`. */
function networkReason(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const cause: unknown = error.cause
  if (cause instanceof Error && cause.message) return cause.message
  return error.message
}
