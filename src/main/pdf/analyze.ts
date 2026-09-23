import { readFile } from 'node:fs/promises'
import { PDF } from '../../shared/pdf-constants'
import { AnalysisResult, type Glyph } from '../../shared/pdf-types'
import { extractPageGraphics } from './analyze/glyphs'
import { mergeLines } from './analyze/lines'
import { attachFormulas } from './analyze/formula'
import { assignColumns, columnSplitFits, detectColumnSplit, readingOrder } from './analyze/columns'
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
  // Two-column split of the last page that had one; reused where a figure hides a column.
  let lastSplit: { split: number; width: number } | undefined
  // Characters per font size (0.5 pt buckets) over the pages so far: a page that is mostly
  // figure must not decide what body text looks like.
  const sizeChars = new Map<number, number>()

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
    const detected = detectColumnSplit(withRuns, width)
    let split = detected
    if (
      split === undefined &&
      lastSplit &&
      Math.abs(lastSplit.width - width) < 1 &&
      columnSplitFits(withRuns, lastSplit.split)
    ) {
      split = lastSplit.split
    }
    if (detected !== undefined) lastSplit = { split: detected, width }
    const ordered = readingOrder(assignColumns(withRuns, split))
    for (const line of withRuns) {
      if (line.formulaLine) continue
      const bucket = Math.round(line.size * 2) / 2
      const chars = line.text.replace(/\{v\d+\}/g, '').length
      sizeChars.set(bucket, (sizeChars.get(bucket) ?? 0) + chars)
    }
    const pageParas = mergeParagraphs(
      ordered,
      height,
      width,
      inspection.rotations[i] ?? 0,
      graphics.imageRects,
      shared,
      modeOf(sizeChars),
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

function modeOf(counts: Map<number, number>): number | undefined {
  let best: number | undefined
  let bestCount = 0
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value
      bestCount = count
    }
  }
  return best
}

export function analyzeTimeoutMs(pages: number): number {
  return Math.max(PDF.TIMEOUT_ANALYZE_BASE_MS, pages * PDF.TIMEOUT_ANALYZE_PER_PAGE_MS)
}
