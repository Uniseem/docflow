import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { ERROR_CODES, UserError } from '../../shared/errors'
import {
  AnalysisResult,
  PageLayout,
  type ComposeOptions,
  type ComposeResult,
  type PdfInspection,
  type TranslatedParagraph,
  type VerifyResult,
} from '../../shared/pdf-types'
import { selectedPages } from '../../shared/pages'
import { DOCLAYOUT_MODEL_FILE } from '../pdf/pdf2zh/doclayout'
import { needsTranslation } from '../pdf/pdf2zh/segments'
import type { DocumentManifest, ProcessingEvent, Stage } from '../../shared/types'
import type { DocumentLibrary } from '../library/library'
import { sourcePath, workDir } from '../library/manifest'
import { writeJsonAtomic } from '../settings/atomic-write'
import { GLOSSARY_FILE } from './stages/translate'

export type TranslateOutcome = {
  translations: TranslatedParagraph[]
  usage: { input: number; output: number }
  kept: number
  translated: number
  /** Entries of the automatic glossary written to work/glossary.csv, or null. */
  glossaryEntries?: number | null
}

export type PipelineHooks = {
  inspect: (path: string, signal: AbortSignal) => Promise<PdfInspection>
  /** DocLayout-YOLO boxes for every page (raster window + model). */
  layout: (
    path: string,
    pages: number,
    selected: number[] | null,
    signal: AbortSignal,
    onPage: (done: number, total: number) => Promise<void>,
  ) => Promise<PageLayout[]>
  analyze: (
    path: string,
    layouts: PageLayout[],
    pages: number,
    selected: number[] | null,
    autoOcr: boolean,
    signal: AbortSignal,
  ) => Promise<AnalysisResult>
  translate: (input: {
    analysis: AnalysisResult
    manifest: DocumentManifest
    workDir: string
    signal: AbortSignal
    onProgress: (done: number, total: number) => Promise<void>
  }) => Promise<TranslateOutcome>
  compose: (input: {
    sourcePath: string
    monoPath: string
    dualPath: string | null
    analysis: AnalysisResult
    translations: TranslatedParagraph[]
    fonts: { dir: string }
    options: ComposeOptions
    signal: AbortSignal
  }) => Promise<ComposeResult & { writtenPages?: number[]; monoPages?: number }>
  verify: (input: {
    monoPath: string
    dualPath: string | null
    pages: number
    writtenPages: number[]
    dualMode: ComposeOptions['dualMode']
    signal: AbortSignal
  }) => Promise<VerifyResult>
  fonts: { dir: string }
  bilingual: (manifest: DocumentManifest) => boolean
  /** The PDF settings compose uses (read when the stage runs, like `bilingual`). */
  pdfOptions: () => Pick<ComposeOptions, 'fontFamily' | 'dualMode' | 'dualTranslateFirst'>
  /** auto_enable_ocr_workaround */
  autoOcr: () => boolean
  onChanged?: (manifest: DocumentManifest) => void
}

export async function runPipeline(
  library: DocumentLibrary,
  id: string,
  signal: AbortSignal,
  hooks: PipelineHooks,
): Promise<void> {
  throwIfAborted(signal)
  const manifest = library.require(id)
  const src = sourcePath(library.dir, id)
  const work = workDir(library.dir, id)
  await mkdir(work, { recursive: true })

  const processing = (current: DocumentManifest) => current.status === 'processing'
  const emit = async (
    event: Omit<ProcessingEvent, 'seq' | 'at'> & { at?: string },
    patch?: Partial<DocumentManifest>,
  ) => {
    await library.events.append(id, event)
    // Only while processing: a cancelled document must not be revived by a late write.
    const next = await library.updateWhen(id, processing, patch ?? {})
    if (next) hooks.onChanged?.(next)
  }
  // Stage and progress are written when a stage starts (manifest only, no event), so the
  // list and a failure icon point at the stage that is actually running.
  const enterStage = async (stage: Stage, progress: number) => {
    const next = await library.updateWhen(id, processing, { stage, progress })
    if (next) hooks.onChanged?.(next)
  }

  await enterStage('inspect', 3)
  const inspection = await withCheckpoint(
    join(work, 'inspection.json'),
    manifest.sourceSha256,
    async () => {
      throwIfAborted(signal)
      return hooks.inspect(src, signal)
    },
  )
  await library.update(id, (current: DocumentManifest) =>
    !current.titleCustom && inspection.title
      ? { title: inspection.title.slice(0, 300), pages: inspection.pages }
      : { pages: inspection.pages },
  )
  await emit(
    {
      stage: 'inspect',
      level: 'info',
      progress: 9,
      message: `检查 PDF：${inspection.pages} 页`,
    },
    { stage: 'inspect', progress: 9, pages: inspection.pages },
  )

  const selected = selectedPages(manifest.options?.pages, inspection.pages)
  if (selected && selected.length === 0) throw new UserError(ERROR_CODES.pages_out_of_range)
  // Checkpoints hold the chosen pages only: another choice computes them again.
  const scope = `${manifest.sourceSha256}:${selected ? selected.join(',') : 'all'}`
  await enterStage('analyze', 10)
  const layouts = await withCheckpoint(
    join(work, 'layout.json'),
    scope,
    async () => {
      throwIfAborted(signal)
      return hooks.layout(src, inspection.pages, selected, signal, async (done, total) => {
        const progress = 10 + Math.round((done / Math.max(1, total)) * 15)
        await emit(
          {
            stage: 'analyze',
            level: 'info',
            progress,
            current: done,
            total,
            message: `版面检测 ${done} / ${total} 页`,
          },
          { stage: 'analyze', progress },
        )
      })
    },
    (data) => PageLayout.array().safeParse(data).success,
  )
  const analysis = await withCheckpoint(
    join(work, 'analysis.json'),
    `${scope}:${hooks.autoOcr() ? 'ocr' : ''}`,
    async () => {
      throwIfAborted(signal)
      return hooks.analyze(src, layouts, inspection.pages, selected, hooks.autoOcr(), signal)
    },
    (data) => AnalysisResult.safeParse(data).success,
  )
  if (analysis.ocrWorkaround) {
    await emit({
      stage: 'analyze',
      level: 'info',
      message: '这是带文字层的扫描件：译文用黑色写在白底上（OCR workaround）',
    })
  }
  const pagesWithout = new Set<number>()
  for (let i = 0; i < analysis.pages; i += 1) {
    if (selected && !selected.includes(i)) continue
    const texts = analysis.units.filter((unit) => unit.page === i).flatMap((unit) => unit.texts)
    if (!texts.some(needsTranslation)) pagesWithout.add(i)
  }
  for (const page of pagesWithout) {
    await emit({
      stage: 'analyze',
      level: 'warning',
      message: `第 ${page + 1} 页没有识别到可翻译段落`,
    })
  }
  if (analysis.stats.translatable === 0) throw new UserError(ERROR_CODES.no_paragraphs)
  await emit(
    {
      stage: 'analyze',
      level: 'info',
      progress: 29,
      message: `分析版面：识别到 ${analysis.stats.paragraphs} 个段落，其中 ${analysis.stats.translatable} 个待翻译，公式 ${analysis.stats.formulas} 处`,
    },
    {
      stage: 'analyze',
      progress: 29,
      stats: {
        paragraphs: analysis.stats.paragraphs,
        translatable: analysis.stats.translatable,
        translated: 0,
        kept: 0,
        formulaRuns: analysis.stats.formulas,
        opsRemoved: 0,
        usage: { input: 0, output: 0 },
      },
    },
  )

  await enterStage('translate', 30)
  const translation = await hooks.translate({
    analysis,
    manifest: library.require(id),
    workDir: work,
    signal,
    onProgress: async (done, total) => {
      const progress = 30 + Math.round((done / Math.max(1, total)) * 49)
      await emit(
        {
          stage: 'translate',
          level: 'info',
          progress,
          current: done,
          total,
          message: `已翻译 ${done} / ${total} 段`,
        },
        { stage: 'translate', progress },
      )
    },
  })
  await emit(
    {
      stage: 'translate',
      level: 'success',
      progress: 79,
      message: `翻译完成：${translation.translated} 段，保留原文 ${translation.kept} 段，用量 输入 ${translation.usage.input} / 输出 ${translation.usage.output} tokens${translation.glossaryEntries ? `，术语表 ${translation.glossaryEntries} 条` : ''}`,
    },
    {
      stage: 'translate',
      progress: 79,
      stats: {
        paragraphs: analysis.stats.paragraphs,
        translatable: analysis.stats.translatable,
        translated: translation.translated,
        kept: translation.kept,
        formulaRuns: analysis.stats.formulas,
        opsRemoved: 0,
        usage: translation.usage,
      },
    },
  )

  const current = library.require(id)
  const bilingual = hooks.bilingual(current)
  const composeOptions = hooks.pdfOptions()
  const monoWork = join(work, 'mono.pdf')
  const dualWork = join(work, 'dual.pdf')
  await enterStage('compose', 80)
  const composed = await hooks.compose({
    sourcePath: src,
    monoPath: monoWork,
    dualPath: bilingual ? dualWork : null,
    analysis,
    translations: translation.translations,
    fonts: hooks.fonts,
    options: {
      ...composeOptions,
      pages: selected,
      onlyTranslatedPages: Boolean(current.options?.onlyTranslatedPages && selected),
    },
    signal,
  })
  for (const warning of composed.warnings) {
    await emit({ stage: 'compose', level: 'warning', ...composeWarningEvent(warning) })
  }
  await emit(
    {
      stage: 'compose',
      level: 'info',
      progress: 89,
      message: `改写内容流：删除原文文字指令 ${composed.opsRemoved} 条，写入 ${composed.paragraphsWritten} 段译文，原样重绘公式 ${composed.runsRedrawn} 处`,
    },
    {
      stage: 'compose',
      progress: 89,
      stats: {
        paragraphs: analysis.stats.paragraphs,
        translatable: analysis.stats.translatable,
        translated: translation.translated,
        kept: translation.kept + composed.paragraphsKept,
        formulaRuns: analysis.stats.formulas,
        opsRemoved: composed.opsRemoved,
        usage: translation.usage,
      },
    },
  )

  await enterStage('verify', 90)
  const verified = await hooks.verify({
    monoPath: monoWork,
    dualPath: bilingual ? dualWork : null,
    pages: composed.monoPages ?? analysis.pages,
    writtenPages: composed.writtenPages ?? [],
    dualMode: composeOptions.dualMode,
    signal,
  })
  await emit(
    {
      stage: 'verify',
      level: 'success',
      progress: 93,
      message: bilingual
        ? `校验通过：中文 PDF ${verified.monoPages} 页，双语 PDF ${verified.dualPages ?? verified.monoPages} 页`
        : `校验通过：中文 PDF ${verified.monoPages} 页`,
    },
    { stage: 'verify', progress: 93 },
  )

  // Point of no return: from here the outputs replace work/, so a cancel is refused
  // (Scheduler.cancel checks the archive stage) and a shutdown lets the stage finish.
  await enterStage('archive', 94)
  throwIfAborted(signal)
  const outDir = join(library.dir, 'documents', id, 'output')
  await mkdir(outDir, { recursive: true })
  await rename(monoWork, join(outDir, 'mono.pdf'))
  let dualBytes: number | null = null
  if (bilingual) {
    await rename(dualWork, join(outDir, 'dual.pdf'))
    dualBytes = (await stat(join(outDir, 'dual.pdf'))).size
  }
  const monoBytes = (await stat(join(outDir, 'mono.pdf'))).size
  let glossaryBytes: number | null = null
  if (translation.glossaryEntries) {
    await rename(join(work, GLOSSARY_FILE), join(outDir, GLOSSARY_FILE))
    glossaryBytes = (await stat(join(outDir, GLOSSARY_FILE))).size
  }
  await rm(work, { recursive: true, force: true })
  await library.events.append(id, {
    stage: 'archive',
    level: 'success',
    progress: 100,
    message: '已保存到文档库',
  })
  // The files are in output/ whatever the status is now: always record them.
  const archived = await library.update(id, {
    stage: 'archive',
    progress: 100,
    outputs: {
      mono: { bytes: monoBytes },
      dual: dualBytes === null ? null : { bytes: dualBytes },
      glossary: glossaryBytes === null ? null : { bytes: glossaryBytes },
    },
  })
  hooks.onChanged?.(archived)
}

async function withCheckpoint<T>(
  path: string,
  sha: string,
  produce: () => Promise<T>,
  valid: (data: unknown) => boolean = () => true,
): Promise<T> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as { sourceSha256?: string; data?: T }
    // A checkpoint written by an older version has another shape: produce it again.
    if (raw.sourceSha256 === sha && raw.data && valid(raw.data)) return raw.data
  } catch {
    /* miss */
  }
  const data = await produce()
  await writeJsonAtomic(path, { sourceSha256: sha, data })
  return data
}

/** Processing-record text for a compose warning; unknown codes keep their text as `detail`. */
export function composeWarningEvent(warning: ComposeResult['warnings'][number]): {
  message: string
  detail?: string
} {
  const page = `第 ${(warning.page ?? 0) + 1} 页`
  switch (warning.code) {
    case 'font_unmapped':
      return { message: `${page}有公式字符找不到原字体，未能重画` }
    case 'paragraph_not_fit':
      return { message: `${page}有段落在任何字号下都放不下，没有写入译文` }
    default:
      return {
        message: warning.page === undefined ? '生成 PDF 时出现警告' : `${page}生成时出现警告`,
        detail: `${warning.code}: ${warning.message}`,
      }
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new UserError(ERROR_CODES.cancelled)
}

/** `root` is `<resources>/fonts` in a packaged app; tests and scripts run from the repo root. */
export function bundledFonts(root = join(process.cwd(), 'resources/fonts')): { dir: string } {
  return { dir: root }
}

/** DocLayout-YOLO; `root` is `<resources>/models` in a packaged app. */
export function bundledModel(root = join(process.cwd(), 'resources/models')): string {
  return join(root, DOCLAYOUT_MODEL_FILE)
}
