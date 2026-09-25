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
const SEGMENT_RE = /<segment\s+id\s*=\s*["']?([^"'>\s]+)["']?\s*>([\s\S]*?)<\/segment\s*>/gi

function translateBody(text: string): string {
  if (!text.trim()) return text
  return `${text}${FAKE_MARK}`
}

// pdf2zh's prompt: the paragraph follows "Source Text: " and ends before "Translated Text:".
const PDF2ZH_SOURCE_RE = /Source Text: ([\s\S]*)\n\nTranslated Text:\s*$/

function translateUser(user: string): string {
  const pdf2zh = PDF2ZH_SOURCE_RE.exec(user)
  if (pdf2zh) return translateBody(pdf2zh[1] ?? '')
  SEGMENT_RE.lastIndex = 0
  const parts = [...user.matchAll(SEGMENT_RE)]
  if (parts.length === 0) return translateBody(user)
  return parts
    .map((match) => {
      let body = match[2] ?? ''
      if (body.startsWith('\n')) body = body.slice(1)
      if (body.endsWith('\n')) body = body.slice(0, -1)
      return `<segment id="${match[1]}">\n${translateBody(body)}\n</segment>`
    })
    .join('\n')
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
