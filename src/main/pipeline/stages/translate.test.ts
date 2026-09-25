import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { AnalysisResult } from '../../../shared/pdf-types'
import { defaultTranslationRuntime } from '../../../shared/types'
import { DocumentLibrary } from '../../library/library'
import { fakeFetch, fakeProvider } from '../../translate/fake'
import { TranslationPools } from '../../translate/pool'
import { translateStage, type TranslateStageEvent } from './translate'

test('a cache that cannot be written is logged once and translation carries on', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'df-stage-'))
  const lib = new DocumentLibrary()
  await lib.open(dir)
  const pdf = join(dir, 'in.pdf')
  await writeFile(pdf, '%PDF-1.4')
  const created = await lib.create({
    path: pdf,
    translator: { providerId: 'fake', model: 'fake-model', label: '假服务商 · 假模型' },
    settingsSnapshot: defaultTranslationRuntime(),
  })
  const manifest = lib.require(created.id)
  const workDir = join(dir, 'work')
  // A directory where the cache file should go: every flush fails.
  await mkdir(join(workDir, 'translation-cache.json'), { recursive: true })
  const para = { y: 700, x: 72, x0: 72, x1: 100, y0: 700, y1: 710, size: 10, brk: false }
  const analysis: AnalysisResult = {
    version: 3,
    pages: 1,
    pageSizes: [[600, 800]],
    units: [
      {
        id: '0',
        page: 0,
        formPath: '',
        // Blank strings and pure formulas are not sent (converter worker()).
        texts: ['Hello', 'World', ' ', '{v0}'],
        paragraphs: [para, para, para, para],
        formulas: [],
        lines: [],
      },
    ],
    stats: { chars: 10, paragraphs: 4, translatable: 2, formulas: 0 },
  }
  const events: TranslateStageEvent[] = []
  const result = await translateStage({
    analysis,
    manifest,
    workDir,
    provider: fakeProvider(),
    pools: new TranslationPools(fakeFetch, () => undefined),
    signal: new AbortController().signal,
    onProgress: () => Promise.resolve(),
    onEvent: (event) => {
      events.push(event)
      return Promise.resolve()
    },
  })
  expect(result.translated).toBe(2)
  const warnings = events.filter((event) => event.message.includes('翻译缓存写入失败'))
  expect(warnings).toHaveLength(1)
  expect(warnings[0]?.level).toBe('warning')
})
