// Port of BabelDOC 0.6.4 `format/pdf/document_il/midend/typesetting.py` (Typesetting and
// TypesettingUnit), with ParagraphFinder.fix_overlapping_paragraphs, run on PDFMathTranslate's
// paragraphs and formulas instead of pdf2zh's own part C (ADR-0017). It fixes three pdf2zh
// shortcomings: every paragraph is reflowed inside its box (single-line titles wrap too),
// text that does not fit is shrunk (down to 0.1) and may grow into free space below or to the
// right, and the translation keeps the colour of the original text.
//
// Mapping onto pdf2zh's data (the only parts not taken from BabelDOC):
// - paragraph.box is pdf2zh's (x0, y0, x1, y1): pdf2zh's LTChar boxes stand in for BabelDOC's
//   visual boxes, so the first baseline at scale 1 is the original one;
// - first_line_indent is `x - x0 > 1` (the first character against the box);
// - a formula unit is pdf2zh's {vN}: its box is the union of its LTChar boxes, and its glyphs
//   keep pdf2zh's vertical offset (`fix`, applied after text like pdf2zh does) instead of
//   BabelDOC's x_offset/y_offset;
// - runs of same-style glyphs on one line share one TJ instead of one Tj per glyph.
// Since ADR-0018 the units are BabelDOC's three kinds: translated characters in the font
// FontMapper picks for their style, original glyphs (text that was not translated), and
// formulas; a paragraph of original glyphs and formulas only is drawn where it was.
import type {
  CharStyle,
  FontFlags,
  LtLine,
  OutputComp,
  ParagraphItem,
  Pdf2zhFormula,
  Pdf2zhParagraph,
  TextChar,
} from '../../../shared/pdf-types'
import type { FontMapper } from '../babeldoc/fontmap'
import { FONT_FAMILY, fontResourceName } from '../babeldoc/fonts'
import { codeHex } from './typeset'

export type Box = { x: number; y: number; x2: number; y2: number }

export type ReflowParagraph = {
  para: Pdf2zhParagraph
  /** The unit's formulas, indexed by ParagraphItem / OutputComp formula indexes. */
  formulas: readonly Pdf2zhFormula[]
  /** The original composition (analysis) of the paragraph. */
  items: readonly ParagraphItem[]
  styles: readonly CharStyle[]
  fonts: Readonly<Record<string, FontFlags>>
  /** The translation's compositions; undefined draws the original. */
  comps?: readonly OutputComp[] | undefined
  /** OCR workaround: every character is drawn black (BabelDOC il_creater). */
  ocr?: boolean
  /** BabelDOC xobj_id: paragraphs of different streams never cut each other's boxes. */
  stream: string
  box: Box
  units?: Unit[]
  passthrough?: boolean
  optimalScale?: number
  /** Content-stream operators after render(); '' when nothing could be laid out. */
  ops?: string
  /** False when no scale fitted: BabelDOC then draws nothing for the paragraph. */
  rendered?: boolean
}

export type ReflowPage = {
  /** get_max_right_space's start, `cropbox.x2 * 0.9`, in the paragraphs' coordinates. */
  right: number
  /** get_max_bottom_space's start, `cropbox.y * 1.1`, in the paragraphs' coordinates. */
  bottom: number
  paragraphs: ReflowParagraph[]
}

/** Font access for typesetting: bundled font files, by BabelDOC font id (file name). */
export type ReflowFonts = {
  mapper: FontMapper
  /** `font.char_lengths(ch, size)[0]` */
  width(file: string, ch: string, size: number): number
  /** Hex glyph code of `ch` in the embedded font. */
  hex(file: string, ch: string): string
}

/** A translated character (TypesettingUnit(unicode=…)). */
type TextUnit = {
  kind: 'text'
  ch: string
  /** Bundled font file FontMapper chose. */
  font: string
  fontSize: number
  gstate: string
  width: number
  height: number
}

/** An original glyph (TypesettingUnit(char=…)): passthrough, or moved by the typesetter. */
type CharUnit = {
  kind: 'char'
  ch: string
  char: TextChar
  style: CharStyle
  gstate: string
  width: number
  height: number
}

type FormulaUnit = {
  kind: 'formula'
  formula: Pdf2zhFormula
  /** pdf2zh `fix`, or 0 when no text came before it in the paragraph. */
  fix: number
  minX: number
  first: { x0: number; y0: number }
  maxY: number
  width: number
  height: number
  /** OCR workaround: drawn black. */
  ocr: boolean
}

type Unit = TextUnit | CharUnit | FormulaUnit

type Placed = { unit: Unit; x: number; y: number; scale: number; box: Box }

// LANG_LINEHEIGHT line_skip for a CJK target (zh).
const LINE_SKIP = 1.5
const MIN_SCALE = 0.1

// typesetting.LINE_BREAK_REGEX: characters that must not be split from their neighbours.
// The class lists combining marks (U+0300–036F) on purpose.
/* eslint-disable no-misleading-character-class */
const LINE_BREAK_RE = new RegExp(
  '^[' +
    'a-zA-Z0-9' +
    '\\u00C0-\\u00FF\\u0100-\\u017F\\u0180-\\u024F\\u1E00-\\u1EFF\\u2C60-\\u2C7F\\uA720-\\uA7FF' +
    '\\uAB30-\\uAB6F\\u0250-\\u02A0\\u0400-\\u04FF\\u0300-\\u036F\\u0500-\\u052F\\u0370-\\u03FF' +
    '\\u2DE0-\\u2DFF\\uA650-\\uA69F\\u1200-\\u137F\\u1380-\\u139F\\u2D80-\\u2DDF\\uAB00-\\uAB2F' +
    '\\u{1E7E0}-\\u{1E7FF}\\u0E80-\\u0EFF\\u0D00-\\u0D7F\\u0A80-\\u0AFF\\u0E00-\\u0E7F' +
    '\\u1000-\\u109F\\uAA60-\\uAA7F\\uA9E0-\\uA9FF\\u{116D0}-\\u{116FF}\\u0B80-\\u0BFF' +
    '\\u0C00-\\u0C7F\\u0B00-\\u0B7F\\u0530-\\u058F\\u10A0-\\u10FF\\u1C90-\\u1CBF\\u2D00-\\u2D2F' +
    '\\u1780-\\u17FF\\u19E0-\\u19FF\\u{10B00}-\\u{10B3F}\\u1D00-\\u1D7F\\u1400-\\u167F' +
    '\\u0780-\\u07BF\\u{1E900}-\\u{1E95F}\\u1C80-\\u1C8F\\u{1E030}-\\u{1E08F}\\uA000-\\uA48F' +
    '\\uA490-\\uA4CF' +
    "'\\-·ʻ" +
    ']+$',
  'u',
)
/* eslint-enable no-misleading-character-class */

const CJK_PUNCTUATION = new Set([
  '（', '）', '【', '】', '《', '》', '〔', '〕', '〈', '〉', '〖', '〗', '「', '」', '『', '』',
  '、', '。', '：', '？', '！', '，',
]) // prettier-ignore
const CJK_RANGES_RE = new RegExp(
  '^[\\u3000-\\u303f\\u3040-\\u309f\\u30a0-\\u30ff\\u3100-\\u312f\\uac00-\\ud7af\\u1100-\\u11ff' +
    '\\u3130-\\u318f\\ua960-\\ua97f\\ud7b0-\\ud7ff\\u3190-\\u319f\\u3200-\\u32ff\\u3300-\\u33ff' +
    '\\ufe30-\\ufe4f\\u4e00-\\u9fff\\u2e80-\\u2eff\\u31c0-\\u31ef\\u2f00-\\u2fdf\\ufe10-\\ufe1f]+$',
)
// unicodedata.name(ch) contains "CJK UNIFIED IDEOGRAPH" or "FULLWIDTH" (Unicode 15.1, the
// version of the Python 3.13 BabelDOC runs on).
const CJK_NAMED_RE = new RegExp(
  '^[\\u3400-\\u4dbf\\u4e00-\\u9fff\\u{20000}-\\u{2a6df}\\u{2a700}-\\u{2b739}\\u{2b740}-\\u{2b81d}' +
    '\\u{2b820}-\\u{2cea1}\\u{2ceb0}-\\u{2ebe0}\\u{2ebf0}-\\u{2ee5d}\\u{30000}-\\u{3134a}' +
    '\\u{31350}-\\u{323af}\\uff01-\\uff60\\uffe0-\\uffe6]$',
  'u',
)
const MIXED_BLACKLIST = new Set(['。', '，', '：', '？', '！'])
const NO_GAP_AFTER = new Set(['。', '！', '？', '；', '：', '，'])
// calc_is_hung_punctuation: may hang past the right edge instead of starting a line.
const HUNG_PUNCTUATION = new Set([
  ',', '.', ':', ';', '?', '!', '，', '。', '．', '、', '：', '；', '！', '‼', '？', '⁇', '”', '’',
  '」', '』', ')', ']', '}', '）', '〕', '〉', '】', '〗', '］', '｝', '》', '～', '-', '–', '—',
  '·', '・', '‧', '/', '／', '⁄',
]) // prettier-ignore
// calc_is_cannot_appear_in_line_end_punctuation
const LINE_END_PROHIBITED = new Set([
  '“', '‘', '「', '『', '(', '[', '{', '（', '〔', '〈', '《', '〖', '〘', '〚',
]) // prettier-ignore

/** try_get_unicode */
function textOf(unit: Unit): string | undefined {
  return unit.kind === 'formula' ? undefined : unit.ch
}

function canBreakLine(unit: Unit): boolean {
  const ch = textOf(unit)
  if (!ch) return true
  return !LINE_BREAK_RE.test(ch)
}

function isCjkChar(unit: Unit): boolean {
  const ch = textOf(unit)
  if (!ch) return false
  if (ch.includes('(cid')) return false
  if (CJK_PUNCTUATION.has(ch)) return true
  return CJK_RANGES_RE.test(ch) || CJK_NAMED_RE.test(ch)
}

function isSpace(unit: Unit): boolean {
  return textOf(unit) === ' '
}

/** statistics.mode: the most common value, the first one seen on a tie. */
function pyMode(values: readonly number[]): number {
  if (values.length === 0) throw new Error('no mode for empty data')
  const counts = new Map<number, number>()
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1)
  let best = values[0]!
  let bestCount = 0
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value
      bestCount = count
    }
  }
  return best
}

/** Python `f"{x:f}"` */
function f(value: number): string {
  return value.toFixed(6)
}

// BabelDOC style_helper.BLACK: the OCR workaround draws every character in it.
const BLACK = '0 g 0 G'

/** create_typesetting_units: from the translation's compositions, or the original ones. */
export function createUnits(p: ReflowParagraph, fonts: ReflowFonts): Unit[] {
  const units: Unit[] = []
  let seenText = false
  const pushChar = (char: TextChar) => {
    const style = p.styles[char.style]!
    units.push({
      kind: 'char',
      ch: char.text,
      char,
      style,
      gstate: p.ocr ? BLACK : style.gstate,
      width: char.x1 - char.x0,
      height: char.y1 - char.y0,
    })
    seenText = true
  }
  const pushFormula = (index: number) => {
    const formula = p.formulas[index]
    // 翻译器可能会自动补个越界的公式标记
    if (!formula || formula.chars.length === 0) return
    units.push(formulaUnit(formula, seenText, p.ocr ?? false))
  }
  if (!p.comps) {
    for (const item of p.items) {
      if (item.kind === 'formula') pushFormula(item.index)
      else pushChar(item)
    }
  } else {
    for (const comp of p.comps) {
      if (comp.kind === 'formula') {
        pushFormula(comp.index)
      } else if (comp.kind === 'original') {
        for (const item of p.items.slice(comp.from, comp.to)) {
          if (item.kind === 'char') pushChar(item)
        }
      } else {
        const flags = p.fonts[comp.style.font]
        const size = comp.style.size
        for (const ch of comp.text) {
          if (ch === '\n') continue
          // Units whose character no font has are dropped.
          const font = fonts.mapper.map(flags, ch)
          if (!font) continue
          units.push({
            kind: 'text',
            ch,
            font,
            fontSize: size,
            gstate: p.ocr ? BLACK : (comp.style.gstate ?? ''),
            width: fonts.width(font, ch, size),
            height: size,
          })
          seenText = true
        }
      }
    }
  }
  p.passthrough = units.every((unit) => unit.kind !== 'text')
  return units
}

function formulaUnit(part: Pdf2zhFormula, seenText: boolean, ocr: boolean): FormulaUnit {
  const first = part.chars[0]!
  const minX = Math.min(...part.chars.map((c) => c.x0))
  const maxX = Math.max(...part.chars.map((c) => c.x1))
  const minY = Math.min(...part.chars.map((c) => c.y0))
  const maxY = Math.max(...part.chars.map((c) => c.y1))
  return {
    kind: 'formula',
    formula: part,
    fix: seenText ? part.fix : 0,
    minX,
    first: { x0: first.x0, y0: first.y0 },
    maxY,
    width: maxX - minX,
    height: maxY - minY,
    ocr,
  }
}

function relocate(unit: Unit, x: number, y: number, scale: number, fonts: ReflowFonts): Placed {
  if (unit.kind === 'text') {
    const size = unit.fontSize * scale
    const box = { x, y, x2: x + fonts.width(unit.font, unit.ch, size), y2: y + size }
    return { unit, x, y, scale, box }
  }
  if (unit.kind === 'char') {
    const box = { x, y, x2: x + unit.width * scale, y2: y + unit.height * scale }
    return { unit, x, y, scale, box }
  }
  const base = y + (unit.fix - unit.first.y0) * scale
  const box = {
    x,
    y: base + Math.min(...unit.formula.chars.map((c) => c.y0)) * scale,
    x2: x + unit.width * scale,
    y2: base + unit.maxY * scale,
  }
  return { unit, x, y, scale, box }
}

/** _get_width_before_next_break_point (counts units[i] itself, like the original). */
function widthBeforeNextBreakPoint(units: readonly Unit[], from: number, scale: number): number {
  if (from >= units.length) return 0
  if (canBreakLine(units[from]!)) return 0
  let total = 0
  for (let i = from; i < units.length; i += 1) {
    const unit = units[i]!
    if (canBreakLine(unit)) return total * scale
    total += unit.width
  }
  return total * scale
}

/** _layout_typesetting_units */
function layoutUnits(
  units: readonly Unit[],
  box: Box,
  scale: number,
  firstLineIndent: boolean,
  useEnglishLineBreak: boolean,
  fonts: ReflowFonts,
): { placed: Placed[]; fit: boolean } {
  const fontSizes = units.flatMap((u) =>
    u.kind === 'text' ? [u.fontSize] : u.kind === 'char' ? [u.style.size] : [],
  )
  fontSizes.sort((a, b) => a - b)
  const fontSize = pyMode(fontSizes)
  const spaceWidth = fonts.width(FONT_FAMILY.base, '你', fontSize * scale) * 0.5

  const heights = units.map((u) => u.height)
  let avgHeight = 0
  if (heights.length === 1) avgHeight = heights[0]! * scale
  else if (heights.length > 1) avgHeight = pyMode(heights) * scale

  let x = box.x
  let y = box.y2 - avgHeight
  let lineHeight = 0
  let lineHeights: number[] = []
  const placed: Placed[] = []
  let fit = true
  let last: Placed | undefined
  if (firstLineIndent) x += spaceWidth * 4

  for (let i = 0; i < units.length; i += 1) {
    const unit = units[i]!
    const unitWidth = unit.width * scale
    const unitHeight = unit.height * scale

    // 跳过行首的空格
    if (x === box.x && isSpace(unit)) continue

    const lastText = last ? textOf(last.unit) : undefined
    if (
      last &&
      isCjkChar(last.unit) !== isCjkChar(unit) &&
      last.box.y !== 0 &&
      y - 0.1 <= last.box.y2 &&
      last.box.y2 <= y + lineHeight + 0.1 &&
      !(lastText !== undefined && MIXED_BLACKLIST.has(lastText)) &&
      !(textOf(unit) !== undefined && MIXED_BLACKLIST.has(textOf(unit)!)) &&
      x > box.x &&
      textOf(unit) !== ' ' &&
      lastText !== ' ' &&
      !(lastText !== undefined && NO_GAP_AFTER.has(lastText))
    ) {
      x += spaceWidth * 0.5
    }
    const widthBefore = useEnglishLineBreak ? widthBeforeNextBreakPoint(units, i, scale) : 0

    const ch = textOf(unit)
    const hung = ch !== undefined && HUNG_PUNCTUATION.has(ch)
    const endProhibited = ch !== undefined && LINE_END_PROHIBITED.has(ch)
    if (
      !hung &&
      (x + unitWidth > box.x2 ||
        (useEnglishLineBreak && x + unitWidth + widthBefore > box.x2) ||
        (endProhibited && x + unitWidth * 2 > box.x2))
    ) {
      // 换行
      x = box.x
      if (lineHeights.length === 0) return { placed: [], fit: false }
      const maxHeight = Math.max(...lineHeights)
      const modeHeight = pyMode(lineHeights)
      y -= Math.max(fontSize * scale * LINE_SKIP, modeHeight * LINE_SKIP, maxHeight * 1.05)
      lineHeight = 0
      lineHeights = []
      if (y < box.y) fit = false
      if (isSpace(unit)) {
        lineHeight = Math.max(lineHeight, unitHeight)
        continue
      }
    }

    const relocated = relocate(unit, x, y, scale, fonts)
    placed.push(relocated)
    if (!isSpace(unit)) lineHeights.push(unitHeight)
    x = relocated.box.x2
    last = relocated
  }
  return { placed, fit }
}

function sameBox(a: Box, b: Box): boolean {
  return a.x === b.x && a.y === b.y && a.x2 === b.x2 && a.y2 === b.y2
}

/** get_max_right_space (BabelDOC 0.6.4 never fills page.pdf_figure; every char is in a paragraph here). */
function maxRightSpace(current: Box, page: ReflowPage): number {
  let maxX = page.right
  for (const other of page.paragraphs) {
    const box = other.box
    if (sameBox(box, current)) continue
    if (box.x > current.x && !(box.y >= current.y2 || box.y2 <= current.y)) {
      maxX = Math.min(maxX, box.x)
    }
  }
  return maxX
}

/** get_max_bottom_space */
function maxBottomSpace(current: Box, page: ReflowPage): number {
  let minY = page.bottom
  for (const other of page.paragraphs) {
    const box = other.box
    if (sameBox(box, current)) continue
    if (box.y2 < current.y && !(box.x >= current.x2 || box.x2 <= current.x)) {
      minY = Math.max(minY, box.y2)
    }
  }
  return minY
}

/** _find_optimal_scale_and_layout */
function findOptimalScaleAndLayout(
  p: ReflowParagraph,
  page: ReflowPage,
  units: readonly Unit[],
  initialScale: number,
  useEnglishLineBreak: boolean,
  applyLayout: boolean,
  fonts: ReflowFonts,
): { scale: number; placed: Placed[] | undefined } {
  let box = p.box
  let scale = initialScale
  let expandSpaceFlag = 0
  const indent = p.para.x - p.para.x0 > 1

  while (scale >= MIN_SCALE) {
    try {
      const { placed, fit } = layoutUnits(units, box, scale, indent, useEnglishLineBreak, fonts)
      if (fit) return { scale, placed: applyLayout ? placed : undefined }
    } catch {
      // 如果布局检查出错，继续尝试下一个缩放因子
    }

    if (scale > 0.6) scale -= 0.05
    else scale -= 0.1

    if (scale < 0.7) {
      let spaceExpanded = false
      if (expandSpaceFlag === 0) {
        // 尝试向下扩展
        const minY = maxBottomSpace(box, page) + 2
        if (minY < box.y) {
          box = { x: box.x, y: minY, x2: box.x2, y2: box.y2 }
          if (applyLayout) p.box = box
          spaceExpanded = true
        }
        expandSpaceFlag = 1
        if (spaceExpanded) continue
      } else if (expandSpaceFlag === 1) {
        // 尝试向右扩展
        const maxX = maxRightSpace(box, page) - 5
        if (maxX > box.x2) {
          box = { x: box.x, y: box.y, x2: maxX, y2: box.y2 }
          if (applyLayout) p.box = box
          spaceExpanded = true
        }
        expandSpaceFlag = 2
        if (spaceExpanded) continue
      }
      if (expandSpaceFlag < 2) scale = 1.0
    }
  }

  // 如果仍然放不下，尝试去除英文换行限制
  if (useEnglishLineBreak) {
    return findOptimalScaleAndLayout(p, page, units, initialScale, false, applyLayout, fonts)
  }
  return { scale: MIN_SCALE, placed: undefined }
}

function bboxOverlap(a: Box, b: Box): boolean {
  return a.x < b.x2 && a.x2 > b.x && a.y < b.y2 && a.y2 > b.y
}

function containedVertically(a: Box, b: Box): boolean {
  return (a.y >= b.y && a.y2 <= b.y2) || (b.y >= a.y && b.y2 <= a.y2)
}

/** ParagraphFinder.fix_overlapping_paragraphs */
export function fixOverlappingParagraphs(paragraphs: readonly ReflowParagraph[]): void {
  if (paragraphs.length < 2) return
  const maxIterations = paragraphs.length * paragraphs.length
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    let overlapFound = false
    for (let i = 0; i < paragraphs.length; i += 1) {
      for (let j = i + 1; j < paragraphs.length; j += 1) {
        const para1 = paragraphs[i]!
        const para2 = paragraphs[j]!
        if (para1.stream !== para2.stream) continue
        if (!bboxOverlap(para1.box, para2.box)) continue
        if (containedVertically(para1.box, para2.box)) continue
        const overlapYStart = Math.max(para1.box.y, para2.box.y)
        const overlapYEnd = Math.min(para1.box.y2, para2.box.y2)
        const overlapHeight = overlapYEnd - overlapYStart
        const overlapWidth =
          Math.min(para1.box.x2, para2.box.x2) - Math.max(para1.box.x, para2.box.x)
        if (overlapHeight > 1e-6 && overlapWidth > 1e-6) {
          overlapFound = true
          let lower: ReflowParagraph
          let higher: ReflowParagraph
          if (para1.box.y2 > para2.box.y && para1.box.y < para2.box.y) {
            lower = para1
            higher = para2
          } else if (para1.box.y2 < para2.box.y2) {
            lower = para1
            higher = para2
          } else {
            lower = para2
            higher = para1
          }
          const midY = overlapYStart + overlapHeight / 2
          if (midY > higher.box.y && midY < lower.box.y2) {
            higher.box = { ...higher.box, y: midY + 1 }
            lower.box = { ...lower.box, y2: midY - 1 }
          }
        }
      }
    }
    if (!overlapFound) break
  }
}

function unitCount(units: readonly Unit[]): number {
  let count = units.length
  for (const unit of units) if (unit.kind === 'formula') count += unit.formula.chars.length - 1
  return count
}

/**
 * Typesetting.preprocess_document: every paragraph's optimal scale, then the document-wide
 * cap `min(statistics.multimode(scales))`, where each paragraph counts once per unit.
 */
export function preprocessDocument(pages: readonly ReflowPage[], fonts: ReflowFonts): void {
  for (const page of pages) fixOverlappingParagraphs(page.paragraphs)
  const counts = new Map<number, number>()
  const all: ReflowParagraph[] = []
  for (const page of pages) {
    for (const p of page.paragraphs) {
      all.push(p)
      let count = 0
      try {
        const units = createUnits(p, fonts)
        p.units = units
        count = unitCount(units)
        if (p.passthrough) p.optimalScale = 1.0
        else
          p.optimalScale = findOptimalScaleAndLayout(p, page, units, 1.0, true, false, fonts).scale
      } catch {
        p.optimalScale = 1.0
      }
      if (count > 0) counts.set(p.optimalScale, (counts.get(p.optimalScale) ?? 0) + count)
    }
  }
  if (counts.size === 0) return
  const top = Math.max(...counts.values())
  const modeScale = Math.min(...[...counts].filter(([, n]) => n === top).map(([scale]) => scale))
  for (const p of all) {
    if (p.optimalScale !== undefined && p.optimalScale > modeScale) p.optimalScale = modeScale
  }
}

/** render_page: raise each box above the paragraph just below it, then lay every one out. */
export function renderPage(page: ReflowPage, fonts: ReflowFonts): void {
  const indexed = page.paragraphs.map((p) => ({ p, box: { ...p.box } }))
  for (const upper of page.paragraphs) {
    const height = upper.box.y2 - upper.box.y
    const gap = height < 36 ? 0.5 : 3
    const check: Box = { x: upper.box.x, y: upper.box.y - gap, x2: upper.box.x2, y2: upper.box.y }
    // rtree intersection over the boxes as they were indexed (edges touching count).
    const conflicting = indexed
      .filter(
        ({ p, box }) =>
          p !== upper &&
          box.x <= check.x2 &&
          box.x2 >= check.x &&
          box.y <= check.y2 &&
          box.y2 >= check.y,
      )
      .map(({ p }) => p)
      .filter((lower) => !(lower.box.x2 < upper.box.x || lower.box.x > upper.box.x2))
    if (conflicting.length > 0) {
      const newY = Math.max(...conflicting.map((p) => p.box.y2)) + gap
      if (newY < upper.box.y2) upper.box = { ...upper.box, y: newY }
    }
  }
  for (const p of page.paragraphs) renderParagraph(p, page, fonts)
}

function renderParagraph(p: ReflowParagraph, page: ReflowPage, fonts: ReflowFonts): void {
  const units = p.units ?? createUnits(p, fonts)
  const out = new OpsWriter(fonts)
  if (p.passthrough) {
    // create_passthrough_composition: every glyph where it was.
    for (const unit of units) {
      if (unit.kind === 'formula') drawFormulaInPlace(out, unit.formula, unit.ocr)
      else if (unit.kind === 'char') drawChar(out, unit, unit.char.x0, unit.char.y0, 1)
    }
    p.ops = out.finish()
    p.rendered = true
    return
  }
  const { placed } = findOptimalScaleAndLayout(
    p,
    page,
    units,
    p.optimalScale ?? 1.0,
    true,
    true,
    fonts,
  )
  if (!placed) {
    p.ops = ''
    p.rendered = false
    return
  }
  for (const item of placed) {
    const unit = item.unit
    if (unit.kind === 'text') {
      out.glyphs(
        unit.gstate,
        unit.font,
        unit.fontSize * item.scale,
        item.x,
        item.y,
        unit.ch,
        item.box.x2,
      )
      continue
    }
    if (unit.kind === 'char') {
      drawChar(out, unit, item.x, item.y, item.scale)
      continue
    }
    drawFormula(out, unit, item)
  }
  p.ops = out.finish()
  p.rendered = true
}

function drawFormula(out: OpsWriter, unit: FormulaUnit, item: Placed): void {
  const { scale } = item
  const base = item.y + (unit.fix - unit.first.y0) * scale
  for (const ch of unit.formula.chars) {
    // A glyph whose operator could not be paired has no resource name to draw with.
    if (!ch.font) continue
    out.original(
      unit.ocr ? BLACK : ch.gstate,
      ch.font,
      ch.size * scale,
      item.x + (ch.x0 - unit.minX) * scale,
      base + ch.y0 * scale,
      codeHex(ch.code, ch.codeBytes),
      isVertical(ch) ? item.x + (ch.x1 - unit.minX) * scale : undefined,
    )
  }
  for (const line of unit.formula.lines) {
    if (line.linewidth < 5) {
      out.line(
        item.x + (line.pts[0][0] - unit.minX) * scale,
        base + line.pts[0][1] * scale,
        (line.pts[1][0] - line.pts[0][0]) * scale,
        (line.pts[1][1] - line.pts[0][1]) * scale,
        line.linewidth * scale,
      )
    }
  }
}

/** An original glyph; a dummy space or a glyph without a resource name draws nothing. */
function drawChar(out: OpsWriter, unit: CharUnit, x: number, y: number, scale: number): void {
  const { char, style } = unit
  if (char.dummy || !style.font) return
  out.original(
    unit.gstate,
    style.font,
    style.size * scale,
    x,
    y,
    codeHex(char.code, char.codeBytes),
    undefined,
  )
}

function drawFormulaInPlace(out: OpsWriter, formula: Pdf2zhFormula, ocr: boolean): void {
  for (const ch of formula.chars) {
    if (!ch.font) continue
    const hex = codeHex(ch.code, ch.codeBytes)
    out.original(
      ocr ? BLACK : ch.gstate,
      ch.font,
      ch.size,
      ch.x0,
      ch.y0,
      hex,
      isVertical(ch) ? ch.x1 : undefined,
    )
  }
  for (const line of formula.lines) {
    if (line.linewidth < 5) {
      const [[x0, y0], [x1, y1]] = line.pts
      out.line(x0, y0, x1 - x0, y1 - y0, line.linewidth)
    }
  }
}

/** BabelDOC keeps glyphs turned by 90° (0 1 -1 0 Tm); other angles are drawn upright as pdf2zh does. */
function isVertical(ch: Pdf2zhFormula['chars'][number]): boolean {
  return ch.vertical && ch.angle >= 89.9 && ch.angle <= 90.1
}

/** pdf2zh gen_op_line, outside a text object. */
export function lineOps(line: LtLine): string {
  const [[x0, y0], [x1, y1]] = line.pts
  return `q 1 0 0 1 ${f(x0)} ${f(y0)} cm [] 0 d 0 J ${f(line.linewidth)} w 0 0 m ${f(x1 - x0)} ${f(y1 - y0)} l S Q `
}

type Run = {
  state: string
  font: string
  size: number
  x: number
  y: number
  /** Where the next glyph must start to join this run. */
  end: number
  hex: string[]
  text: string
  vertical: boolean
}

/**
 * BabelDOC writes `q {graphic state} BT /font size Tf … Tm <gid> Tj ET Q` per glyph. Glyphs of
 * one font, size and state that follow each other on a line are joined into one TJ here, and
 * glyphs sharing a state share one q … Q.
 */
class OpsWriter {
  private readonly parts: string[] = []
  private run: Run | undefined
  private open: string | undefined // state of the open text object

  constructor(private readonly fonts: ReflowFonts) {}

  glyphs(state: string, font: string, size: number, x: number, y: number, ch: string, end: number) {
    const run = this.run
    if (
      run &&
      !run.vertical &&
      run.state === state &&
      run.font === font &&
      run.size === size &&
      run.y === y &&
      run.end === x &&
      run.hex.length === 0
    ) {
      run.text += ch
      run.end = end
      return
    }
    this.flush()
    this.run = { state, font, size, x, y, end, hex: [], text: ch, vertical: false }
  }

  original(
    state: string,
    font: string,
    size: number,
    x: number,
    y: number,
    hex: string,
    verticalX2: number | undefined,
  ) {
    this.flush()
    this.run = {
      state,
      font,
      size,
      x: verticalX2 ?? x,
      y,
      end: Number.NaN,
      hex: [hex],
      text: '',
      vertical: verticalX2 !== undefined,
    }
  }

  line(x: number, y: number, xlen: number, ylen: number, linewidth: number) {
    this.flush()
    this.closeText()
    this.parts.push(
      `q 1 0 0 1 ${f(x)} ${f(y)} cm [] 0 d 0 J ${f(linewidth)} w 0 0 m ${f(xlen)} ${f(ylen)} l S Q `,
    )
  }

  finish(): string {
    this.flush()
    this.closeText()
    return this.parts.join('')
  }

  private flush() {
    const run = this.run
    if (!run) return
    this.run = undefined
    if (this.open !== run.state) {
      this.closeText()
      this.parts.push(run.state ? `q ${run.state} BT ` : 'BT ')
      this.open = run.state
    }
    const bundled = run.hex.length === 0
    const hex = bundled ? this.textHex(run.font, run.text) : run.hex.join('')
    const name = bundled ? fontResourceName(run.font) : run.font
    const tm = run.vertical ? '0 1 -1 0' : '1 0 0 1'
    this.parts.push(`/${name} ${f(run.size)} Tf ${tm} ${f(run.x)} ${f(run.y)} Tm [<${hex}>] TJ `)
  }

  private closeText() {
    if (this.open === undefined) return
    this.parts.push(this.open ? 'ET Q ' : 'ET ')
    this.open = undefined
  }

  /** Glyph by glyph, like BabelDOC's one Tj per character (no shaping across characters). */
  private textHex(font: string, text: string): string {
    return [...text].map((c) => this.fonts.hex(font, c)).join('')
  }
}
