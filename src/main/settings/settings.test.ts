import { mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { defaultSettings } from '../../shared/types'
import { SettingsStore, deepMerge } from './settings'

describe('deepMerge', () => {
  test('replaces arrays instead of merging by index', () => {
    expect(deepMerge({ providers: [1, 2] }, { providers: [3] })).toEqual({ providers: [3] })
  })

  test('null overwrites', () => {
    expect(deepMerge({ defaultTranslator: { a: 1 } }, { defaultTranslator: null })).toEqual({
      defaultTranslator: null,
    })
  })
})

describe('SettingsStore', () => {
  test('missing file yields defaults', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'docflow-settings-'))
    const store = new SettingsStore(dir)
    const loaded = await store.load()
    expect(loaded.version).toBe(1)
    expect(loaded.providers).toEqual([])
  })

  test('update persists and round-trips', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'docflow-settings-'))
    const store = new SettingsStore(dir)
    await store.load()
    await store.update({ workerConcurrency: 3, pdf: { bilingual: false } })
    const again = new SettingsStore(dir)
    const loaded = await again.load()
    expect(loaded.workerConcurrency).toBe(3)
    expect(loaded.pdf.bilingual).toBe(false)
    expect(loaded.pdf.minFontScale).toBe(0.6)
  })

  test('corrupt file is backed up and replaced with defaults', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'docflow-settings-'))
    const warnings: string[] = []
    const store = new SettingsStore(dir, { onWarning: (message) => warnings.push(message) })
    await writeFile(join(dir, 'settings.json'), '{not json', 'utf8')
    const loaded = await store.load()
    expect(loaded).toEqual(defaultSettings())
    expect(warnings[0]).toMatch(/无法解析/)
    const names = await readdir(dir)
    expect(names.some((name) => name.startsWith('settings.json.broken-'))).toBe(true)
  })

  test('unknown fields are treated as corrupt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'docflow-settings-'))
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({ ...defaultSettings(), extra: true }),
      'utf8',
    )
    const store = new SettingsStore(dir)
    const loaded = await store.load()
    expect(loaded.providers).toEqual([])
    expect('extra' in loaded).toBe(false)
  })

  test('drops defaultTranslator when the model is gone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'docflow-settings-'))
    const store = new SettingsStore(dir)
    await store.load()
    await store.update({
      providers: [
        {
          id: 'deepseek',
          name: 'DeepSeek',
          type: 'openai',
          baseUrl: 'https://api.deepseek.com/v1',
          models: [{ id: 'deepseek-chat' }],
        },
      ],
      defaultTranslator: { providerId: 'deepseek', model: 'deepseek-chat' },
    })
    const next = await store.update({
      providers: [
        {
          id: 'deepseek',
          name: 'DeepSeek',
          type: 'openai',
          baseUrl: 'https://api.deepseek.com/v1',
          models: [{ id: 'other' }],
        },
      ],
    })
    expect(next.defaultTranslator).toBeNull()
  })
})
