import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { DEFAULT_SYSTEM_PROMPT, SUBMIT_ATTEMPTS } from '../../shared/constants'
import { UserError } from '../../shared/errors'
import type { ProviderConfig, TranslationRuntime } from '../../shared/types'
import { listenMockProvider, MOCK_MARK, type MockServer } from '../../../tests/mock-provider/server'
import { cacheFingerprint, TranslationCache } from './cache'
import { ProviderError } from './errors'
import { fakeFetch } from './fake'
import type { FetchFn } from './http'
import { TranslationPools } from './pool'
import { translateDocument } from './translate-document'

const runtime: TranslationRuntime = {
  llm: { chunkChars: 4000, maxSegmentsPerRequest: 8, maxRequestChars: 8000, maxOutputTokens: 0 },
  perDocumentConcurrency: 4,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
}

function provider(url: string): ProviderConfig {
  return {
    id: 'mock',
    name: 'Mock',
    type: 'openai',
    baseUrl: `${url}/v1`,
    enabled: true,
    models: [{ id: 'mock-chat' }],
    concurrency: 8,
  }
}

async function setup() {
  const server = await listenMockProvider()
  const dir = await mkdtemp(join(tmpdir(), 'df-tr-'))
  const config = provider(server.url)
  const cache = new TranslationCache(
    join(dir, 'translation-cache.json'),
    cacheFingerprint(config, 'mock-chat', runtime),
  )
  await cache.load()
  const pools = new TranslationPools(fetch, () => 'test-key')
  return { server, cache, pools, config }
}

const hooks = { delay: () => Promise.resolve(), jitterMs: () => 0 }

describe('translateDocument against mock provider', () => {
  const servers: MockServer[] = []
  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close()
  })

  test('translates normally and hits cache on the second run', async () => {
    const ctx = await setup()
    servers.push(ctx.server)
    const segments = [
      { id: 'p1', text: 'Hello, world.' },
      { id: 'p2', text: 'Second {v1}' },
    ]
    const first = await translateDocument({
      segments,
      provider: ctx.config,
      model: 'mock-chat',
      runtime,
      pools: ctx.pools,
      cache: ctx.cache,
      signal: new AbortController().signal,
      onProgress: () => undefined,
      onEvent: () => undefined,
      hooks,
    })
    expect(first.results[0]?.text).toBe(`Hello, world.${MOCK_MARK}`)
    expect(first.results[1]?.text).toContain('{v1}')
    await ctx.cache.flush()
    await fetch(`${ctx.server.url}/reset`, { method: 'POST' })
    const second = await translateDocument({
      segments,
      provider: ctx.config,
      model: 'mock-chat',
      runtime,
      pools: ctx.pools,
      cache: ctx.cache,
      signal: new AbortController().signal,
      onProgress: () => undefined,
      onEvent: () => undefined,
      hooks,
    })
    expect(second.results[0]?.text).toBe(first.results[0]?.text)
    const stats = (await (await fetch(`${ctx.server.url}/stats`)).json()) as {
      requests: Record<string, number>
    }
    expect(stats.requests.openai ?? 0).toBe(0)
  })

  test('DROP_ME falls back to per-segment and DAMAGE is repaired', async () => {
    const ctx = await setup()
    servers.push(ctx.server)
    const events: string[] = []
    const result = await translateDocument({
      segments: [
        { id: 'a', text: 'keep me' },
        { id: 'b', text: 'DROP_ME please' },
        { id: 'c', text: 'DAMAGE_MARKERS see {v1}' },
      ],
      provider: ctx.config,
      model: 'mock-chat',
      runtime: {
        ...runtime,
        llm: { ...runtime.llm, maxSegmentsPerRequest: 8, maxRequestChars: 8000 },
      },
      pools: ctx.pools,
      cache: ctx.cache,
      signal: new AbortController().signal,
      onProgress: () => undefined,
      onEvent: (event) => events.push(event.message),
      hooks,
    })
    expect(events.some((message) => message.includes('改为逐段翻译'))).toBe(true)
    expect(result.results.find((row) => row.id === 'b')?.text).toContain(MOCK_MARK)
    expect(result.results.find((row) => row.id === 'c')?.text).toContain('{v1}')
  })

  test('REFUSE keeps original; mostly_untranslated when enough chars are kept', async () => {
    const ctx = await setup()
    servers.push(ctx.server)
    await expect(
      translateDocument({
        segments: [{ id: 'r', text: 'REFUSE_ME '.repeat(50) }],
        provider: ctx.config,
        model: 'mock-chat',
        runtime,
        pools: ctx.pools,
        cache: ctx.cache,
        signal: new AbortController().signal,
        onProgress: () => undefined,
        onEvent: () => undefined,
        hooks,
      }),
    ).rejects.toBeInstanceOf(UserError)
  })

  test('abort cancels in-flight work', async () => {
    const ctx = await setup()
    servers.push(ctx.server)
    const controller = new AbortController()
    controller.abort()
    await expect(
      translateDocument({
        segments: [{ id: 'a', text: 'Hello' }],
        provider: ctx.config,
        model: 'mock-chat',
        runtime,
        pools: ctx.pools,
        cache: ctx.cache,
        signal: controller.signal,
        onProgress: () => undefined,
        onEvent: () => undefined,
        hooks,
      }),
    ).rejects.toMatchObject({ code: 'cancelled' })
  })

  test('cancelling during a retry wait ends at once, without another request', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'df-wait-'))
    const config = provider('https://unavailable.example.com')
    const cache = new TranslationCache(
      join(dir, 'c.json'),
      cacheFingerprint(config, 'mock-chat', runtime),
    )
    let requests = 0
    const pools = new TranslationPools(
      () => {
        requests += 1
        return Promise.resolve(new Response('overloaded', { status: 503 }))
      },
      () => 'test-key',
    )
    const controller = new AbortController()
    let waiting = false
    const pending = translateDocument({
      segments: [{ id: 'a', text: 'Hello' }],
      provider: config,
      model: 'mock-chat',
      runtime,
      pools,
      cache,
      signal: controller.signal,
      onProgress: () => undefined,
      onEvent: () => undefined,
      // A retry wait that would take minutes and ignores the signal.
      hooks: {
        delay: () => {
          waiting = true
          return new Promise<void>(() => undefined)
        },
        jitterMs: () => 0,
      },
    })
    await expect.poll(() => waiting).toBe(true)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    expect(requests).toBe(1)
  })

  test('fake fetch appends the test suffix without network', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'df-fake-'))
    const config = provider('http://127.0.0.1:9')
    const cache = new TranslationCache(
      join(dir, 'c.json'),
      cacheFingerprint(config, 'fake-model', runtime),
    )
    const pools = new TranslationPools(fakeFetch, () => 'test-key')
    const result = await translateDocument({
      segments: [{ id: 'a', text: 'Hello' }],
      provider: { ...config, models: [{ id: 'fake-model' }] },
      model: 'fake-model',
      runtime,
      pools,
      cache,
      signal: new AbortController().signal,
      onProgress: () => undefined,
      onEvent: () => undefined,
      hooks,
    })
    expect(result.results[0]?.text).toContain('〔测试译文〕')
  })
})

describe('submit retry ladder (injected fetch)', () => {
  async function offline(fetchFn: FetchFn) {
    const dir = await mkdtemp(join(tmpdir(), 'df-ladder-'))
    const config = provider('https://provider.example.com')
    const cache = new TranslationCache(
      join(dir, 'c.json'),
      cacheFingerprint(config, 'mock-chat', runtime),
    )
    return { config, cache, pools: new TranslationPools(fetchFn, () => 'test-key') }
  }

  function okReply(text: string): Response {
    return new Response(
      JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }

  test('a provider that stays unavailable fails the document retryably after one exhausted request', async () => {
    let requests = 0
    const ctx = await offline(() => {
      requests += 1
      return Promise.resolve(new Response('overloaded', { status: 503 }))
    })
    const events: string[] = []
    const error: unknown = await translateDocument({
      segments: [{ id: 'a', text: 'The quick brown fox jumps over the lazy dog. '.repeat(15) }],
      provider: ctx.config,
      model: 'mock-chat',
      runtime,
      pools: ctx.pools,
      cache: ctx.cache,
      signal: new AbortController().signal,
      onProgress: () => undefined,
      onEvent: (event) => events.push(event.message),
      hooks,
    }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ProviderError)
    expect(error).toMatchObject({ kind: 'transient', retryable: true })
    expect((error as ProviderError).message).toContain('多次重试后仍然失败')
    expect(requests).toBe(SUBMIT_ATTEMPTS)
    // The last failure ends the request: it must not announce another retry.
    expect(events.filter((message) => message.includes('秒后重试'))).toHaveLength(
      SUBMIT_ATTEMPTS - 1,
    )
  })

  test('an exhausted batch stops the other batches of the document', async () => {
    let slowSignal: AbortSignal | undefined
    const ctx = await offline((_url, init) => {
      const body = typeof init?.body === 'string' ? init.body : ''
      if (body.includes('slow')) {
        slowSignal = init?.signal ?? undefined
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          })
        })
      }
      return Promise.resolve(new Response('overloaded', { status: 503 }))
    })
    await expect(
      translateDocument({
        segments: [
          { id: 'a', text: 'slow paragraph' },
          { id: 'b', text: 'down paragraph' },
        ],
        provider: ctx.config,
        model: 'mock-chat',
        runtime: { ...runtime, llm: { ...runtime.llm, maxSegmentsPerRequest: 1 } },
        pools: ctx.pools,
        cache: ctx.cache,
        signal: new AbortController().signal,
        onProgress: () => undefined,
        onEvent: () => undefined,
        hooks,
      }),
    ).rejects.toMatchObject({ kind: 'transient' })
    expect(slowSignal?.aborted).toBe(true)
  })

  test('non-retryable errors skip the back-off and go straight to the ladder', async () => {
    let requests = 0
    const ctx = await offline(() => {
      requests += 1
      if (requests === 1) return Promise.resolve(new Response('too large', { status: 413 }))
      return Promise.resolve(okReply('你好'))
    })
    const delays: number[] = []
    const result = await translateDocument({
      segments: [{ id: 'a', text: 'Hello' }],
      provider: ctx.config,
      model: 'mock-chat',
      runtime,
      pools: ctx.pools,
      cache: ctx.cache,
      signal: new AbortController().signal,
      onProgress: () => undefined,
      onEvent: () => undefined,
      hooks: {
        delay: (ms) => {
          delays.push(ms)
          return Promise.resolve()
        },
        jitterMs: () => 0,
      },
    })
    expect(result.results[0]).toMatchObject({ text: '你好', kept: false })
    expect(delays).toEqual([])
    expect(requests).toBe(2)
  })
})
