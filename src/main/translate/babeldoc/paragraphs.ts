// BabelDOC's view of pdf2zh's paragraphs (ADR-0018): the compositions StylesAndFormulas
// produces (same-style character runs and formulas), the base style, the paragraph unicode,
// and the paragraph_helper filters.
import type {
  AnalysisResult,
  BaseStyle,
  CharStyle,
  LayoutUnit,
  Pdf2zhFormula,
  TextChar,
} from '../../../shared/pdf-types'
import { segmentId } from '../../pdf/pdf2zh/segments'
import { isPySpace, normalizeSpaces, pyStrip } from './text'

/** A glyph as layout_helper sees it; `dummy` glyphs have no pdf_character_id. */
export type CharLike = {
  text: string
  x0: number
  y0: number
  x1: number
  y1: number
  dummy?: boolean | undefined
}

export type Run = {
  kind: 'run'
  /** current_style: the style of the run's first character. */
  style: CharStyle
  /** Items [from, to) of the paragraph. */
  from: number
  to: number
  chars: TextChar[]
}

export type FormulaComp = { kind: 'formula'; index: number; formula: Pdf2zhFormula }

export type Composition = Run | FormulaComp

export type BdParagraph = {
  id: string
  unit: LayoutUnit
  index: number
  page: number
  label: string | null
  /** box.y2 */
  top: number
  /** get_paragraph_unicode */
  unicode: string
  compositions: Composition[]
  base: BaseStyle | null
}

/** Layout.is_newline */
export function isNewline(prev: CharLike, curr: CharLike): boolean {
  const width = Math.max(curr.x1 - curr.x0, prev.x1 - prev.x0)
  const newLine = curr.y1 < prev.y0 || curr.x1 < prev.x0 - width * 10
  // formular_height_ignore_char: a character without pdf_character_id (a dummy space).
  if (newLine && (curr.dummy || prev.dummy)) return false
  return newLine
}

/** layout_helper.get_char_unicode_string */
export function getCharUnicodeString(chars: ReadonlyArray<CharLike | string>): string {
  const distances: number[] = []
  for (let i = 0; i + 1 < chars.length; i += 1) {
    const a = chars[i]!
    const b = chars[i + 1]!
    if (typeof a === 'string' || typeof b === 'string') continue
    const distance = b.x0 - a.x1
    if (distance > 1) distances.push(distance)
  }
  const distinct = [...new Set(distances)].sort((a, b) => a - b)
  const median = distinct.length === 0 ? 1 : distinct.length === 1 ? distinct[0]! : distinct[1]!

  const out: string[] = []
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i]!
    if (typeof ch === 'string') {
      out.push(ch)
      continue
    }
    out.push(normalizeSpaces(ch.text))
    if (ch.text === ' ') continue
    const next = chars[i + 1]
    if (next !== undefined && typeof next !== 'string') {
      const distance = next.x0 - ch.x1
      if (distance >= median || isNewline(ch, next)) out.push(' ')
    }
  }
  return pyStrip(normalizeSpaces(out.join('')))
}

function sameGstate(a: string | null, b: string | null): boolean {
  return a === b
}

/** layout_helper.is_same_style */
export function isSameStyle(a: BaseStyle, b: BaseStyle): boolean {
  return a.font === b.font && Math.abs(a.size - b.size) < 0.02 && sameGstate(a.gstate, b.gstate)
}

/** layout_helper.is_same_style_except_size */
export function isSameStyleExceptSize(a: BaseStyle, b: BaseStyle): boolean {
  const ratio = Math.abs(a.size / b.size)
  return a.font === b.font && ratio > 0.7 && ratio < 1.3 && sameGstate(a.gstate, b.gstate)
}

/** layout_helper.is_same_style_except_font */
export function isSameStyleExceptFont(a: BaseStyle, b: BaseStyle): boolean {
  return Math.abs(a.size - b.size) < 0.02 && sameGstate(a.gstate, b.gstate)
}

type Partial = { font: string | null; size: number | null; gstate: string | null }

/** StylesAndFormulas._merge_styles (a merged style whose size is None is replaced outright). */
function mergeStyles(a: Partial | null, b: Partial): Partial {
  if (a === null || a.size === null) return b
  if (b.size === null) return a
  return {
    font: a.font === b.font ? a.font : null,
    size: Math.abs(a.size - b.size) < 0.02 ? a.size : null,
    gstate: a.gstate === b.gstate ? a.gstate : null,
  }
}

/** Counter(values).most_common(1)[0][0]: the most frequent, the first seen on a tie. */
function mode<T>(values: readonly T[]): T {
  const counts = new Map<T, number>()
  if (values.length === 0) throw new Error('mode of nothing')
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1)
  let best = values[0] as T
  let bestCount = 0
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value
      bestCount = count
    }
  }
  return best
}

/** StylesAndFormulas._calculate_base_style over the paragraph's text characters. */
export function baseStyle(styles: readonly CharStyle[]): BaseStyle | null {
  if (styles.length === 0) return null
  let merged: Partial | null = null
  for (const style of styles) merged = mergeStyles(merged, style)
  const base = merged!
  return {
    font: base.font ?? mode(styles.map((s) => s.font)),
    size: base.size ?? mode(styles.map((s) => s.size)),
    gstate: base.gstate,
  }
}

/** StylesAndFormulas.process_page_styles: runs of characters that share the first one's style. */
export function compositionsOf(unit: LayoutUnit, index: number): Composition[] {
  const info = unit.infos[index]
  if (!info) return []
  const out: Composition[] = []
  let run: Run | undefined
  const close = () => {
    if (run) out.push(run)
    run = undefined
  }
  info.items.forEach((item, i) => {
    if (item.kind === 'formula') {
      close()
      const formula = unit.formulas[item.index]
      if (formula) out.push({ kind: 'formula', index: item.index, formula })
      return
    }
    const style = unit.styles[item.style]!
    const char: TextChar = {
      text: item.text,
      x0: item.x0,
      y0: item.y0,
      x1: item.x1,
      y1: item.y1,
      code: item.code,
      codeBytes: item.codeBytes,
      style: item.style,
      ...(item.dummy ? { dummy: true } : {}),
    }
    if (run && isSameStyle(style, run.style)) {
      run.chars.push(char)
      run.to = i + 1
      return
    }
    close()
    run = { kind: 'run', style, from: i, to: i + 1, chars: [char] }
  })
  close()
  return out
}

/** get_paragraph_unicode: every character, formulas included. */
export function paragraphUnicode(compositions: readonly Composition[]): string {
  const chars: CharLike[] = []
  for (const comp of compositions) {
    if (comp.kind === 'run') chars.push(...comp.chars)
    else chars.push(...comp.formula.chars)
  }
  return getCharUnicodeString(chars)
}

export function buildParagraphs(analysis: AnalysisResult): BdParagraph[] {
  const out: BdParagraph[] = []
  for (const unit of analysis.units) {
    unit.paragraphs.forEach((para, index) => {
      const compositions = compositionsOf(unit, index)
      const textStyles = compositions.flatMap((c) =>
        c.kind === 'run' ? c.chars.map((ch) => unit.styles[ch.style]!) : [],
      )
      out.push({
        id: segmentId(unit, index),
        unit,
        index,
        page: unit.page,
        label: unit.infos[index]?.label ?? null,
        top: para.y1,
        unicode: paragraphUnicode(compositions),
        compositions,
        base: baseStyle(textStyles),
      })
    })
  }
  return out
}

/** paragraph_helper.is_cid_paragraph */
export function isCidParagraph(p: BdParagraph): boolean {
  const chars: string[] = []
  for (const comp of p.compositions) {
    if (comp.kind === 'run') chars.push(...comp.chars.map((c) => c.text))
    else chars.push(...comp.formula.chars.map((c) => c.text))
  }
  const cid = chars.filter((text) => /^\(cid:\d+\)$/.test(text)).length
  return cid > chars.length * 0.8
}

/** paragraph_helper.is_pure_numeric_paragraph (Python \d is any Unicode decimal digit). */
export function isPureNumericParagraph(p: BdParagraph): boolean {
  const text = pyStrip(p.unicode)
  if (!text) return false
  return /^-?\p{Nd}+(\.\p{Nd}+)?$/u.test(text)
}

/** paragraph_helper.is_placeholder_only_paragraph */
export function isPlaceholderOnlyParagraph(p: BdParagraph): boolean {
  if (!p.unicode) return false
  for (const comp of p.compositions) {
    if (comp.kind === 'formula') continue
    for (const ch of comp.chars) {
      if (![...ch.text].every(isPySpace) || ch.text === '') return false
    }
  }
  return true
}
