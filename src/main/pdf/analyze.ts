import { readFile } from 'node:fs/promises'
import { PDF } from '../../shared/pdf-constants'
import { AnalysisResult, type Glyph } from '../../shared/pdf-types'
import { extractPageGraphics } from './analyze/glyphs'
import { mergeLines } from './analyze/lines'
import { attachFormulas } from './analyze/formula'
import { assignColumns, readingOrder } from './analyze/columns'
import { mergeParagraphs } from './analyze/paragraphs'
import { scanFormRefs } from './forms'
import { openPdfDocument } from './pdfjs'
import { inspectPdf } from './inspect'

export async function analyzePdf(path: string) {
  const inspection = await inspectPdf(path)
  const bytes = await readFile(path)
  const forms = await scanFormRefs(bytes)
  const doc = await openPdfDocument(bytes)
  const paragraphs = []
  const fontMap: AnalysisResult['fontMap'] = {}
  let glyphCount = 0
  let lineCount = 0
  let runCount = 0
  const formStats = forms.stats

  for (let i = 0; i < doc.numPages; i += 1) {
    const page = await doc.getPage(i + 1)
    const graphics = await extractPageGraphics(page, i)
    glyphCount += graphics.glyphs.length
    for (const g of graphics.glyphs) {
      fontMap[g.fontKey] ??= {
        family: g.fontFamily,
        composite: g.composite,
        codeBytes: g.codeBytes,
        type3: g.type3,
      }
    }
    const shared = forms.sharedPaths.get(i) ?? new Set<string>()
    const lines = mergeLines(graphics.glyphs, shared)
    lineCount += lines.length
    const withRuns = attachFormulas(lines)
    runCount += withRuns.reduce((n, line) => n + line.runs.length, 0)
    const width = inspection.pageSizes[i]?.[0] ?? 612
    const height = inspection.pageSizes[i]?.[1] ?? 792
    const ordered = readingOrder(assignColumns(withRuns, width))
    const pageParas = mergeParagraphs(
      ordered,
      height,
      width,
      inspection.rotations[i] ?? 0,
      graphics.imageRects,
      shared,
    )
    paragraphs.push(...pageParas)
    for (const stat of formStats.filter((row) => row.page === i)) {
      stat.glyphs = graphics.glyphs.filter((g: Glyph) => g.formPath === stat.formPath).length
    }
    page.cleanup()
  }
  await doc.cleanup()

  return AnalysisResult.parse({
    version: 2,
    pages: inspection.pages,
    pageSizes: inspection.pageSizes,
    paragraphs,
    fontMap,
    forms: formStats,
    stats: {
      glyphs: glyphCount,
      lines: lineCount,
      paragraphs: paragraphs.length,
      translatable: paragraphs.filter((p) => p.translatable).length,
      runs: runCount,
    },
  })
}

export function analyzeTimeoutMs(pages: number): number {
  return Math.max(PDF.TIMEOUT_ANALYZE_BASE_MS, pages * PDF.TIMEOUT_ANALYZE_PER_PAGE_MS)
}
