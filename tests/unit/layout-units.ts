// Builders for analysis data in unit tests: LTChars laid out left to right, parsed into a
// LayoutUnit by the real pdf2zh parser.
import type { AnalysisResult, FontFlags, LayoutUnit, LtChar } from '../../src/shared/pdf-types'
import { buildLayoutMap, type LayoutMap } from '../../src/main/pdf/pdf2zh/doclayout'
import { parseLayout, type LtItem } from '../../src/main/pdf/pdf2zh/parse'

export const SERIF: FontFlags = { bold: false, italic: false, monospace: false, serif: true }
export const BOLD_SERIF: FontFlags = { bold: true, italic: false, monospace: false, serif: true }
export const ITALIC_SERIF: FontFlags = { bold: false, italic: true, monospace: false, serif: true }

export function ltChar(text: string, x: number, y: number, extra: Partial<LtChar> = {}): LtItem {
  const size = extra.size ?? 10
  const width = extra.x1 !== undefined ? extra.x1 - x : 5
  return {
    kind: 'char',
    text,
    x0: x,
    y0: y,
    x1: x + width,
    y1: y + size,
    size,
    vertical: false,
    angle: 0,
    fontname: 'ABCDEF+NimbusRomNo9L-Regu',
    font: 'F1',
    code: text.codePointAt(0) ?? 0,
    codeBytes: 1,
    gstate: '',
    ...extra,
  }
}

/** Characters of `text` from x, 5 pt apart; a space skips a slot (pdf2zh adds the space). */
export function line(text: string, x: number, y: number, extra: Partial<LtChar> = {}): LtItem[] {
  const out: LtItem[] = []
  let at = x
  for (const c of text) {
    if (c === ' ') {
      at += 5
      continue
    }
    out.push(ltChar(c, at, y, extra))
    at += 5
  }
  return out
}

/** One text box over the whole page, named `label`. */
export function boxMap(label = 'plain text', width = 600, height = 800): LayoutMap {
  return buildLayoutMap({
    width,
    height,
    boxes: [{ name: label, conf: 0.9, xyxy: [0, 0, width, height] }],
  })
}

export function unitOf(
  items: readonly LtItem[],
  options: {
    page?: number
    id?: string
    map?: LayoutMap
    fonts?: Record<string, FontFlags>
  } = {},
): LayoutUnit {
  const page = options.page ?? 0
  const parsed = parseLayout(items, options.map ?? boxMap(), 600)
  const fonts: Record<string, FontFlags> = {}
  for (const style of parsed.styles) fonts[style.font] = options.fonts?.[style.font] ?? SERIF
  return { id: options.id ?? String(page), page, formPath: '', ...parsed, fonts }
}

export function analysisOf(units: readonly LayoutUnit[], pages?: number): AnalysisResult {
  const count = pages ?? Math.max(1, ...units.map((u) => u.page + 1))
  return {
    version: 5,
    pages: count,
    pageSizes: Array.from({ length: count }, () => [600, 800] as [number, number]),
    units: [...units],
    ocrWorkaround: false,
    stats: {
      chars: 0,
      paragraphs: units.reduce((n, u) => n + u.texts.length, 0),
      translatable: units.reduce((n, u) => n + u.texts.filter((t) => t.trim()).length, 0),
      formulas: units.reduce((n, u) => n + u.formulas.length, 0),
    },
  }
}

/** One layout box per paragraph, stacked from the top of a 600 × 800 page. */
export function stackedUnit(
  texts: ReadonlyArray<
    string | { text: string; label?: string; x?: number; y?: number; w?: number }
  >,
  page = 0,
): LayoutUnit {
  const rows = texts.map((t) => (typeof t === 'string' ? { text: t } : t))
  const boxes = rows.map((t, i) => {
    const top = t.y ?? 50 + i * 40
    const x = t.x ?? 0
    return {
      name: t.label ?? 'plain text',
      conf: 0.9 - i * 0.001,
      xyxy: [x, top, x + (t.w ?? 590), top + 30] as [number, number, number, number],
    }
  })
  const map = buildLayoutMap({ width: 600, height: 800, boxes })
  const items = rows.flatMap((t, i) =>
    line(t.text, (t.x ?? 0) + 5, 800 - (t.y ?? 50 + i * 40) - 20),
  )
  return unitOf(items, { map, page })
}
