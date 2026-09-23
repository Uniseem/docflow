import { afterEach, describe, expect, test } from 'vitest'
import {
  DEFAULT_MOCK_CONFIG,
  listenMockProvider,
  parseCli,
  parseConfigPatch,
  replyFor,
  MockProviderState,
  MOCK_MARK,
  type MockConfig,
  type MockServer,
} from './server'

const KEY = 'test-key'

async function chat(
  server: MockServer,
  user: string,
  options: {
    model?: string
    key?: string
    api?: 'openai' | 'anthropic' | 'gemini'
    signal?: AbortSignal
  } = {},
): Promise<Response> {
  const model = options.model ?? 'mock-chat'
  const key = options.key ?? KEY
  const api = options.api ?? 'openai'
  if (api === 'anthropic') {
    return fetch(`${server.url}/anthropic/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 256,
        messages: [{ role: 'user', content: user }],
      }),
    })
  }
  if (api === 'gemini') {
    return fetch(`${server.url}/gemini/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: user }] }] }),
    })
  }
  return fetch(`${server.url}/v1/chat/completions`, {
    method: 'POST',
    ...(options.signal ? { signal: options.signal } : {}),
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 's' },
        { role: 'user', content: user },
      ],
    }),
  })
}

describe('mock provider', () => {
  let server: MockServer | undefined
  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  test('parseCli defaults to 38111 without delay', () => {
    expect(parseCli([])).toEqual({ port: 38111, open: false, delayMs: 0 })
    expect(parseCli(['--port', '9', '--open'])).toEqual({ port: 9, open: true, delayMs: 0 })
    expect(parseCli(['8765'])).toEqual({ port: 8765, open: false, delayMs: 0 })
    expect(parseCli(['--delay', '250'])).toEqual({ port: 38111, open: false, delayMs: 250 })
    expect(parseCli(['--delay', '250', '8765'])).toEqual({ port: 8765, open: false, delayMs: 250 })
    expect(parseCli(['--delay', 'soon'])).toEqual({ port: 38111, open: false, delayMs: 0 })
  })

  test('parseConfigPatch accepts only known non-negative integers', () => {
    expect(parseConfigPatch('{"delayMs":300}')).toEqual({ delayMs: 300 })
    expect(parseConfigPatch('{"rateLimitEvery":0}')).toEqual({ rateLimitEvery: 0 })
    expect(parseConfigPatch('')).toEqual({})
    expect(parseConfigPatch('{"delayMs":-1}')).toBeNull()
    expect(parseConfigPatch('{"delayMs":1.5}')).toBeNull()
    expect(parseConfigPatch('{"delayMs":"300"}')).toBeNull()
    expect(parseConfigPatch('{"delay":300}')).toBeNull()
    expect(parseConfigPatch('[1]')).toBeNull()
    expect(parseConfigPatch('{')).toBeNull()
  })

  test('translates segments and single text', () => {
    const state = new MockProviderState()
    expect(replyFor('Hello', state).text).toBe(`Hello${MOCK_MARK}`)
    const batched = replyFor(
      '<segment id="a">\none\n</segment>\n\n<segment id="b">\ntwo\n</segment>',
      state,
    ).text
    expect(batched).toContain(`<segment id="a">\none${MOCK_MARK}\n</segment>`)
    expect(batched).toContain(`<segment id="b">\ntwo${MOCK_MARK}\n</segment>`)
  })

  test('injects the 08.3 faults', async () => {
    server = await listenMockProvider()
    const ok = await chat(server, 'Hello, world.')
    const okJson = (await ok.json()) as {
      choices: Array<{ message: { content: string }; finish_reason: string }>
    }
    expect(okJson.choices[0]?.message.content).toBe(`Hello, world.${MOCK_MARK}`)

    const dropped = await chat(
      server,
      '<segment id="1">\nkeep\n</segment>\n\n<segment id="2">\nDROP_ME gone\n</segment>',
    )
    const droppedText = ((await dropped.json()) as typeof okJson).choices[0]?.message.content ?? ''
    expect(droppedText).toContain('id="1"')
    expect(droppedText).not.toContain('id="2"')

    const damaged = await chat(server, 'DAMAGE_MARKERS DOCFLOWKEEP000001TOKEN')
    expect(((await damaged.json()) as typeof okJson).choices[0]?.message.content).toContain(
      '`DOCFLOW KEEP 0 0 0 0 0 1 TOKEN`',
    )

    const lost = await chat(
      server,
      'LOSE_MARKERS DOCFLOWKEEP000001TOKEN keep DOCFLOWKEEP000002TOKEN',
    )
    const lostText = ((await lost.json()) as typeof okJson).choices[0]?.message.content ?? ''
    expect(lostText).not.toContain('DOCFLOWKEEP000001TOKEN')
    expect(lostText).toContain('DOCFLOWKEEP000002TOKEN')

    const swapped = await chat(server, 'SWAP_MARKERS DOCFLOWKEEP000001TOKEN DOCFLOWKEEP000002TOKEN')
    const swappedText = ((await swapped.json()) as typeof okJson).choices[0]?.message.content ?? ''
    expect(swappedText.indexOf('DOCFLOWKEEP000002TOKEN')).toBeLessThan(
      swappedText.indexOf('DOCFLOWKEEP000001TOKEN'),
    )

    const refused = await chat(server, 'please REFUSE_ME')
    expect(((await refused.json()) as typeof okJson).choices[0]?.finish_reason).toBe(
      'content_filter',
    )

    const reasoner = await chat(server, 'Hi', { model: 'mock-reasoner' })
    expect(((await reasoner.json()) as typeof okJson).choices[0]?.message.content).toMatch(
      /^<think>/,
    )

    const long = await chat(server, `${'x'.repeat(3001)}`)
    expect(((await long.json()) as typeof okJson).choices[0]?.finish_reason).toBe('length')
  })

  test('bad-key, poor-key, missing-model and every 9th 429', async () => {
    server = await listenMockProvider()
    const bad = await chat(server, 'hi', { key: 'bad-key' })
    expect(bad.status).toBe(401)
    const poor = await chat(server, 'hi', { key: 'poor-key' })
    expect(poor.status).toBe(429)
    expect(JSON.stringify(await poor.json())).toContain('insufficient')
    const missing = await chat(server, 'hi', { model: 'missing-model' })
    expect(missing.status).toBe(404)

    let saw429 = false
    for (let i = 0; i < 9; i += 1) {
      const response = await chat(server, `n${i}`)
      if (response.status === 429) {
        saw429 = true
        expect(response.headers.get('retry-after')).toBe('1')
      }
    }
    expect(saw429).toBe(true)
  })

  test('lists models for three APIs and tracks peak concurrency', async () => {
    server = await listenMockProvider()
    const openai = await fetch(`${server.url}/v1/models`, {
      headers: { authorization: `Bearer ${KEY}` },
    })
    const openaiJson = (await openai.json()) as { data: Array<{ id: string }> }
    expect(openaiJson.data.map((row) => row.id)).toContain('mock-chat')

    const anthropic = await fetch(`${server.url}/anthropic/v1/models`, {
      headers: { 'x-api-key': KEY },
    })
    expect(((await anthropic.json()) as { has_more: boolean }).has_more).toBe(true)

    const gemini = await fetch(`${server.url}/gemini/v1beta/models`, {
      headers: { 'x-goog-api-key': KEY },
    })
    const geminiJson = (await gemini.json()) as {
      models: Array<{ name: string; supportedGenerationMethods: string[] }>
    }
    expect(
      geminiJson.models.some(
        (row) =>
          row.name === 'models/gemini-mock' &&
          row.supportedGenerationMethods.includes('generateContent'),
      ),
    ).toBe(true)

    const geminiChat = await chat(server, 'Hi', { api: 'gemini', model: 'gemini-mock' })
    expect(geminiChat.status).toBe(200)
    const anthropicChat = await chat(server, 'Hi', { api: 'anthropic' })
    expect(anthropicChat.status).toBe(200)

    await Promise.all(Array.from({ length: 8 }, (_, i) => chat(server!, `p${i}`)))
    const stats = (await (await fetch(`${server.url}/stats`)).json()) as {
      peak: Record<string, number>
      requests: Record<string, number>
    }
    expect(stats.peak.openai).toBeGreaterThanOrEqual(1)
    expect(stats.requests.openai).toBeGreaterThan(0)

    await fetch(`${server.url}/reset`, { method: 'POST' })
    const reset = (await (await fetch(`${server.url}/stats`)).json()) as {
      requests: Record<string, number>
    }
    expect(reset.requests).toEqual({})
  })
  test('POST /config delays chat replies and POST /reset restores the startup config', async () => {
    server = await listenMockProvider()
    const config = async (): Promise<MockConfig> =>
      (await (await fetch(`${server!.url}/config`)).json()) as MockConfig
    expect(await config()).toEqual(DEFAULT_MOCK_CONFIG)

    const changed = await fetch(`${server.url}/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ delayMs: 200 }),
    })
    expect(await changed.json()).toEqual({ ...DEFAULT_MOCK_CONFIG, delayMs: 200 })
    const started = performance.now()
    const slow = await chat(server, 'Hello')
    expect(slow.status).toBe(200)
    expect(performance.now() - started).toBeGreaterThanOrEqual(190)

    const invalid = await fetch(`${server.url}/config`, {
      method: 'POST',
      body: JSON.stringify({ delayMs: -5 }),
    })
    expect(invalid.status).toBe(400)
    expect((await config()).delayMs).toBe(200)

    await fetch(`${server.url}/reset`, { method: 'POST' })
    expect(await config()).toEqual(DEFAULT_MOCK_CONFIG)
  })

  test('startup config survives reset; rateLimitEvery 0 never answers 429', async () => {
    server = await listenMockProvider(0, { config: { rateLimitEvery: 0 } })
    for (let i = 0; i < 12; i += 1) {
      expect((await chat(server, `n${i}`)).status).toBe(200)
    }
    await fetch(`${server.url}/reset`, { method: 'POST' })
    const config = (await (await fetch(`${server.url}/config`)).json()) as MockConfig
    expect(config.rateLimitEvery).toBe(0)
    expect(server.state.snapshot().rateLimited).toBe(0)
  })

  test('a client that gives up during the delay leaves the server usable', async () => {
    server = await listenMockProvider(0, { config: { delayMs: 400 } })
    const controller = new AbortController()
    const pending = chat(server, 'Hello', { signal: controller.signal })
    await expect.poll(() => server!.state.snapshot().inFlight.openai).toBe(1)
    controller.abort()
    await expect(pending).rejects.toThrow()
    await expect.poll(() => server!.state.snapshot().inFlight.openai, { timeout: 2_000 }).toBe(0)

    await fetch(`${server.url}/config`, { method: 'POST', body: JSON.stringify({ delayMs: 0 }) })
    const ok = await chat(server, 'Again')
    expect(ok.status).toBe(200)
  })
})
