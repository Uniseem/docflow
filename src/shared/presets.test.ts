import { describe, expect, test } from 'vitest'
import { PRESETS, keyOptional, mockBaseUrl, uniqueProviderId, withMockProviderUrl } from './presets'

describe('PRESETS', () => {
  test('has 20 unique ids covering the four interface types', () => {
    expect(PRESETS).toHaveLength(20)
    expect(new Set(PRESETS.map((preset) => preset.id)).size).toBe(20)
    expect(PRESETS.some((preset) => preset.type === 'openai')).toBe(true)
    expect(PRESETS.some((preset) => preset.type === 'azure')).toBe(true)
    expect(PRESETS.some((preset) => preset.type === 'anthropic')).toBe(true)
    expect(PRESETS.some((preset) => preset.type === 'gemini')).toBe(true)
  })

  test('ollama and lmstudio mark key optional; loopback host does too', () => {
    expect(PRESETS.find((preset) => preset.id === 'ollama')?.keyOptional).toBe(true)
    expect(keyOptional({ preset: 'ollama', baseUrl: 'http://localhost:11434/v1' })).toBe(true)
    expect(keyOptional({ baseUrl: 'http://127.0.0.1:1234/v1' })).toBe(true)
    expect(keyOptional({ baseUrl: 'https://api.deepseek.com/v1' })).toBe(false)
  })

  test('uniqueProviderId appends -2 -3', () => {
    expect(uniqueProviderId('deepseek', [])).toBe('deepseek')
    expect(uniqueProviderId('deepseek', ['deepseek'])).toBe('deepseek-2')
    expect(uniqueProviderId('deepseek', ['deepseek', 'deepseek-2'])).toBe('deepseek-3')
  })

  test('mockBaseUrl rewrites per protocol', () => {
    const mock = 'http://127.0.0.1:38111/'
    expect(mockBaseUrl('openai', mock)).toBe('http://127.0.0.1:38111/v1')
    expect(mockBaseUrl('azure', mock)).toBe('http://127.0.0.1:38111/v1')
    expect(mockBaseUrl('anthropic', mock)).toBe('http://127.0.0.1:38111/anthropic')
    expect(mockBaseUrl('gemini', mock)).toBe('http://127.0.0.1:38111/gemini')
  })

  test('withMockProviderUrl rewrites baseUrl when mock root is set', () => {
    const provider = {
      type: 'openai' as const,
      baseUrl: 'https://api.deepseek.com/v1',
    }
    expect(withMockProviderUrl(provider).baseUrl).toBe('https://api.deepseek.com/v1')
    expect(withMockProviderUrl(provider, 'http://127.0.0.1:38111').baseUrl).toBe(
      'http://127.0.0.1:38111/v1',
    )
  })
})
