import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { SUBMIT_ATTEMPTS } from '../../shared/constants'
import { UserError } from '../../shared/errors'
import type { AnalysisResult } from '../../shared/pdf-types'
import { defaultTranslationRuntime, type ProviderConfig } from '../../shared/types'
import { analysisOf, stackedUnit } from '../../../tests/unit/layout-units'
import { listenMockProvider, MOCK_MARK, type MockServer } from '../../../tests/mock-provider/server'
import { cacheFingerprint, TranslationCache } from './cache'
import { ProviderError } from './errors'
import { fakeFetch } from './fake'
import type { FetchFn } from './http'
import { TranslationPools } from './pool'
import { translateDocument, type TranslateOptions } from './translate-document'

const runtime = { ...defaultTranslationRuntime(), perDocumentConcurrency: 4 }

const options: TranslateOptions = {
  minTextLength: 5,
  disableRichText: false,
  fontFamily: 'auto',
  userGlossaries: [],
  autoExtractGlossary: false,
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

function doc(...texts: string[]): AnalysisResult {
  return analysisOf([stackedUnit(texts)])
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

async function offline(fetchFn: FetchFn, url = 'https://provider.example.com') {
  const dir = await mkdtemp(join(tmpdir(), 'df-offline-'))
  const config = provider(url)
  const cache = new TranslationCache(
    join(dir, 'c.json'),
    cacheFingerprint(config, 'mock-chat', runtime),
  )
  return { config, cache, pools: new TranslationPools(fetchFn, () => 'test-key') }
}

function reply(content: string): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  )
}

const hooks = { delay: () => Promise.resolve(), jitterMs: () => 0 }

describe('translateDocument against mock provider', () => {
  const servers: MockServer[] = []
  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close()
  })

  test('translates in one batch and hits the cache on the second run', async () => {
    const ctx = await setup()
    servers.push(ctx.server)
    const analysis = doc('Hello, world.', 'Second paragraph')
    const run = () =>
      translateDocument({
        analysis,
        provider: ctx.config,
        model: 'mock-chat',
        runtime,
        options,
        pools: ctx.pools,
        cache: ctx.cache,
        signal: new AbortController().signal,
        onProgress: () => undefined,
        onEvent: () => undefined,
        hooks,
      })
    const first = await run()
    expect(first.results.map((r) => r.text)).toEqual([
      `Hello, world.${MOCK_MARK}`,
      `Second paragraph${MOCK_MARK}`,
    ])
    await ctx.cache.flush()
    await fetch(`${ctx.server.url}/reset`, { method: 'POST' })
    const second = await run()
    expect(second.results).toEqual(first.results)
    const stats = (await (await fetch(`${ctx.server.url}/stats`)).json()) as {
      requests: Record<string, number>
    }
    expect(stats.requests.openai ?? 0).toBe(0)
  })

  test('a refused batch falls back per paragraph; only the refused one keeps its original', async () => {
    const ctx = await setup()
    servers.push(ctx.server)
    const outcome = await translateDocument({
      analysis: doc('REFUSE_ME please', 'Normal text here'),
      provider: ctx.config,
      model: 'mock-chat',
      runtime,
      options,
      pools: ctx.pools,
      cache: ctx.cache,
      signal: new AbortController().signal,
      onProgress: () => undefined,
      onEvent: () => undefined,
      hooks,
    })
    expect(outcome.results).toEqual([
      expect.objectContaining({ id: '0#1', text: `Normal text here${MOCK_MARK}`, kept: false }),
      { id: '0#0', text: 'REFUSE_ME please', kept: true },
    ])
    expect(outcome.keptChars).toBe(16)
  })

  test('abort cancels in-flight work', async () => {
    const ctx = await setup()
    servers.push(ctx.server)
    const controller = new AbortController()
    controller.abort()
    await expect(
      translateDocument({
        analysis: doc('Hello there'),
        provider: ctx.config,
        model: 'mock-chat',
        runtime,
        options,
        pools: ctx.pools,
        cache: ctx.cache,
        signal: controller.signal,
        onProgress: () => undefined,
        onEvent: () => undefined,
        hooks,
      }),
    ).rejects.toMatchObject({ code: 'cancelled' })
  })
})

describe('requests', () => {
  test('one user message with BabelDOC’s batch prompt; the reply loses its <think> block', async () => {
    const bodies: Array<{ messages: Array<{ role: string; content: string }> }> = []
    const ctx = await offline((_url, init) => {
      bodies.push(
        JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as (typeof bodies)[number],
      )
      return reply(
        '<think>plan</think>\n[{"id": 0, "output": "你好世界"}, {"id": 1, "output": "第二段"}]',
      )
    })
    const result = await translateDocument({
      analysis: doc('Hello world', 'Second one'),
      provider: ctx.config,
      model: 'mock-chat',
      runtime,
      options,
      pools: ctx.pools,
      cache: ctx.cache,
      signal: new AbortController().signal,
      onProgress: () => undefined,
      onEvent: () => undefined,
      hooks,
    })
    expect(bodies).toHaveLength(1)
    expect(bodies[0]!.messages).toHaveLength(1)
    expect(bodies[0]!.messages[0]!.role).toBe('user')
    expect(bodies[0]!.messages[0]!.content).toMatch(
      /^You are a professional zh-CN native translator who needs to fluently translate text into zh-CN\.\n\nFollow all rules strictly\.\n\n## Structure Rules/,
    )
    expect(result.results.map((r) => r.text)).toEqual(['你好世界', '第二段'])
  })

  test('term extraction runs first and its terms reach the batch prompt', async () => {
    const prompts: string[] = []
    const ctx = await offline((_url, init) => {
      const prompt = (
        JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
          messages: Array<{ content: string }>
        }
      ).messages[0]!.content
      prompts.push(prompt)
      if (prompt.includes('terminologist')) return reply('[{"src": "world", "tgt": "世界"}]')
      return reply('[{"id": 0, "output": "你好世界"}]')
    })
    const outcome = await translateDocument({
      analysis: doc('Hello world'),
      provider: ctx.config,
      model: 'mock-chat',
      runtime,
      options: { ...options, autoExtractGlossary: true },
      pools: ctx.pools,
      cache: ctx.cache,
      signal: new AbortController().signal,
      onProgress: () => undefined,
      onEvent: () => undefined,
      hooks,
    })
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain('| world | 世界 |')
    expect(outcome.autoGlossary?.entries).toEqual([{ source: 'world', target: '世界' }])
  })

  test('fake fetch appends the test suffix without network', async () => {
    const ctx = await offline(fakeFetch, 'http://127.0.0.1:9')
    const result = await translateDocument({
      analysis: doc('Hello there'),
      provider: { ...ctx.config, models: [{ id: 'fake-model' }] },
      model: 'fake-model',
      runtime,
      options,
      pools: ctx.pools,
      cache: ctx.cache,
      signal: new AbortController().signal,
      onProgress: () => undefined,
      onEvent: () => undefined,
      hooks,
    })
    expect(result.results[0]?.text).toContain('〔测试译文〕')
  })
})

describe('submit retry ladder (injected fetch)', () => {
  test('cancelling during a retry wait ends at once, without another request', async () => {
    let requests = 0
    const ctx = await offline(() => {
      requests += 1
      return Promise.resolve(new Response('overloaded', { status: 503 }))
    }, 'https://unavailable.example.com')
    const controller = new AbortController()
    let waiting = false
    const pending = translateDocument({
      analysis: doc('Hello there'),
      provider: ctx.config,
      model: 'mock-chat',
      runtime,
      options,
      pools: ctx.pools,
      cache: ctx.cache,
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

  test('a provider that stays unavailable fails the document retryably after one exhausted request', async () => {
    let requests = 0
    const ctx = await offline(() => {
      requests += 1
      return Promise.resolve(new Response('overloaded', { status: 503 }))
    })
    const events: string[] = []
    const error: unknown = await translateDocument({
      analysis: doc('The quick brown fox jumps over the lazy dog.'),
      provider: ctx.config,
      model: 'mock-chat',
      runtime,
      options,
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

  test('an exhausted request stops the other requests of the document', async () => {
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
    // Seven paragraphs: a batch of six (with the slow one) and a batch of one.
    const texts = [
      'slow paragraph here',
      ...Array.from({ length: 5 }, (_, i) => `Filler ${i} text`),
    ]
    await expect(
      translateDocument({
        analysis: doc(...texts, 'down paragraph'),
        provider: ctx.config,
        model: 'mock-chat',
        runtime,
        options,
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

  test('a non-retryable error falls back to one request and then keeps the paragraph', async () => {
    let requests = 0
    const ctx = await offline(() => {
      requests += 1
      return Promise.resolve(new Response('too large', { status: 413 }))
    })
    const delays: number[] = []
    const events: string[] = []
    const result = await translateDocument({
      analysis: doc('Hello there'),
      provider: ctx.config,
      model: 'mock-chat',
      runtime,
      options,
      pools: ctx.pools,
      cache: ctx.cache,
      signal: new AbortController().signal,
      onProgress: () => undefined,
      onEvent: (event) => events.push(event.message),
      hooks: {
        delay: (ms) => {
          delays.push(ms)
          return Promise.resolve()
        },
        jitterMs: () => 0,
      },
    })
    expect(result.results).toEqual([{ id: '0#0', text: 'Hello there', kept: true }])
    expect(events).toContain('第 1 页有一段翻译失败，已保留原文')
    expect(delays).toEqual([])
    // The batch and its single-paragraph fallback.
    expect(requests).toBe(2)
  })

  test('mostly untranslated text ends the document', async () => {
    const ctx = await offline(() => Promise.resolve(new Response('too large', { status: 413 })))
    await expect(
      translateDocument({
        analysis: doc('A long paragraph that will not translate. '.repeat(12)),
        provider: ctx.config,
        model: 'mock-chat',
        runtime,
        options,
        pools: ctx.pools,
        cache: ctx.cache,
        signal: new AbortController().signal,
        onProgress: () => undefined,
        onEvent: () => undefined,
        hooks,
      }),
    ).rejects.toBeInstanceOf(UserError)
  })
})
