import type { ProviderConfig } from '../../shared/types'
import type { FetchFn } from './http'

export function fakeProvider(): ProviderConfig {
  return {
    id: 'fake',
    name: '假服务商',
    type: 'openai',
    baseUrl: 'http://127.0.0.1:9',
    enabled: true,
    models: [{ id: 'fake-model', name: '假模型' }],
    concurrency: 100,
  }
}

export const FAKE_MARK = '〔测试译文〕'

function translateBody(text: string): string {
  if (!text.trim()) return text
  return `${text}${FAKE_MARK}`
}

const BATCH_MARKER = '## Here is the input:\n\n'
const SINGLE_MARKER = 'Now translate the following text:\n\n'
const TERMS_MARKER = 'Input Text:\n```\n'

/** Answers BabelDOC's prompts: a JSON batch, one paragraph, or term extraction (none). */
function translateUser(user: string): string {
  const batch = user.indexOf(BATCH_MARKER)
  if (batch >= 0) {
    const items = JSON.parse(user.slice(batch + BATCH_MARKER.length)) as Array<{
      id: number
      input: string
    }>
    return JSON.stringify(items.map((item) => ({ id: item.id, output: translateBody(item.input) })))
  }
  const single = user.indexOf(SINGLE_MARKER)
  if (single >= 0) return translateBody(user.slice(single + SINGLE_MARKER.length))
  if (user.includes(TERMS_MARKER)) return '[]'
  return translateBody(user)
}

function userFromBody(body: unknown): string {
  if (typeof body !== 'object' || body === null) return ''
  const rec = body as Record<string, unknown>
  if (Array.isArray(rec.messages)) {
    const last = rec.messages.at(-1) as Record<string, unknown> | undefined
    return typeof last?.content === 'string' ? last.content : ''
  }
  if (Array.isArray(rec.contents)) {
    const last = rec.contents.at(-1) as Record<string, unknown> | undefined
    const parts = Array.isArray(last?.parts) ? last.parts : []
    const first = parts[0] as Record<string, unknown> | undefined
    return typeof first?.text === 'string' ? first.text : ''
  }
  return ''
}

export const fakeFetch: FetchFn = (input, init) => {
  const url = String(input)
  if (url.includes('/models') && (init?.method ?? 'GET') === 'GET') {
    return Promise.resolve(
      json({
        data: [{ id: 'fake-model' }],
        models: [
          {
            name: 'models/fake-model',
            supportedGenerationMethods: ['generateContent'],
          },
        ],
      }),
    )
  }
  const raw = typeof init?.body === 'string' ? init.body : ''
  let parsed: unknown
  try {
    parsed = raw ? JSON.parse(raw) : {}
  } catch {
    parsed = {}
  }
  const text = translateUser(userFromBody(parsed))
  return Promise.resolve(
    json({
      choices: [{ message: { content: text }, finish_reason: 'stop' }],
      content: [{ type: 'text', text }],
      candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
    }),
  )
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}
