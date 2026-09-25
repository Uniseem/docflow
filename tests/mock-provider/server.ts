import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

export const MOCK_MARK = '〔测试译文〕'
export const DEFAULT_MOCK_PORT = 38_111
const TRUNCATE_ABOVE = 3_000
const SEGMENT_RE = /<segment\s+id\s*=\s*["']?([^"'>\s]+)["']?\s*>([\s\S]*?)<\/segment\s*>/gi
const MARKER_RE = /DOCFLOWKEEP\d{6}TOKEN/g
const OPENAI_MODELS = ['mock-chat', 'mock-model', 'mock-reasoner']
/** Models each chat API accepts: everything its `/models` endpoint lists (Gemini accepts any). */
const CHAT_MODELS: Record<'openai' | 'anthropic', ReadonlySet<string>> = {
  openai: new Set(OPENAI_MODELS),
  anthropic: new Set([...OPENAI_MODELS, 'claude-mock', 'claude-mock-2']),
}

export type MockStats = {
  requests: Record<string, number>
  peak: Record<string, number>
  inFlight: Record<string, number>
  rateLimited: number
  truncated: number
  dropped: number
  damaged: number
  lostMarkers: number
  swapped: number
  refused: number
}

/** Runtime knobs, changed with `POST /config` and restored by `POST /reset`. */
export type MockConfig = {
  /** Every chat request waits this long before it is answered (0 = answer at once). */
  delayMs: number
  /** Every n-th chat request is answered with 429 (0 = never). */
  rateLimitEvery: number
}

export const DEFAULT_MOCK_CONFIG: Readonly<MockConfig> = { delayMs: 0, rateLimitEvery: 9 }

const MAX_DELAY_MS = 600_000

export class MockProviderState {
  config: MockConfig
  requests: Record<string, number> = {}
  peak: Record<string, number> = {}
  inFlight: Record<string, number> = {}
  rateLimited = 0
  truncated = 0
  dropped = 0
  damaged = 0
  lostMarkers = 0
  swapped = 0
  refused = 0

  constructor(private readonly initial: Readonly<MockConfig> = DEFAULT_MOCK_CONFIG) {
    this.config = { ...initial }
  }

  /** Clears the counters and restores the config the server was started with. */
  reset(): void {
    this.config = { ...this.initial }
    this.requests = {}
    this.peak = {}
    this.inFlight = {}
    this.rateLimited = 0
    this.truncated = 0
    this.dropped = 0
    this.damaged = 0
    this.lostMarkers = 0
    this.swapped = 0
    this.refused = 0
  }

  snapshot(): MockStats {
    return {
      requests: { ...this.requests },
      peak: { ...this.peak },
      inFlight: { ...this.inFlight },
      rateLimited: this.rateLimited,
      truncated: this.truncated,
      dropped: this.dropped,
      damaged: this.damaged,
      lostMarkers: this.lostMarkers,
      swapped: this.swapped,
      refused: this.refused,
    }
  }

  enter(api: string): number {
    this.requests[api] = (this.requests[api] ?? 0) + 1
    this.inFlight[api] = (this.inFlight[api] ?? 0) + 1
    this.peak[api] = Math.max(this.peak[api] ?? 0, this.inFlight[api])
    return this.requests[api]
  }

  leave(api: string): void {
    this.inFlight[api] = Math.max(0, (this.inFlight[api] ?? 0) - 1)
  }

  configure(patch: Partial<MockConfig>): MockConfig {
    this.config = { ...this.config, ...patch }
    return { ...this.config }
  }
}

/** Validates a `POST /config` body; unknown keys and out-of-range values are rejected. */
export function parseConfigPatch(raw: string): Partial<MockConfig> | null {
  let value: unknown
  try {
    value = JSON.parse(raw || '{}')
  } catch {
    return null
  }
  const record = asRecord(value)
  if (!record) return null
  const patch: Partial<MockConfig> = {}
  for (const [key, item] of Object.entries(record)) {
    if (key !== 'delayMs' && key !== 'rateLimitEvery') return null
    if (typeof item !== 'number' || !Number.isInteger(item) || item < 0) return null
    if (key === 'delayMs' && item > MAX_DELAY_MS) return null
    patch[key] = item
  }
  return patch
}

export type MockServer = {
  url: string
  port: number
  state: MockProviderState
  close: () => Promise<void>
}

export type MockProviderOptions = {
  open?: boolean
  host?: string
  /** Startup values for the runtime config; `POST /reset` returns to these. */
  config?: Partial<MockConfig>
}

export function listenMockProvider(
  port = 0,
  options: MockProviderOptions = {},
): Promise<MockServer> {
  const state = new MockProviderState({ ...DEFAULT_MOCK_CONFIG, ...options.config })
  const server = http.createServer((req, res) => {
    void handleRequest(req, res, state, options).catch((error: unknown) => {
      if (!res.writableEnded) {
        sendJson(res, 500, { error: { message: String(error) } })
      }
    })
  })
  const host = options.host ?? '127.0.0.1'
  return new Promise((resolveListen, reject) => {
    server.on('error', reject)
    server.listen(port, host, () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('mock provider failed to bind'))
        return
      }
      resolveListen({
        port: address.port,
        url: `http://${host}:${address.port}`,
        state,
        close: () =>
          new Promise((resolveClose, rejectClose) => {
            server.close((error) => (error ? rejectClose(error) : resolveClose()))
          }),
      })
    })
  })
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  value: unknown,
  headers: Record<string, string> = {},
): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    ...headers,
  })
  res.end(body)
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(toBuffer(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

function toBuffer(chunk: unknown): Buffer {
  if (typeof chunk === 'string') return Buffer.from(chunk)
  if (Buffer.isBuffer(chunk)) return chunk
  if (chunk instanceof Uint8Array) return Buffer.from(chunk)
  return Buffer.from(String(chunk))
}

function apiOf(path: string): 'openai' | 'anthropic' | 'gemini' {
  if (path.startsWith('/anthropic/')) return 'anthropic'
  if (path.startsWith('/gemini/')) return 'gemini'
  return 'openai'
}

function requestKey(req: http.IncomingMessage, api: string): string {
  if (api === 'anthropic') return header(req, 'x-api-key')
  if (api === 'gemini') return header(req, 'x-goog-api-key')
  // OpenAI-compatible sends `Authorization: Bearer`; Azure OpenAI sends `api-key`.
  const bearer = header(req, 'authorization').replace(/^Bearer\s+/i, '')
  return bearer || header(req, 'api-key')
}

function header(req: http.IncomingMessage, name: string): string {
  const value = req.headers[name]
  return typeof value === 'string' ? value : Array.isArray(value) ? (value[0] ?? '') : ''
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function userText(api: string, body: Record<string, unknown>): string {
  if (api === 'gemini') {
    const contents = Array.isArray(body.contents) ? body.contents : []
    const last = asRecord(contents.at(-1))
    const parts = Array.isArray(last?.parts) ? last.parts : []
    const first = asRecord(parts[0])
    return typeof first?.text === 'string' ? first.text : ''
  }
  const messages = Array.isArray(body.messages) ? body.messages : []
  const last = asRecord(messages.at(-1))
  const content = last?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const rec = asRecord(part)
        return typeof rec?.text === 'string' ? rec.text : ''
      })
      .join('')
  }
  return ''
}

function modelOf(api: string, path: string, body: Record<string, unknown>): string {
  if (api === 'gemini') {
    const match = /^\/gemini\/v1beta\/models\/([^/:]+):generateContent$/.exec(path)
    return match?.[1] ?? ''
  }
  return typeof body.model === 'string' ? body.model : ''
}

export function translateText(text: string): string {
  if (!text.trim()) return text
  return `${text}${MOCK_MARK}`
}

// pdf2zh's prompt: the paragraph follows "Source Text: " and ends before "Translated Text:".
const PDF2ZH_SOURCE_RE = /Source Text: ([\s\S]*)\n\nTranslated Text:\s*$/

function unwrapSegment(text: string): string {
  return text.replace(/^\n/, '').replace(/\n$/, '')
}

export function replyFor(
  user: string,
  state: MockProviderState,
): { text: string; finish: 'stop' | 'length' | 'content_filter' } {
  if (user.includes('REFUSE_ME')) {
    state.refused += 1
    return { text: '', finish: 'content_filter' }
  }
  SEGMENT_RE.lastIndex = 0
  const segments = [...user.matchAll(SEGMENT_RE)].map((match) => ({
    id: match[1] ?? '',
    text: unwrapSegment(match[2] ?? ''),
  }))
  let text: string
  const pdf2zh = PDF2ZH_SOURCE_RE.exec(user)
  if (pdf2zh) {
    text = applyFaults(pdf2zh[1] ?? '', state)
  } else if (segments.length > 0) {
    const parts: string[] = []
    for (const segment of segments) {
      if (segment.text.includes('DROP_ME') && segments.length > 1) {
        state.dropped += 1
        continue
      }
      parts.push(`<segment id="${segment.id}">\n${applyFaults(segment.text, state)}\n</segment>`)
    }
    text = parts.join('\n')
  } else {
    text = applyFaults(user, state)
  }
  if (user.length > TRUNCATE_ABOVE) {
    state.truncated += 1
    return { text: text.slice(0, Math.floor(text.length / 2)), finish: 'length' }
  }
  return { text, finish: 'stop' }
}

function applyFaults(source: string, state: MockProviderState): string {
  let text = translateText(source)
  const markers = text.match(MARKER_RE) ?? []
  if (source.includes('DAMAGE_MARKERS') && markers.length > 0) {
    state.damaged += 1
    text = text.replace(MARKER_RE, '`DOCFLOW KEEP 0 0 0 0 0 1 TOKEN`')
  }
  if (source.includes('LOSE_MARKERS') && markers.length > 0) {
    state.lostMarkers += 1
    const first = markers[0]
    if (first) text = text.replace(first, '')
  }
  if (source.includes('SWAP_MARKERS') && markers.length >= 2) {
    state.swapped += 1
    const first = markers[0] ?? ''
    const second = markers[1] ?? ''
    let seen = 0
    text = text.replace(MARKER_RE, (token) => {
      seen += 1
      if (seen === 1) return second
      if (seen === 2) return first
      return token
    })
  }
  return text
}

function authError(api: string): { status: number; body: unknown } {
  if (api === 'anthropic') {
    return {
      status: 401,
      body: {
        type: 'error',
        error: { type: 'authentication_error', message: 'invalid api key' },
      },
    }
  }
  if (api === 'gemini') {
    return {
      status: 401,
      body: { error: { code: 401, message: 'API key not valid', status: 'UNAUTHENTICATED' } },
    }
  }
  return {
    status: 401,
    body: { error: { message: 'Incorrect API key provided', code: 'invalid_api_key' } },
  }
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: MockProviderState,
  options: MockProviderOptions,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const path = url.pathname
  const method = req.method ?? 'GET'

  if (method === 'GET' && path === '/stats') {
    sendJson(res, 200, state.snapshot())
    return
  }
  if (method === 'POST' && path === '/reset') {
    state.reset()
    sendJson(res, 200, { ok: true })
    return
  }
  if (method === 'GET' && path === '/config') {
    sendJson(res, 200, state.config)
    return
  }
  if (method === 'POST' && path === '/config') {
    const patch = parseConfigPatch(await readBody(req))
    if (!patch) {
      sendJson(res, 400, {
        error: { message: 'expected { delayMs?, rateLimitEvery? } as non-negative integers' },
      })
      return
    }
    sendJson(res, 200, state.configure(patch))
    return
  }
  if (method === 'GET' && path === '/v1/models') {
    if (rejectKey(req, 'openai', options, res)) return
    sendJson(res, 200, {
      object: 'list',
      data: [
        { id: 'mock-chat', owned_by: 'mock' },
        { id: 'mock-model', owned_by: 'mock' },
        { id: 'mock-reasoner', owned_by: 'mock' },
      ],
    })
    return
  }
  if (method === 'GET' && path === '/anthropic/v1/models') {
    if (rejectKey(req, 'anthropic', options, res)) return
    if (url.searchParams.get('after_id') === 'claude-mock') {
      sendJson(res, 200, {
        data: [{ id: 'claude-mock-2', display_name: 'Claude Mock 2' }],
        has_more: false,
      })
      return
    }
    sendJson(res, 200, {
      data: [{ id: 'claude-mock', display_name: 'Claude Mock' }],
      has_more: true,
      last_id: 'claude-mock',
    })
    return
  }
  if (method === 'GET' && path === '/gemini/v1beta/models') {
    if (rejectKey(req, 'gemini', options, res)) return
    sendJson(res, 200, {
      models: [
        {
          name: 'models/gemini-mock',
          displayName: 'Gemini Mock',
          supportedGenerationMethods: ['generateContent', 'countTokens'],
        },
        { name: 'models/embed-mock', supportedGenerationMethods: ['embedContent'] },
      ],
    })
    return
  }

  if (method !== 'POST') {
    sendJson(res, 404, { error: { message: 'not found' } })
    return
  }

  const api = apiOf(path)
  const number = state.enter(api)
  try {
    const raw = await readBody(req)
    if (!(await pause(state.config.delayMs, res))) return
    if (rejectKey(req, api, options, res)) return
    const key = requestKey(req, api)
    if (key === 'poor-key') {
      sendJson(res, 429, { error: { message: 'insufficient balance' } }, { 'retry-after': '1' })
      return
    }
    const every = state.config.rateLimitEvery
    if (every > 0 && number % every === 0) {
      state.rateLimited += 1
      sendJson(
        res,
        429,
        { error: { message: 'Rate limit reached, please retry' } },
        { 'retry-after': '1' },
      )
      return
    }
    const body = asRecord(JSON.parse(raw || '{}') as unknown) ?? {}
    const model = modelOf(api, path, body)
    if (model === 'missing-model' || (api !== 'gemini' && model && !CHAT_MODELS[api].has(model))) {
      sendJson(res, 404, {
        error: { message: 'The model does not exist', code: 'model_not_found' },
      })
      return
    }

    if (api === 'openai' && path === '/v1/chat/completions') {
      const user = userText(api, body)
      const reply = replyFor(user, state)
      let text = reply.text
      if (model === 'mock-reasoner' && text) {
        text = `<think>\n先分析段落结构。\n</think>\n${text}`
      }
      sendJson(res, 200, {
        choices: [{ message: { role: 'assistant', content: text }, finish_reason: reply.finish }],
        usage: {
          prompt_tokens: Math.floor(user.length / 4),
          completion_tokens: Math.floor(text.length / 2),
        },
      })
      return
    }

    if (api === 'anthropic' && path === '/anthropic/v1/messages') {
      if (!body.max_tokens || header(req, 'anthropic-version') !== '2023-06-01') {
        sendJson(res, 400, {
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: 'max_tokens and anthropic-version are required',
          },
        })
        return
      }
      const user = userText(api, body)
      const reply = replyFor(user, state)
      const stop =
        reply.finish === 'length'
          ? 'max_tokens'
          : reply.finish === 'content_filter'
            ? 'refusal'
            : 'end_turn'
      sendJson(res, 200, {
        type: 'message',
        content: reply.text ? [{ type: 'text', text: reply.text }] : [],
        stop_reason: stop,
        usage: { input_tokens: 10, output_tokens: 10 },
      })
      return
    }

    if (api === 'gemini' && model) {
      const user = userText(api, body)
      const reply = replyFor(user, state)
      if (reply.finish === 'content_filter') {
        sendJson(res, 200, { promptFeedback: { blockReason: 'SAFETY' } })
        return
      }
      sendJson(res, 200, {
        candidates: [
          {
            content: { parts: [{ text: reply.text }], role: 'model' },
            finishReason: reply.finish === 'length' ? 'MAX_TOKENS' : 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10 },
      })
      return
    }

    sendJson(res, 404, { error: { message: 'not found' } })
  } finally {
    state.leave(api)
  }
}

/** Waits `ms`; resolves false when the client hung up meanwhile (nothing may be written then). */
function pause(ms: number, res: http.ServerResponse): Promise<boolean> {
  if (ms <= 0) return Promise.resolve(true)
  return new Promise((resolvePause) => {
    const onClose = () => {
      clearTimeout(timer)
      resolvePause(false)
    }
    const timer = setTimeout(() => {
      res.off('close', onClose)
      resolvePause(true)
    }, ms)
    res.once('close', onClose)
  })
}

function rejectKey(
  req: http.IncomingMessage,
  api: string,
  options: MockProviderOptions,
  res: http.ServerResponse,
): boolean {
  const key = requestKey(req, api)
  if (key === 'poor-key') {
    sendJson(res, 429, { error: { message: 'insufficient balance' } }, { 'retry-after': '1' })
    return true
  }
  if (key === 'bad-key' || (!options.open && !key)) {
    const error = authError(api)
    sendJson(res, error.status, error.body)
    return true
  }
  return false
}

export function parseCli(argv: string[]): { port: number; open: boolean; delayMs: number } {
  const open = argv.includes('--open')
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(name)
    return index >= 0 ? argv[index + 1] : undefined
  }
  const delayText = flag('--delay')
  const delayMs = delayText && /^\d+$/.test(delayText) ? Number(delayText) : 0
  const portValue = flag('--port')
  // A bare number is the port, unless it is the value of --delay.
  const bare = argv.find((arg, index) => /^\d+$/.test(arg) && argv[index - 1] !== '--delay')
  const port = portValue ? Number(portValue) : bare ? Number(bare) : DEFAULT_MOCK_PORT
  return { port, open, delayMs }
}

export async function main(argv = process.argv.slice(2)): Promise<MockServer> {
  const { port, open, delayMs } = parseCli(argv)
  const server = await listenMockProvider(port, { open, config: { delayMs } })
  process.stdout.write(`mock providers on ${server.url}\n`)
  return server
}

const invokedDirectly =
  typeof process.argv[1] === 'string' && fileURLToPath(import.meta.url) === resolve(process.argv[1])

if (invokedDirectly) {
  void main()
}
