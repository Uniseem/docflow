import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { access } from 'node:fs/promises'
import { describe, expect, test } from 'vitest'
import { defaultTranslationRuntime } from '../../shared/types'
import { analyzePdf } from '../pdf/analyze'
import { composePdf, defaultComposeOptions } from '../pdf/compose'
import { inspectPdf } from '../pdf/inspect'
import { verifyPdf } from '../pdf/verify'
import { DocumentLibrary } from '../library/library'
import { bundledFonts, runPipeline } from './run'

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
})
