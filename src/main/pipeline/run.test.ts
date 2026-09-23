import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { access } from 'node:fs/promises'
import { describe, expect, test } from 'vitest'
import type { AnalysisResult } from '../../shared/pdf-types'
import { defaultTranslationRuntime } from '../../shared/types'
import { analyzePdf } from '../pdf/analyze'
import { composePdf, defaultComposeOptions } from '../pdf/compose'
import { inspectPdf } from '../pdf/inspect'
import { verifyPdf } from '../pdf/verify'
import { DocumentLibrary } from '../library/library'
import { bundledFonts, composeWarningEvent, runPipeline, type PipelineHooks } from './run'

const fonts = bundledFonts()
const translator = { providerId: 'fake', model: 'fake-model', label: '假 · fake-model' }

describe('runPipeline', () => {
  test('inspect→analyze→fake translate→compose→verify writes output PDFs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'df-pipe-'))
    const lib = new DocumentLibrary()
    await lib.open(dir)
    const created = await lib.create({
      path: join(process.cwd(), 'tests/fixtures/colored-text.pdf'),
      title: 'Color',
      translator,
      settingsSnapshot: defaultTranslationRuntime(),
    })
    await lib.update(created.id, { status: 'processing' })
    await runPipeline(lib, created.id, new AbortController().signal, {
      inspect: (path) => inspectPdf(path),
      analyze: (path) => analyzePdf(path),
      translate: ({ analysis }) => {
        const translations = analysis.paragraphs.map((para) => ({
          id: para.id,
          text: para.translatable ? `译${para.text}` : para.text,
          kept: !para.translatable,
        }))
        return Promise.resolve({
          translations,
          usage: { input: 1, output: 1 },
          kept: translations.filter((t) => t.kept).length,
          translated: translations.filter((t) => !t.kept).length,
        })
      },
      compose: async (input) =>
        composePdf({
          sourcePath: input.sourcePath,
          monoPath: input.monoPath,
          dualPath: input.dualPath,
          analysis: input.analysis,
          translations: input.translations,
          fonts: input.fonts,
          options: { ...defaultComposeOptions(), minFontScale: input.minFontScale },
        }),
      verify: (input) =>
        verifyPdf({
          monoPath: input.monoPath,
          dualPath: input.dualPath,
          pages: input.pages,
          writtenPages: input.writtenPages,
        }),
      fonts,
      bilingual: () => true,
      minFontScale: () => 0.6,
    })
    await access(join(dir, 'documents', created.id, 'output', 'mono.pdf'))
    await access(join(dir, 'documents', created.id, 'output', 'dual.pdf'))
    const events = await lib.events.read(created.id)
    expect(events.items.some((e) => e.message.includes('校验通过'))).toBe(true)
    expect(lib.require(created.id).outputs.mono?.bytes).toBeGreaterThan(1024)
  }, 60_000)

  test('marks each stage when it starts and stops before archiving once aborted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'df-pipe-'))
    const lib = new DocumentLibrary()
    await lib.open(dir)
    const pdf = join(dir, 'in.pdf')
    await writeFile(pdf, '%PDF-1.4')
    const created = await lib.create({
      path: pdf,
      translator,
      settingsSnapshot: defaultTranslationRuntime(),
    })
    await lib.update(created.id, { status: 'processing' })
    const seen: string[] = []
    const hooks = fakeHooks((manifest) => seen.push(`${manifest.stage}:${manifest.progress}`))
    await runPipeline(lib, created.id, new AbortController().signal, hooks)
    const starts = [
      'inspect:3',
      'analyze:10',
      'translate:30',
      'compose:80',
      'verify:90',
      'archive:94',
    ]
    const positions = starts.map((entry) => seen.indexOf(entry))
    expect(positions.every((at) => at >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    expect(lib.require(created.id).outputs.mono?.bytes).toBe(4)

    const second = await lib.create({
      path: pdf,
      translator,
      settingsSnapshot: defaultTranslationRuntime(),
    })
    await lib.update(second.id, { status: 'processing' })
    const controller = new AbortController()
    const aborting: PipelineHooks = {
      ...fakeHooks(() => undefined),
      verify: () => {
        controller.abort()
        return Promise.resolve({
          monoPages: 1,
          dualPages: 2,
          sizeMismatches: 0,
          translatedPagesWithoutCjk: [],
        })
      },
    }
    await expect(runPipeline(lib, second.id, controller.signal, aborting)).rejects.toMatchObject({
      code: 'cancelled',
    })
    await access(join(dir, 'documents', second.id, 'work', 'mono.pdf'))
    expect(lib.require(second.id).outputs.mono).toBeNull()
  })
})

describe('composeWarningEvent', () => {
  const analysis = {
    paragraphs: [
      { id: '0-0', page: 0 },
      { id: '1-0', page: 1 },
      { id: '1-3', page: 1 },
    ],
  } as unknown as AnalysisResult

  test('numbers paragraphs by position on their page instead of internal ids', () => {
    expect(
      composeWarningEvent(
        { code: 'overflow', page: 1, paragraphId: '1-3', message: 'overflow' },
        analysis,
      ).message,
    ).toBe('第 2 页第 2 段译文超出原段落范围')
    expect(
      composeWarningEvent(
        { code: 'layout_failed', page: 1, paragraphId: 'gone', message: 'x' },
        analysis,
      ).message,
    ).toBe('第 2 页有一段排版失败，已保留原文')
  })

  test('every warning code reads as Chinese', () => {
    const codes = [
      'overflow',
      'layout_failed',
      'font_unmapped',
      'encode_failed',
      'page_skipped',
      'op_mismatch',
      'font_subset_fallback',
      'something_new',
    ]
    for (const code of codes) {
      const event = composeWarningEvent(
        { code, page: 0, paragraphId: '0-0', message: 'technical english text' },
        analysis,
      )
      expect(event.message, code).not.toMatch(/[A-Za-z]/)
    }
    expect(
      composeWarningEvent({ code: 'something_new', message: 'technical english text' }, analysis),
    ).toEqual({ message: '生成 PDF 时出现警告', detail: 'something_new: technical english text' })
  })
})

function fakeHooks(onChanged: NonNullable<PipelineHooks['onChanged']>): PipelineHooks {
  const analysis = {
    version: 2,
    pages: 1,
    pageSizes: [[612, 792]],
    paragraphs: [{ id: 'p0', page: 0, text: 'Hello', translatable: true }],
    fontMap: {},
    forms: [],
    stats: { glyphs: 5, lines: 1, paragraphs: 1, translatable: 1, runs: 0 },
  } as unknown as AnalysisResult
  return {
    inspect: () =>
      Promise.resolve({
        pages: 1,
        pageSizes: [[612, 792]],
        rotations: [0],
        textChars: 5,
        visibleTextChars: 5,
        hasTextLayer: true,
      }),
    analyze: () => Promise.resolve(analysis),
    translate: () =>
      Promise.resolve({
        translations: [{ id: 'p0', text: '你好', kept: false }],
        usage: { input: 1, output: 1 },
        kept: 0,
        translated: 1,
      }),
    compose: async (input) => {
      await writeFile(input.monoPath, 'mono')
      if (input.dualPath) await writeFile(input.dualPath, 'dual')
      return {
        monoBytes: 4,
        dualBytes: 4,
        paragraphsWritten: 1,
        paragraphsKept: 0,
        opsRemoved: 1,
        runsRedrawn: 0,
        warnings: [],
        writtenPages: [0],
      }
    },
    verify: () =>
      Promise.resolve({
        monoPages: 1,
        dualPages: 2,
        sizeMismatches: 0,
        translatedPagesWithoutCjk: [],
      }),
    fonts,
    bilingual: () => true,
    minFontScale: () => 0.6,
    onChanged,
  }
}
