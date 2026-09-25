import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  defaultTranslationRuntime,
  PdfSettings,
  type TranslationRuntime,
} from '../../../shared/types'
import { analysisOf, line, unitOf } from '../../../../tests/unit/layout-units'
import { buildLayoutMap } from '../../pdf/pdf2zh/doclayout'
import { DocumentLibrary } from '../../library/library'
import { fakeFetch, fakeProvider } from '../../translate/fake'
import type { FetchFn } from '../../translate/http'
import { TranslationPools } from '../../translate/pool'
import { GLOSSARY_FILE, glossaryPath, translateStage, type TranslateStageEvent } from './translate'

const pdfSettings = PdfSettings.parse({})

async function setup(runtime: Partial<TranslationRuntime> = {}, glossaryIds: string[] = []) {
  const dir = await mkdtemp(join(tmpdir(), 'df-stage-'))
  const lib = new DocumentLibrary()
  await lib.open(dir)
  const pdf = join(dir, 'in.pdf')
  await writeFile(pdf, '%PDF-1.4')
  const created = await lib.create({
    path: pdf,
    translator: { providerId: 'fake', model: 'fake-model', label: '假服务商 · 假模型' },
    settingsSnapshot: { ...defaultTranslationRuntime(), ...runtime },
    options: { glossaryIds },
  })
  const map = buildLayoutMap({
    width: 600,
    height: 800,
    boxes: [
      { name: 'plain text', conf: 0.9, xyxy: [0, 80, 600, 110] },
      { name: 'plain text', conf: 0.8, xyxy: [0, 380, 600, 410] },
    ],
  })
  const unit = unitOf(
    [...line('Hello world from the LLM', 10, 700), ...line('Other text', 10, 400)],
    {
      map,
    },
  )
  return { dir, lib, manifest: lib.require(created.id), analysis: analysisOf([unit]) }
}

function capturing(): { fetch: FetchFn; prompts: string[] } {
  const prompts: string[] = []
  const fetch: FetchFn = (input, init) => {
    const body =
      typeof init?.body === 'string'
        ? (JSON.parse(init.body) as { messages?: Array<{ content: string }> })
        : {}
    const last = body.messages?.at(-1)?.content
    if (last) prompts.push(last)
    return fakeFetch(input, init)
  }
  return { fetch, prompts }
}

describe('translateStage', () => {
  test('a cache that cannot be written is logged once and translation carries on', async () => {
    const { dir, lib, manifest, analysis } = await setup()
    const workDir = join(dir, 'work')
    // A directory where the cache file should go: every flush fails.
    await mkdir(join(workDir, 'translation-cache.json'), { recursive: true })
    const events: TranslateStageEvent[] = []
    const result = await translateStage({
      analysis,
      manifest,
      workDir,
      libraryDir: lib.dir,
      provider: fakeProvider(),
      pools: new TranslationPools(fakeFetch, () => undefined),
      pdf: pdfSettings,
      glossaries: [],
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

  test('user glossaries of the document reach the prompt when auto extraction is off', async () => {
    const { dir, lib, manifest, analysis } = await setup({ autoExtractGlossary: false }, ['g1'])
    const csv = glossaryPath(lib.dir, 'g1')
    await mkdir(join(csv, '..'), { recursive: true })
    await writeFile(csv, 'source,target\nLLM,大语言模型\n')
    const { fetch, prompts } = capturing()
    const workDir = join(dir, 'work')
    await mkdir(workDir, { recursive: true })
    const result = await translateStage({
      analysis,
      manifest,
      workDir,
      libraryDir: lib.dir,
      provider: fakeProvider(),
      pools: new TranslationPools(fetch, () => undefined),
      pdf: pdfSettings,
      glossaries: [{ id: 'g1', name: 'chemistry', enabled: true, entries: 1 }],
      signal: new AbortController().signal,
      onProgress: () => Promise.resolve(),
      onEvent: () => Promise.resolve(),
    })
    expect(result.glossaryEntries).toBeNull()
    expect(
      prompts.some(
        (p) => p.includes('### Glossary: chemistry') && p.includes('| LLM | 大语言模型 |'),
      ),
    ).toBe(true)
  })

  test('the automatic glossary is extracted first and saved as glossary.csv', async () => {
    const { dir, lib, manifest, analysis } = await setup()
    const prompts: string[] = []
    const fetch: FetchFn = (input, init) => {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
        messages: Array<{ content: string }>
      }
      const prompt = body.messages.at(-1)!.content
      prompts.push(prompt)
      if (prompt.includes('Input Text:\n```\n')) {
        const reply = JSON.stringify([{ src: 'LLM', tgt: '大语言模型' }])
        return Promise.resolve(
          new Response(
            JSON.stringify({ choices: [{ message: { content: reply }, finish_reason: 'stop' }] }),
            {
              headers: { 'content-type': 'application/json' },
            },
          ),
        )
      }
      return fakeFetch(input, init)
    }
    const workDir = join(dir, 'work')
    await mkdir(workDir, { recursive: true })
    const result = await translateStage({
      analysis,
      manifest,
      workDir,
      libraryDir: lib.dir,
      provider: fakeProvider(),
      pools: new TranslationPools(fetch, () => undefined),
      pdf: pdfSettings,
      glossaries: [],
      signal: new AbortController().signal,
      onProgress: () => Promise.resolve(),
      onEvent: () => Promise.resolve(),
    })
    expect(result.glossaryEntries).toBe(1)
    expect(prompts[0]).toContain('You are an expert multilingual terminologist.')
    const batch = prompts.find((p) => p.includes('## Here is the input:'))!
    expect(batch).toContain('### Glossary: auto_extracted_glossary')
    const saved = await readFile(join(workDir, GLOSSARY_FILE), 'utf8')
    expect(saved).toBe('\ufeffsource,target,tgt_lng\r\nLLM,大语言模型,\r\n')
  })
})
