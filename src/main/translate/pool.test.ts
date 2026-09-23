import { describe, expect, test } from 'vitest'
import type { ProviderConfig } from '../../shared/types'
import type { FetchFn } from './http'
import { FakeClock, KeyRing } from './keys'
import { ProviderPool, TranslationPools } from './pool'

const baseProvider: ProviderConfig = {
  id: 'p',
  name: 'P',
  type: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  enabled: true,
  models: [{ id: 'm' }],
  concurrency: 3,
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function okReply(text = '译'): Response {
  return jsonResponse({
    choices: [{ message: { content: text }, finish_reason: 'stop' }],
  })
}

const request = { model: 'm', system: 's', user: 'u' }

function hangFetchParts(): {
  fetch: FetchFn
  waitFor: (n: number) => Promise<void>
  release: () => void
} {
  const waiters: Array<(value: Response) => void> = []
  const listeners: Array<() => void> = []
  let seen = 0
  let held = true
  const notify = () => {
    for (const listener of listeners.splice(0)) listener()
  }
  return {
    fetch: () =>
      new Promise<Response>((resolve) => {
        seen += 1
        notify()
        if (!held) {
          resolve(okReply())
          return
        }
        waiters.push(resolve)
      }),
    waitFor: async (n: number) => {
      while (seen < n) {
        await new Promise<void>((resolve) => {
          listeners.push(resolve)
        })
      }
    },
    release: () => {
      held = false
      for (const resolve of waiters) resolve(okReply())
      waiters.length = 0
    },
  }
}

describe('ProviderPool', () => {
  test('caps in-flight work at current concurrency', async () => {
    const hanging = hangFetchParts()
    const pool = new ProviderPool(baseProvider, new KeyRing('k-abcdefghijkl'), hanging.fetch)
    const jobs = Array.from({ length: 8 }, () =>
      pool.execute(request, new AbortController().signal),
    )
    await hanging.waitFor(3)
    expect(pool.stats()).toMatchObject({ inFlight: 3, waiting: 5, current: 3 })
    hanging.release()
    await Promise.all(jobs)
    expect(pool.stats().inFlight).toBe(0)
  })

  test('rate-limit halves once per 10s then recovers 100→50→62→77→96→100', async () => {
    const clock = new FakeClock()
    let remaining429 = 2
    const fetchFn: FetchFn = () => {
      if (remaining429 > 0) {
        remaining429 -= 1
        return Promise.resolve(jsonResponse({ error: 'rate' }, 429, { 'retry-after': '1' }))
      }
      return Promise.resolve(okReply())
    }
    const pool = new ProviderPool(
      { ...baseProvider, concurrency: 100 },
      new KeyRing('k-abcdefghijkl'),
      fetchFn,
      { clock },
    )

    await expect(pool.execute(request, new AbortController().signal)).rejects.toMatchObject({
      kind: 'rateLimited',
    })
    expect(pool.stats().current).toBe(50)

    await expect(pool.execute(request, new AbortController().signal)).rejects.toMatchObject({
      kind: 'rateLimited',
    })
    expect(pool.stats().current).toBe(50)

    clock.advance(10_000)
    remaining429 = 1
    await expect(pool.execute(request, new AbortController().signal)).rejects.toMatchObject({
      kind: 'rateLimited',
    })
    expect(pool.stats().current).toBe(25)

    remaining429 = 1
    const stepped = new ProviderPool(
      { ...baseProvider, concurrency: 100 },
      new KeyRing('k-abcdefghijkl'),
      () => {
        if (remaining429 > 0) {
          remaining429 -= 1
          return Promise.resolve(jsonResponse({ error: 'rate' }, 429))
        }
        return Promise.resolve(okReply())
      },
      { clock: new FakeClock() },
    )
    await expect(stepped.execute(request, new AbortController().signal)).rejects.toMatchObject({
      kind: 'rateLimited',
    })
    expect(stepped.stats().current).toBe(50)
    for (let i = 0; i < 50; i += 1) await stepped.execute(request, new AbortController().signal)
    expect(stepped.stats().current).toBe(62)
    for (let i = 0; i < 62; i += 1) await stepped.execute(request, new AbortController().signal)
    expect(stepped.stats().current).toBe(77)
    for (let i = 0; i < 77; i += 1) await stepped.execute(request, new AbortController().signal)
    expect(stepped.stats().current).toBe(96)
    for (let i = 0; i < 96; i += 1) await stepped.execute(request, new AbortController().signal)
    expect(stepped.stats().current).toBe(100)
  })

  test('setConfigured lower does not abort in-flight requests', async () => {
    const hanging = hangFetchParts()
    const pool = new ProviderPool(
      { ...baseProvider, concurrency: 4 },
      new KeyRing('k-abcdefghijkl'),
      hanging.fetch,
    )
    const jobs = Array.from({ length: 4 }, () =>
      pool.execute(request, new AbortController().signal),
    )
    await hanging.waitFor(4)
    pool.setConfigured(1)
    expect(pool.stats().current).toBe(1)
    expect(pool.stats().inFlight).toBe(4)
    hanging.release()
    const results = await Promise.all(jobs)
    expect(results).toHaveLength(4)
    expect(pool.stats().inFlight).toBe(0)
  })

  test('credential on one key retries with the next', async () => {
    const seen: string[] = []
    const fetchFn: FetchFn = (_url, init) => {
      const header = new Headers(init?.headers).get('authorization') ?? ''
      seen.push(header)
      if (header.includes('bad-abcdefghij')) {
        return Promise.resolve(jsonResponse({ error: 'invalid api key' }, 401))
      }
      return Promise.resolve(okReply('ok'))
    }
    const pool = new ProviderPool(
      baseProvider,
      new KeyRing('bad-abcdefghij,good-abcdefghij'),
      fetchFn,
    )
    const reply = await pool.execute(request, new AbortController().signal)
    expect(reply.text).toBe('ok')
    expect(seen.length).toBe(2)
  })

  test('a local server without a key gets requests with no Authorization header', async () => {
    const seen: Array<string | null> = []
    const fetchFn: FetchFn = (_url, init) => {
      seen.push(new Headers(init?.headers).get('authorization'))
      return Promise.resolve(okReply('ok'))
    }
    const local = { ...baseProvider, baseUrl: 'http://localhost:11434/v1' }
    const pool = new ProviderPool(local, new KeyRing(''), fetchFn)
    const reply = await pool.execute(request, new AbortController().signal)
    expect(reply.text).toBe('ok')
    expect(seen).toEqual([null])
  })

  test('a remote provider without a key still fails before sending', async () => {
    let calls = 0
    const fetchFn: FetchFn = () => {
      calls += 1
      return Promise.resolve(okReply('ok'))
    }
    const pool = new ProviderPool(baseProvider, new KeyRing(''), fetchFn)
    await expect(pool.execute(request, new AbortController().signal)).rejects.toThrow(
      '未配置 API Key。',
    )
    expect(calls).toBe(0)
  })
})

describe('TranslationPools', () => {
  test('get caches the pool and resetKeys reloads secrets', async () => {
    const keys = new Map<string, string>([['p', 'old-abcdefghij']])
    const seen: string[] = []
    const fetchFn: FetchFn = (_url, init) => {
      seen.push(new Headers(init?.headers).get('authorization') ?? '')
      return Promise.resolve(okReply())
    }
    const pools = new TranslationPools(fetchFn, (id) => keys.get(id))
    const first = pools.get(baseProvider)
    expect(pools.get(baseProvider)).toBe(first)

    await first.execute(request, new AbortController().signal)
    expect(seen.at(-1)).toContain('old-abcdefghij')

    keys.set('p', 'new-abcdefghij')
    pools.resetKeys('p')
    await first.execute(request, new AbortController().signal)
    expect(seen.at(-1)).toContain('new-abcdefghij')

    pools.configure([{ ...baseProvider, concurrency: 1 }])
    expect(first.stats().configured).toBe(1)
    expect(first.stats().current).toBe(1)
  })

  test('invalidate drops a provider so the next request reads its keys again', async () => {
    const keys = new Map<string, string>([
      ['p', 'old-abcdefghij'],
      ['q', 'q-abcdefghijkl'],
    ])
    const seen: string[] = []
    const fetchFn: FetchFn = (_url, init) => {
      seen.push(new Headers(init?.headers).get('authorization') ?? '')
      return Promise.resolve(okReply())
    }
    const pools = new TranslationPools(fetchFn, (id) => keys.get(id))
    const other = { ...baseProvider, id: 'q' }
    const first = pools.get(baseProvider)
    const second = pools.get(other)
    keys.set('p', 'new-abcdefghij')
    pools.invalidate('p')
    expect(pools.get(baseProvider)).not.toBe(first)
    expect(pools.get(other)).toBe(second)
    await pools.execute(baseProvider, request, new AbortController().signal)
    expect(seen.at(-1)).toContain('new-abcdefghij')
    pools.invalidate()
    expect(pools.get(other)).not.toBe(second)
  })

  test('each request uses the caller provider; the shared pool keeps no endpoint', async () => {
    const urls: string[] = []
    const fetchFn: FetchFn = (url) => {
      urls.push(url)
      return Promise.resolve(okReply())
    }
    const pools = new TranslationPools(fetchFn, () => 'k-abcdefghijkl')
    const old = { ...baseProvider, baseUrl: 'https://old.example.com/v1' }
    const renewed = { ...baseProvider, baseUrl: 'https://new.example.com/v1' }
    await pools.execute(renewed, request, new AbortController().signal)
    await pools.execute(old, request, new AbortController().signal)
    await pools.execute(renewed, request, new AbortController().signal)
    expect(urls.map((url) => new URL(url).host)).toEqual([
      'new.example.com',
      'old.example.com',
      'new.example.com',
    ])
  })
})

describe('ProviderPool cancellation', () => {
  test('a queued request leaves the queue as soon as its document is cancelled', async () => {
    const hanging = hangFetchParts()
    const pool = new ProviderPool(
      { ...baseProvider, concurrency: 1 },
      new KeyRing('k-abcdefghijkl'),
      hanging.fetch,
    )
    const running = pool.execute(request, new AbortController().signal)
    await hanging.waitFor(1)
    const controller = new AbortController()
    const queued = pool.execute(request, controller.signal)
    expect(pool.stats().waiting).toBe(1)
    controller.abort()
    await expect(queued).rejects.toMatchObject({ code: 'cancelled' })
    expect(pool.stats().waiting).toBe(0)
    hanging.release()
    await running
    expect(pool.stats().inFlight).toBe(0)
  })

  test('an in-flight request aborted by its document is a cancellation, not a provider error', async () => {
    const fetchFn: FetchFn = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        })
      })
    const pool = new ProviderPool(baseProvider, new KeyRing('k-abcdefghijkl'), fetchFn)
    const controller = new AbortController()
    const pending = pool.execute(request, controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    expect(pool.stats().inFlight).toBe(0)
  })
})
