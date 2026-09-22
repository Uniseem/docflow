import { describe, expect, test } from 'vitest'
import { DEFAULT_SYSTEM_PROMPT } from './constants'
import {
  DocumentManifest,
  HostState,
  ProcessingEvent,
  ProviderConfig,
  Settings,
  defaultSettings,
  translatorLabel,
} from './types'

const provider = {
  id: 'deepseek',
  name: 'DeepSeek',
  type: 'openai' as const,
  baseUrl: 'https://api.deepseek.com/v1',
  models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
}

describe('ProviderConfig', () => {
  test('fills defaults', () => {
    const parsed = ProviderConfig.parse(provider)
    expect(parsed.enabled).toBe(true)
    expect(parsed.concurrency).toBe(100)
  })

  test('rejects bad id', () => {
    expect(() => ProviderConfig.parse({ ...provider, id: 'DeepSeek' })).toThrow()
    expect(() => ProviderConfig.parse({ ...provider, id: '' })).toThrow()
  })

  test('rejects non-http url', () => {
    expect(() =>
      ProviderConfig.parse({ ...provider, baseUrl: 'ftp://api.example.com/v1' }),
    ).toThrow()
  })

  test('rejects extraBody reserved keys', () => {
    for (const key of ['model', 'messages', 'stream', 'contents', 'system', 'systemInstruction']) {
      expect(() => ProviderConfig.parse({ ...provider, extraBody: { [key]: 1 } })).toThrow()
    }
  })

  test('allows nested extraBody', () => {
    const parsed = ProviderConfig.parse({
      ...provider,
      extraBody: { generationConfig: { thinkingConfig: { thinkingBudget: 0 } } },
    })
    expect(parsed.extraBody).toEqual({
      generationConfig: { thinkingConfig: { thinkingBudget: 0 } },
    })
  })

  test('rejects duplicate model ids', () => {
    expect(() =>
      ProviderConfig.parse({
        ...provider,
        models: [{ id: 'a' }, { id: 'a' }],
      }),
    ).toThrow()
  })

  test('rejects model id with newline', () => {
    expect(() => ProviderConfig.parse({ ...provider, models: [{ id: 'a\nb' }] })).toThrow()
  })
})

describe('Settings', () => {
  test('parses defaults', () => {
    const settings = defaultSettings()
    expect(settings.version).toBe(1)
    expect(settings.workerConcurrency).toBe(2)
    expect(settings.proxy).toEqual({ mode: 'system' })
    expect(settings.pdf.bilingual).toBe(true)
    expect(settings.translation.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT)
    expect(settings.translation.llm.chunkChars).toBe(4000)
  })

  test('rejects unknown fields', () => {
    const valid = {
      version: 1 as const,
      providers: [],
      defaultTranslator: null,
      translation: { llm: {}, systemPrompt: 'x' },
      proxy: { mode: 'system' as const },
      pdf: {},
    }
    expect(Settings.parse(valid).notifications).toBe(true)
    expect(() => Settings.parse({ ...valid, extra: true })).toThrow()
  })

  test('custom proxy only allows http(s)/socks5h', () => {
    const valid = {
      version: 1 as const,
      providers: [],
      defaultTranslator: null,
      translation: { llm: {}, systemPrompt: 'x' },
      pdf: {},
    }
    expect(
      Settings.parse({ ...valid, proxy: { mode: 'custom', url: 'socks5h://127.0.0.1:1080' } }).proxy
        .mode,
    ).toBe('custom')
    expect(() =>
      Settings.parse({ ...valid, proxy: { mode: 'custom', url: 'ftp://proxy.local' } }),
    ).toThrow()
  })
})

describe('DocumentManifest / events / host', () => {
  const at = '2026-09-21T16:00:00.000Z'
  const manifest = {
    version: 1 as const,
    id: '20260921T160000-8f3a2c',
    title: 'Paper',
    titleCustom: false,
    originalFilename: 'paper.pdf',
    sourceSize: 12,
    sourceSha256: 'a'.repeat(64),
    pages: 3,
    translator: { providerId: 'deepseek', model: 'deepseek-chat', label: 'DeepSeek · Chat' },
    settingsSnapshot: defaultSettings().translation,
    status: 'queued' as const,
    stage: 'received' as const,
    progress: 0,
    failure: null,
    attempts: 0,
    nextAttemptAt: null,
    stats: null,
    outputs: { mono: null, dual: null },
    createdAt: at,
    updatedAt: at,
    startedAt: null,
    completedAt: null,
  }

  test('accepts a complete manifest', () => {
    expect(DocumentManifest.parse(manifest).id).toBe(manifest.id)
  })

  test('rejects short sha256', () => {
    expect(() => DocumentManifest.parse({ ...manifest, sourceSha256: 'abc' })).toThrow()
  })

  test('parses a processing event', () => {
    const event = ProcessingEvent.parse({
      seq: 1,
      at,
      stage: 'inspect',
      level: 'info',
      message: '检查 PDF：3 页',
    })
    expect(event.seq).toBe(1)
  })

  test('host state is strict', () => {
    expect(HostState.parse({ theme: 'dark' }).theme).toBe('dark')
    expect(() => HostState.parse({ theme: 'dark', extra: 1 })).toThrow()
  })
})

describe('translatorLabel', () => {
  test('uses model name when present', () => {
    const parsed = ProviderConfig.parse(provider)
    expect(translatorLabel(parsed, 'deepseek-chat')).toBe('DeepSeek · DeepSeek Chat')
    expect(translatorLabel(parsed, 'missing')).toBe('DeepSeek · missing')
  })
})
