import { afterEach, describe, expect, test } from 'vitest'
import { listenMockProvider, type MockServer } from '../../../tests/mock-provider/server'
import { checkModel, listModels } from './providers'
import type { ProviderConfig } from '../../shared/types'

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
