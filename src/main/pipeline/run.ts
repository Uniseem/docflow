import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { ERROR_CODES, UserError } from '../../shared/errors'
import type {
  AnalysisResult,
  ComposeResult,
  PdfInspection,
  TranslatedParagraph,
  VerifyResult,
} from '../../shared/pdf-types'
import type { DocumentManifest, ProcessingEvent, Stage } from '../../shared/types'
import type { DocumentLibrary } from '../library/library'
import { sourcePath, workDir } from '../library/manifest'
import { writeJsonAtomic } from '../settings/atomic-write'

export type TranslateOutcome = {
  translations: TranslatedParagraph[]
  usage: { input: number; output: number }
  kept: number
  translated: number
}

export type PipelineHooks = {
  inspect: (path: string, signal: AbortSignal) => Promise<PdfInspection>
  analyze: (path: string, pages: number, signal: AbortSignal) => Promise<AnalysisResult>
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
    fonts: { regular: string; bold: string }
    minFontScale: number
    signal: AbortSignal
  }) => Promise<ComposeResult & { writtenPages?: number[] }>
  verify: (input: {
    monoPath: string
    dualPath: string | null
    pages: number
    writtenPages: number[]
    signal: AbortSignal
  }) => Promise<VerifyResult>
  fonts: { regular: string; bold: string }
  bilingual: (manifest: DocumentManifest) => boolean
  minFontScale: (manifest: DocumentManifest) => number
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

  await enterStage('analyze', 10)
  const analysis = await withCheckpoint(
    join(work, 'analysis.json'),
    manifest.sourceSha256,
    async () => {
      throwIfAborted(signal)
      return hooks.analyze(src, inspection.pages, signal)
    },
  )
  const pagesWithout = new Set<number>()
  for (let i = 0; i < analysis.pages; i += 1) {
    if (!analysis.paragraphs.some((p) => p.page === i && p.translatable)) pagesWithout.add(i)
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
      message: `分析版面：识别到 ${analysis.stats.paragraphs} 个段落，其中 ${analysis.stats.translatable} 个待翻译，公式 ${analysis.stats.runs} 处`,
    },
    {
      stage: 'analyze',
      progress: 29,
      stats: {
        paragraphs: analysis.stats.paragraphs,
        translatable: analysis.stats.translatable,
        translated: 0,
        kept: 0,
        formulaRuns: analysis.stats.runs,
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
      message: `翻译完成：${translation.translated} 段，保留原文 ${translation.kept} 段，用量 输入 ${translation.usage.input} / 输出 ${translation.usage.output} tokens`,
    },
    {
      stage: 'translate',
      progress: 79,
      stats: {
        paragraphs: analysis.stats.paragraphs,
        translatable: analysis.stats.translatable,
        translated: translation.translated,
        kept: translation.kept,
        formulaRuns: analysis.stats.runs,
        opsRemoved: 0,
        usage: translation.usage,
      },
    },
  )

  const current = library.require(id)
  const bilingual = hooks.bilingual(current)
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
    minFontScale: hooks.minFontScale(current),
    signal,
  })
  for (const warning of composed.warnings) {
    await emit({
      stage: 'compose',
      level: 'warning',
      message: composeWarningMessage(warning),
    })
  }
  await emit(
    {
      stage: 'compose',
      level: 'info',
      progress: 89,
      message: `改写内容流：写入 ${composed.paragraphsWritten} 段译文，重绘公式 ${composed.runsRedrawn} 处，删除文字指令 ${composed.opsRemoved} 条`,
    },
    {
      stage: 'compose',
      progress: 89,
      stats: {
        paragraphs: analysis.stats.paragraphs,
        translatable: analysis.stats.translatable,
        translated: translation.translated,
        kept: translation.kept + composed.paragraphsKept,
        formulaRuns: analysis.stats.runs,
        opsRemoved: composed.opsRemoved,
        usage: translation.usage,
      },
    },
  )

  await enterStage('verify', 90)
  const verified = await hooks.verify({
    monoPath: monoWork,
    dualPath: bilingual ? dualWork : null,
    pages: analysis.pages,
    writtenPages: composed.writtenPages ?? [],
    signal,
  })
  await emit(
    {
      stage: 'verify',
      level: 'success',
      progress: 93,
      message: bilingual
        ? `校验通过：中文 PDF ${verified.monoPages} 页，双语 PDF ${verified.dualPages ?? verified.monoPages * 2} 页`
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
    },
  })
  hooks.onChanged?.(archived)
}

async function withCheckpoint<T>(path: string, sha: string, produce: () => Promise<T>): Promise<T> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as { sourceSha256?: string; data?: T }
    if (raw.sourceSha256 === sha && raw.data) return raw.data
  } catch {
    /* miss */
  }
  const data = await produce()
  await writeJsonAtomic(path, { sourceSha256: sha, data })
  return data
}

function composeWarningMessage(warning: ComposeResult['warnings'][number]): string {
  const page = (warning.page ?? 0) + 1
  if (warning.code === 'overflow')
    return `第 ${page} 页第 ${warning.paragraphId ?? ''} 段译文超出原段落范围`
  if (warning.code === 'layout_failed')
    return `第 ${page} 页第 ${warning.paragraphId ?? ''} 段排版失败，已保留原文`
  if (warning.code === 'page_skipped') return `第 ${page} 页有文字指令无法对应到段落，已跳过该页`
  if (warning.code === 'font_unmapped')
    return `第 ${page} 页第 ${warning.paragraphId ?? ''} 段的公式字体无法映射，已保留原文`
  return warning.message
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new UserError(ERROR_CODES.cancelled)
}

/** `root` is `<resources>/fonts` in a packaged app; tests and scripts run from the repo root. */
export function bundledFonts(root = join(process.cwd(), 'resources/fonts')): {
  regular: string
  bold: string
} {
  return {
    regular: join(root, 'NotoSansSC-Regular.otf'),
    bold: join(root, 'NotoSansSC-Bold.otf'),
  }
}
