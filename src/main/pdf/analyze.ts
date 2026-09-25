import { readFile } from 'node:fs/promises'
import { PDF } from '../../shared/pdf-constants'
import { PDFName, type PDFDict } from '@cantoo/pdf-lib'
import {
  AnalysisResult,
  type FontFlags,
  type Glyph,
  type LayoutUnit,
  type LtChar,
  type PageLayout,
} from '../../shared/pdf-types'
import { extractPageGraphics } from './analyze/glyphs'
import { inspectPdf } from './inspect'
import { loadPdfLib } from './load-pdf-lib'
import { openPdfDocument } from './pdfjs'
import { alignTextOps, toLtChar } from './pdf2zh/chars'
import { buildLayoutMap } from './pdf2zh/doclayout'
import { fontFlagsReader } from './pdf2zh/font-flags'
import { interpretPage } from './pdf2zh/interp'
import { lookupDict, pageSource } from './pdf2zh/pages'
import { parseLayout, type LtItem, type ParseOptions } from './pdf2zh/parse'
import { needsTranslation } from './pdf2zh/segments'
import { unicodeSource, type UnicodeSource } from './pdf2zh/unicode'

/**
 * pdf2zh translate_patch without the translation: for every page, the layout matrix from the
 * DocLayout-YOLO boxes, then receive_layout part A for the page and each form it draws.
 */
export type AnalyzeOptions = ParseOptions & {
  /** 0-based pages to analyse; the others are left as they are (BabelDOC pages option). */
  pages?: readonly number[] | null
  /** auto_enable_ocr_workaround (DetectScannedFile). */
  autoOcr?: boolean
}

export async function analyzePdf(
  path: string,
  layouts: readonly PageLayout[],
  options: AnalyzeOptions = {},
) {
  const wanted = options.pages ? new Set(options.pages) : null
  const parse: ParseOptions = options.strict === undefined ? {} : { strict: options.strict }
  const inspection = await inspectPdf(path)
  const bytes = await readFile(path)
  const doc = await openPdfDocument(bytes)
  const lib = await loadPdfLib(bytes)
  const libPages = lib.getPages()
  const units: LayoutUnit[] = []
  let chars = 0
  const sources = new WeakMap<PDFDict, UnicodeSource>()
  const flagsOf = await fontFlagsReader(lib)
  const fontDict = (resources: unknown, font: string): PDFDict | undefined => {
    const fonts = lookupDict(lib, (resources as PDFDict | undefined)?.get(PDFName.of('Font')))
    return fonts ? lookupDict(lib, fonts.get(PDFName.of(font))) : undefined
  }
  // pdfminer's text for a glyph: to_unichr through the font the operator selected.
  const textOf = (glyph: Glyph, resources: unknown, font: string): string => {
    const dict = fontDict(resources, font)
    const fallback = glyph.unicode || `(cid:${glyph.code})`
    if (!dict) return fallback
    let source = sources.get(dict)
    if (!source) {
      source = unicodeSource(lib, dict)
      sources.set(dict, source)
    }
    if (source === 'pdfjs') return fallback
    return source(glyph.code) ?? `(cid:${glyph.code})`
  }

  for (let i = 0; i < doc.numPages; i += 1) {
    if (wanted && !wanted.has(i)) continue
    const page = await doc.getPage(i + 1)
    const { glyphs } = await extractPageGraphics(page, i)
    page.cleanup()
    const libPage = libPages[i]
    if (!libPage) continue
    const source = pageSource(lib, libPage)
    const interp = interpretPage(
      source.content,
      source.ctm,
      source.width,
      source.getForm,
      source.resources,
    )
    const aligned = alignTextOps(glyphs, interp.textOps, source.ctm)
    const resourcesOf = new Map(interp.units.map((unit) => [unit.formPath, unit.resources]))

    const bySeq = new Map<number, LtChar[]>()
    // Glyphs of operators that could not be paired go to the end of their stream's items.
    const unaligned = new Map<string, LtChar[]>()
    for (const glyph of glyphs) {
      const op = aligned.get(glyph.opSeq)
      const char = op
        ? toLtChar(
            glyph,
            source.ctm,
            op.font,
            textOf(glyph, resourcesOf.get(op.formPath), op.font),
            op.gstate,
          )
        : toLtChar(glyph, source.ctm, '')
      if (op) push(bySeq, op.seq, char)
      else push(unaligned, glyph.formPath, char)
    }

    const layout = buildLayoutMap(
      layouts[i] ?? {
        width: Math.ceil(source.width),
        height: Math.ceil(source.height),
        boxes: [],
      },
    )
    for (const unit of interp.units) {
      const items: LtItem[] = []
      for (const event of unit.events) {
        if (event.kind === 'line') items.push({ kind: 'line', ...event.line })
        else for (const char of bySeq.get(event.seq) ?? []) items.push({ kind: 'char', ...char })
      }
      for (const char of unaligned.get(unit.formPath) ?? []) items.push({ kind: 'char', ...char })
      chars += items.filter((item) => item.kind === 'char').length
      const parsed = parseLayout(items, layout, unit.width, parse)
      const fonts: Record<string, FontFlags> = {}
      for (const style of parsed.styles) {
        if (style.font && !(style.font in fonts)) {
          fonts[style.font] = flagsOf(fontDict(unit.resources, style.font))
        }
      }
      units.push({
        id: unit.formPath ? `${i}/${unit.formPath}` : String(i),
        page: i,
        formPath: unit.formPath,
        ...parsed,
        fonts,
      })
    }
  }
  await doc.cleanup()

  const texts = units.flatMap((unit) => unit.texts)
  return AnalysisResult.parse({
    version: 5,
    pages: inspection.pages,
    pageSizes: inspection.pageSizes,
    units,
    stats: {
      chars,
      paragraphs: texts.length,
      translatable: texts.filter(needsTranslation).length,
      formulas: units.reduce((n, unit) => n + unit.formulas.length, 0),
    },
  })
}

function push<K>(map: Map<K, LtChar[]>, key: K, char: LtChar): void {
  const list = map.get(key)
  if (list) list.push(char)
  else map.set(key, [char])
}

export function analyzeTimeoutMs(pages: number): number {
  return Math.max(PDF.TIMEOUT_ANALYZE_BASE_MS, pages * PDF.TIMEOUT_ANALYZE_PER_PAGE_MS)
}
