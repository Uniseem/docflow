import { afterEach, describe, expect, test } from 'vitest'
import { listenMockProvider, type MockServer } from '../../../tests/mock-provider/server'
import { UserError } from '../../shared/errors'
import type { ProviderConfig } from '../../shared/types'
import { ProviderError } from './errors'
import type { FetchFn } from './http'
import { checkModel, listModels, postChat } from './providers'

function openai(url: string): ProviderConfig {
  return {
    id: 'o',
    name: 'O',
    type: 'openai',
    baseUrl: `${url}/v1`,
    enabled: true,
    models: [],
    concurrency: 1,
  }
}

describe('listModels / checkModel', () => {
  let server: MockServer | undefined
  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  test('lists openai, anthropic and gemini models', async () => {
    server = await listenMockProvider()
    const models = await listModels(openai(server.url), 'test-key', fetch)
    expect(models.map((row) => row.id)).toEqual(['mock-chat', 'mock-model', 'mock-reasoner'])

    const anthropic = await listModels(
      { ...openai(server.url), type: 'anthropic', baseUrl: `${server.url}/anthropic` },
      'test-key',
      fetch,
    )
    expect(anthropic.map((row) => row.id)).toEqual(['claude-mock', 'claude-mock-2'])

    const gemini = await listModels(
      { ...openai(server.url), type: 'gemini', baseUrl: `${server.url}/gemini` },
      'test-key',
      fetch,
    )
    expect(gemini.map((row) => row.id)).toEqual(['gemini-mock'])
  })

  test('checkModel returns ok snippet and rejects bad keys', async () => {
    server = await listenMockProvider()
    const ok = await checkModel(openai(server.url), 'test-key', 'mock-chat', fetch)
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.reply).toContain('Hello')
    const bad = await checkModel(openai(server.url), 'bad-key', 'mock-chat', fetch)
    expect(bad.ok).toBe(false)
  })
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function refused(): Promise<Response> {
  return Promise.reject(
    new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), {
        code: 'ECONNREFUSED',
      }),
    }),
  )
}

describe('postChat error mapping (injected fetch)', () => {
  const config = openai('https://api.example.com')
  const call = (fetchFn: FetchFn) =>
    postChat(
      config,
      'm',
      's',
      'u',
      undefined,
      'k',
      fetchFn,
      new AbortController().signal,
      '4.0.0',
    ).catch((error: unknown) => error)

  test('network failures become a Chinese transient error with a next step', async () => {
    const error = await call(refused)
    expect(error).toBeInstanceOf(ProviderError)
    expect(error).toMatchObject({ kind: 'transient' })
    const message = (error as ProviderError).message
    expect(message).toContain('无法连接翻译服务')
    expect(message).toContain('网络或代理')
    expect(message).not.toContain('TypeError')
    expect((error as ProviderError).snippet).toContain('ECONNREFUSED')
  })

  test('HTTP 200 error bodies are classified by their content', async () => {
    const invalidKey = await call(() =>
      Promise.resolve(
        jsonResponse({ error: { message: 'Incorrect API key provided', code: 'invalid_api_key' } }),
      ),
    )
    expect(invalidKey).toMatchObject({ kind: 'credential' })
    const embedded = await call(() =>
      Promise.resolve(
        jsonResponse({ error: { code: 401, message: 'no auth', status: 'UNAUTHENTICATED' } }),
      ),
    )
    expect(embedded).toMatchObject({ kind: 'credential' })
    const busy = await call(() =>
      Promise.resolve(jsonResponse({ error: { message: 'upstream overloaded' } })),
    )
    expect(busy).toMatchObject({ kind: 'transient' })
  })

  test('a body that is not JSON is a Chinese transient error', async () => {
    const error = await call(() => Promise.resolve(new Response('<html>502</html>')))
    expect(error).toBeInstanceOf(ProviderError)
    expect((error as ProviderError).message).not.toContain('SyntaxError')
  })
})

describe('listModels failures (injected fetch)', () => {
  const config = openai('https://api.example.com')

  test('401 says the key is wrong instead of an internal error', async () => {
    const error = await listModels(config, 'bad', () =>
      Promise.resolve(jsonResponse({ error: 'invalid api key' }, 401)),
    ).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(UserError)
    expect((error as UserError).message).toContain('API Key')
    expect((error as UserError).message).toContain('HTTP 401')
  })

  test('network failure says the service cannot be reached', async () => {
    const error = await listModels(config, 'k', refused).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(UserError)
    expect((error as UserError).message).toContain('无法连接')
  })

  test('other HTTP errors keep the status and a next step', async () => {
    const error = await listModels(config, 'k', () =>
      Promise.resolve(new Response('boom', { status: 500 })),
    ).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(UserError)
    expect((error as UserError).message).toContain('HTTP 500')
  })
})

test('checkModel does not blame the network for an error body', async () => {
  const result = await checkModel(openai('https://api.example.com'), 'k', 'm', () =>
    Promise.resolve(jsonResponse({ error: { message: 'model_not_found' } })),
  )
  expect(result.ok).toBe(false)
  if (!result.ok) {
    expect(result.message).not.toContain('无法连接')
    expect(result.message).toContain('model_not_found')
  }
})
