import { describe, expect, test } from 'vitest'
import { fakeFetch } from './fake'
import { createFetch } from './http'

describe('createFetch / fakeFetch', () => {
  test('uses fake fetch when DOCFLOW_FAKE_PROVIDERS=1, otherwise injected or global fetch', () => {
    const previous = process.env.DOCFLOW_FAKE_PROVIDERS
    delete process.env.DOCFLOW_FAKE_PROVIDERS
    const custom = () => Promise.resolve(new Response('ok'))
    expect(createFetch(custom)).toBe(custom)
    process.env.DOCFLOW_FAKE_PROVIDERS = '1'
    expect(createFetch(custom)).toBe(fakeFetch)
    delete process.env.DOCFLOW_FAKE_PROVIDERS
    expect(createFetch()).toBe(fetch)
    if (previous) process.env.DOCFLOW_FAKE_PROVIDERS = previous
  })

  test('fakeFetch lists fake-model and translates openai/anthropic/gemini bodies', async () => {
    const models = await fakeFetch('https://example/v1/models', { method: 'GET' })
    expect(((await models.json()) as { data: Array<{ id: string }> }).data[0]?.id).toBe(
      'fake-model',
    )
    const openai = await fakeFetch('https://example/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        messages: [{ role: 'user', content: '<segment id="a">\nHi\n</segment>' }],
      }),
    })
    expect(JSON.stringify(await openai.json())).toContain('〔测试译文〕')
    const anthropic = await fakeFetch('https://example/anthropic/v1/messages', {
      method: 'POST',
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello' }] }),
    })
    expect(JSON.stringify(await anthropic.json())).toContain('Hello〔测试译文〕')
    const gemini = await fakeFetch('https://example/gemini/v1beta/models/x:generateContent', {
      method: 'POST',
      body: JSON.stringify({ contents: [{ parts: [{ text: 'Hi' }] }] }),
    })
    expect(JSON.stringify(await gemini.json())).toContain('Hi〔测试译文〕')
  })
})
