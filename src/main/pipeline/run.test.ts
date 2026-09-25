import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { access } from 'node:fs/promises'
import { describe, expect, test } from 'vitest'
import type { AnalysisResult } from '../../shared/pdf-types'
import { defaultTranslationRuntime } from '../../shared/types'
import { fakeTranslations } from '../../../tests/unit/fake-translations'
import { fixture, referenceLayouts } from '../../../tests/unit/pdf2zh-reference'
import { analyzePdf } from '../pdf/analyze'
import { composePdf } from '../pdf/compose'
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
      path: fixture('colored-text'),
      title: 'Color',
      translator,
      settingsSnapshot: defaultTranslationRuntime(),
    })
    await lib.update(created.id, { status: 'processing' })
    await runPipeline(lib, created.id, new AbortController().signal, {
      inspect: (path) => inspectPdf(path),
      layout: async (_path, pages, _selected, _signal, onPage) => {
        for (let i = 1; i <= pages; i += 1) await onPage(i, pages)
        return referenceLayouts('colored-text')
      },
      analyze: (path, layouts) => analyzePdf(path, layouts),
      translate: ({ analysis }) => {
        const translations = fakeTranslations(analysis)
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
          options: input.options,
        }),
      verify: (input) =>
        verifyPdf({
          monoPath: input.monoPath,
          dualPath: input.dualPath,
          pages: input.pages,
          writtenPages: input.writtenPages,
          dualMode: input.dualMode,
        }),
      fonts,
      bilingual: () => true,
      pdfOptions: () => ({
        fontFamily: 'auto',
        dualMode: 'side-by-side',
        dualTranslateFirst: false,
      }),
      autoOcr: () => false,
    })
    await access(join(dir, 'documents', created.id, 'output', 'mono.pdf'))
    await access(join(dir, 'documents', created.id, 'output', 'dual.pdf'))
    const events = await lib.events.read(created.id)
    expect(events.items.some((e) => e.message.includes('校验通过'))).toBe(true)
    expect(events.items.some((e) => e.message === '版面检测 1 / 1 页')).toBe(true)
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

describe('page selection (BabelDOC pages)', () => {
  test('only the chosen pages are laid out, and a range past the end fails at once', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'df-pages-'))
    const lib = new DocumentLibrary()
    await lib.open(dir)
    const pdf = join(dir, 'in.pdf')
    await writeFile(pdf, '%PDF-1.4')
    const created = await lib.create({
      path: pdf,
      translator,
      settingsSnapshot: defaultTranslationRuntime(),
      options: { pages: '2-' },
    })
    await lib.update(created.id, { status: 'processing' })
    const seen: Array<number[] | null> = []
    let composed: unknown
    const hooks = fakeHooks(() => undefined)
    await runPipeline(lib, created.id, new AbortController().signal, {
      ...hooks,
      inspect: () =>
        Promise.resolve({
          pages: 3,
          pageSizes: [
            [612, 792],
            [612, 792],
            [612, 792],
          ],
          rotations: [0, 0, 0],
          textChars: 5,
          visibleTextChars: 5,
          hasTextLayer: true,
        }),
      layout: (_path, pages, selected) => {
        seen.push(selected)
        return Promise.resolve(
          Array.from({ length: pages }, () => ({ width: 612, height: 792, boxes: [] })),
        )
      },
      compose: (input) => {
        composed = input.options
        return hooks.compose(input)
      },
    })
    expect(seen).toEqual([[1, 2]])
    expect(composed).toMatchObject({ pages: [1, 2], onlyTranslatedPages: false })

    const outside = await lib.create({
      path: pdf,
      translator,
      settingsSnapshot: defaultTranslationRuntime(),
      options: { pages: '9' },
    })
    await lib.update(outside.id, { status: 'processing' })
    await expect(
      runPipeline(
        lib,
        outside.id,
        new AbortController().signal,
        fakeHooks(() => undefined),
      ),
    ).rejects.toMatchObject({ code: 'pages_out_of_range' })
  })
})

describe('composeWarningEvent', () => {
  test('every warning code reads as Chinese', () => {
    for (const code of ['font_unmapped', 'paragraph_not_fit', 'something_new']) {
      const event = composeWarningEvent({ code, page: 0, message: 'technical english text' })
      expect(event.message, code).not.toMatch(/[A-Za-z]/)
    }
    expect(composeWarningEvent({ code: 'font_unmapped', page: 1, message: 'x' }).message).toBe(
      '第 2 页有公式字符找不到原字体，未能重画',
    )
    expect(composeWarningEvent({ code: 'paragraph_not_fit', page: 0, message: 'x' }).message).toBe(
      '第 1 页有段落在任何字号下都放不下，没有写入译文',
    )
    expect(
      composeWarningEvent({ code: 'something_new', message: 'technical english text' }),
    ).toEqual({
      message: '生成 PDF 时出现警告',
      detail: 'something_new: technical english text',
    })
  })
})

function fakeHooks(onChanged: NonNullable<PipelineHooks['onChanged']>): PipelineHooks {
  const analysis: AnalysisResult = {
    version: 5,
    pages: 1,
    ocrWorkaround: false,
    pageSizes: [[612, 792]],
    units: [
      {
        id: '0',
        page: 0,
        formPath: '',
        texts: ['Hello'],
        paragraphs: [
          {
            y: 700,
            x: 72,
            x0: 72,
            x1: 100,
            y0: 700,
            y1: 710,
            size: 10,
            brk: false,
            gstate: null,
          },
        ],
        formulas: [],
        lines: [],
        infos: [{ label: 'plain text', layoutBox: null, items: [] }],
        styles: [],
        fonts: {},
      },
    ],
    stats: { chars: 5, paragraphs: 1, translatable: 1, formulas: 0 },
  }
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
    layout: () => Promise.resolve([{ width: 612, height: 792, boxes: [] }]),
    analyze: () => Promise.resolve(analysis),
    translate: () =>
      Promise.resolve({
        translations: [{ id: '0#0', text: '你好', kept: false }],
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
    pdfOptions: () => ({ fontFamily: 'auto', dualMode: 'side-by-side', dualTranslateFirst: false }),
    autoOcr: () => false,
    onChanged,
  }
}
