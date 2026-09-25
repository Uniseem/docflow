import { access } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { DocumentLibrary } from '../library/library'
import { Scheduler } from '../jobs/scheduler'
import { SettingsStore } from '../settings/settings'
import { memoryCryptor, SecretsStore } from '../settings/secrets'
import { TranslationPools } from '../translate/pool'
import { fakeFetch, fakeProvider } from '../translate/fake'
import { analyzePdf } from '../pdf/analyze'
import { composePdf } from '../pdf/compose'
import { inspectPdf } from '../pdf/inspect'
import { detectScanned } from '../pdf/scanned'
import { detectPage } from '../pdf/pdf2zh/detect'
import { fakeTranslations } from '../../../tests/unit/fake-translations'
import { LAYOUT_MODEL } from '../../../tests/unit/pdf2zh-reference'
import { verifyPdf } from '../pdf/verify'
import { bundledFonts, runPipeline, type PipelineHooks } from '../pipeline/run'
import { handleDocumentsCreate, type HandlerContext } from './handlers'
import type { DialogHost } from '../app/dialogs'

const fonts = bundledFonts()

function inProcessHooks(): PipelineHooks {
  return {
    inspect: (path) => inspectPdf(path),
    scan: (path, _pages, selected) => detectScanned(path, selected),
    // The real layout model in-process: MuPDF.js renders, onnxruntime-web detects.
    layout: async (path, pages, _selected, _signal, onPage) => {
      const layouts = []
      for (let i = 0; i < pages; i += 1) {
        layouts.push(await detectPage(path, i, LAYOUT_MODEL))
        await onPage(i + 1, pages)
      }
      return layouts
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
    compose: (input) =>
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
    pdfOptions: () => ({ fontFamily: 'auto', dualMode: 'side-by-side', dualTranslateFirst: false }),
    autoOcr: () => false,
  }
}

describe('documents:create smoke', () => {
  test('create enqueues a fixture and writes mono/dual PDFs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'df-smoke-'))
    const lib = new DocumentLibrary()
    await lib.open(dir)
    const settings = new SettingsStore(dir)
    await settings.load()
    await settings.replaceProviders([fakeProvider()])
    const secrets = new SecretsStore(dir, memoryCryptor())
    await secrets.load()
    const hooks = inProcessHooks()
    const scheduler = new Scheduler(lib, (id, signal) => runPipeline(lib, id, signal, hooks), {
      concurrency: () => 1,
    })
    const dialog: DialogHost = {
      showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
      showSaveDialog: () => Promise.resolve({ canceled: true }),
    }
    const ctx: HandlerContext = {
      library: lib,
      scheduler,
      settings,
      secrets,
      pools: new TranslationPools(fakeFetch, () => 'k'),
      dialog,
      fetch: fakeFetch,
      env: { DOCFLOW_FAKE_PROVIDERS: '1' },
      version: '4.0.0',
      platform: 'darwin',
      arch: 'arm64',
      logsDir: join(dir, 'logs'),
      getLibraryDir: () => dir,
      getTheme: () => 'system' as const,
      setTheme: () => Promise.resolve(),
      checkUpdates: () =>
        Promise.resolve({ latest: '4.0.0', url: 'https://example', newer: false }),
      changeLibrary: (path) => Promise.resolve(path),
      reveal: () => undefined,
      openPath: () => Promise.resolve(),
      openExternal: () => Promise.resolve(),
      sendChanged: () => undefined,
      sendRemoved: () => undefined,
      relaunch: () => undefined,
      exportedPaths: new Set(),
      takePendingFiles: () => [],
    }
    const created = await handleDocumentsCreate(ctx, {
      paths: [join(process.cwd(), 'tests/fixtures/colored-text.pdf')],
      translator: { providerId: 'fake', model: 'fake-model' },
      title: 'Color',
    })
    expect(created.failed).toHaveLength(0)
    const id = created.created[0]!.id
    await expect.poll(() => lib.require(id).status, { timeout: 60_000 }).toBe('completed')
    await access(join(dir, 'documents', id, 'output', 'mono.pdf'))
    await access(join(dir, 'documents', id, 'output', 'dual.pdf'))
    await scheduler.stop(0)
  }, 60_000)
})
