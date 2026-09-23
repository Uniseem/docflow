import { describe, expect, test } from 'vitest'
import type { ProviderConfig } from '../../shared/types'
import { buildRequest, chatUrl, mergeExtraBody, modelsUrl } from './request'

const base = (
  over: Partial<ProviderConfig> & Pick<ProviderConfig, 'type' | 'baseUrl'>,
): ProviderConfig => ({
  id: 'p',
  name: 'P',
  models: [],
  enabled: true,
  concurrency: 100,
  ...over,
})

describe('chatUrl / modelsUrl', () => {
  test('openai and azure', () => {
    expect(chatUrl(base({ type: 'openai', baseUrl: 'https://api.openai.com/v1/' }), 'gpt')).toBe(
      'https://api.openai.com/v1/chat/completions',
    )
    expect(
      modelsUrl(base({ type: 'azure', baseUrl: 'https://x.openai.azure.com/openai/v1' })),
    ).toBe('https://x.openai.azure.com/openai/v1/models')
  })

  test('anthropic does not duplicate /v1', () => {
    expect(chatUrl(base({ type: 'anthropic', baseUrl: 'https://api.anthropic.com' }), 'c')).toBe(
      'https://api.anthropic.com/v1/messages',
    )
    expect(chatUrl(base({ type: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' }), 'c')).toBe(
      'https://api.anthropic.com/v1/messages',
    )
  })

  test('gemini strips models/ and does not duplicate v1beta', () => {
    expect(
      chatUrl(
        base({ type: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com' }),
        'models/g',
      ),
    ).toBe('https://generativelanguage.googleapis.com/v1beta/models/g:generateContent')
    expect(
      modelsUrl(
        base({ type: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' }),
      ),
    ).toBe('https://generativelanguage.googleapis.com/v1beta/models')
  })
})

test('extraBody deep-merges objects and overwrites scalars', () => {
  const merged = mergeExtraBody(
    { generationConfig: { maxOutputTokens: 10 }, stream: false },
    { generationConfig: { thinkingConfig: { thinkingBudget: 0 } }, stream: true },
  )
  expect(merged).toEqual({
    generationConfig: { maxOutputTokens: 10, thinkingConfig: { thinkingBudget: 0 } },
    stream: true,
  })
})

test('buildRequest omits auth when key is empty', () => {
  const { init } = buildRequest(
    base({ type: 'openai', baseUrl: 'https://api.openai.com/v1' }),
    'm',
    'sys',
    'user',
    undefined,
    '4.0.0',
    undefined,
  )
  const headers = init.headers as Record<string, string>
  expect(headers.Authorization).toBeUndefined()
  expect(headers['User-Agent']).toBe('DocFlow/4.0.0')
})

test('anthropic always sends anthropic-version, even without a key', () => {
  const { init } = buildRequest(
    base({ type: 'anthropic', baseUrl: 'http://localhost:8080' }),
    'm',
    'sys',
    'user',
    undefined,
    '4.0.0',
    undefined,
  )
  const headers = init.headers as Record<string, string>
  expect(headers['anthropic-version']).toBe('2023-06-01')
  expect(headers['x-api-key']).toBeUndefined()
})
