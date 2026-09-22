import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { DEFAULT_SYSTEM_PROMPT } from '../../shared/constants'
import type { ProviderConfig, TranslationRuntime } from '../../shared/types'
import { cacheFingerprint, TranslationCache } from './cache'
import { protectTexts, restoreTokens } from './protect'
import { checkReply, normalizeMarkers, restoreAndCheckPdf } from './validate'

const provider: ProviderConfig = {
  id: 'p',
  name: 'P',
  type: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  enabled: true,
  models: [{ id: 'm' }],
  concurrency: 1,
}

const runtime: TranslationRuntime = {
  llm: { chunkChars: 4000, maxSegmentsPerRequest: 8, maxRequestChars: 8000, maxOutputTokens: 0 },
  perDocumentConcurrency: 4,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
}

describe('protect + validate', () => {
  test('replaces {vN} and injection literals then restores', () => {
    const source = 'see {v1} and <segment id="x">keep</segment> DOCFLOWKEEP000009TOKEN'
    const protection = protectTexts([source])
    expect(protection.texts[0]).not.toContain('{v1}')
    expect(protection.texts[0]).not.toContain('<segment')
    expect(protection.tokens).toHaveLength(4)
    const restored = restoreAndCheckPdf(
      protection.texts[0] ?? '',
      protection.originals,
      source,
      'standard',
    )
    expect(restored).toBe(source)
    expect(restoreTokens(protection.texts[0] ?? '', protection.originals)).toBe(source)
  })

  test('repairs damaged markers and rejects count/order changes', () => {
    const token = 'DOCFLOWKEEP000001TOKEN'
    expect(normalizeMarkers('`DOCFLOW KEEP 0 0 0 0 0 1 TOKEN`', [token])).toBe(token)
    expect(() => normalizeMarkers('hello', [token])).toThrow(/数量不匹配/)
    expect(() => normalizeMarkers('DOCFLOWKEEP000009TOKEN', [token])).toThrow(/编号发生变化/)
    const source = 'a {v1} b {v2}'
    const protection = protectTexts([source])
    const swapped = `${protection.tokens[1]}${protection.tokens[0]}`
    const normalized = normalizeMarkers(swapped, protection.tokens)
    expect(() => restoreAndCheckPdf(normalized, protection.originals, source, 'standard')).toThrow(
      /顺序改变/,
    )
    expect(() =>
      restoreAndCheckPdf(
        'DOCFLOWKEEP000000TOKEN leftover',
        new Map([['DOCFLOWKEEP000000TOKEN', '{v1}']]),
        'plain',
        'isolated',
      ),
    ).toThrow(/未恢复|隔离/)
  })

  test('checkReply maps finish and empty', () => {
    expect(
      checkReply({
        text: '',
        finish: 'truncated',
        source: 'a',
        tokens: [],
        originals: new Map(),
        mode: 'standard',
      }),
    ).toMatchObject({ ok: false, kind: 'truncated' })
    expect(
      checkReply({
        text: '',
        finish: 'refused',
        source: 'a',
        tokens: [],
        originals: new Map(),
        mode: 'standard',
      }),
    ).toMatchObject({ ok: false, kind: 'refused' })
    expect(
      checkReply({
        text: '   ',
        finish: 'complete',
        source: 'a',
        tokens: [],
        originals: new Map(),
        mode: 'standard',
      }),
    ).toMatchObject({ ok: false, kind: 'empty' })
  })
})

describe('TranslationCache', () => {
  test('persists hits and invalidates on fingerprint change', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'df-cache-'))
    const path = join(dir, 'translation-cache.json')
    const fingerprint = cacheFingerprint(provider, 'm', runtime)
    const cache = new TranslationCache(path, fingerprint)
    cache.set('hello {v1}', '你好 {v1}')
    await cache.flush()
    const raw = JSON.parse(await readFile(path, 'utf8')) as { fingerprint: string }
    expect(raw.fingerprint).toBe(fingerprint)
    const loaded = new TranslationCache(path, fingerprint)
    await loaded.load()
    expect(loaded.get('hello {v1}')).toBe('你好 {v1}')
    const other = new TranslationCache(path, cacheFingerprint(provider, 'other', runtime))
    await other.load()
    expect(other.get('hello {v1}')).toBeUndefined()
    cache.start()
    cache.stop()
  })
})
