import { PDF } from '../../../shared/pdf-constants'
import type { FormulaRun, Paragraph, Rect } from '../../../shared/pdf-types'
import type { Lined } from './formula'
import { joinLineTexts, normalizeParagraphText } from './normalize'

const HEADING_RE = /^(\d+(\.\d+)*\.?\s+\S|[IVX]+\.\s+\S|Abstract|References|Acknowledg|Appendix)/
const CAPTION_RE = /^(Figure|Fig\.|Table|Algorithm|Listing)\s*\d+/i
const LIST_RE = /^([•\-–▪◦]|\(\w{1,3}\)|\w{1,3}[.)])\s/
const FOOTNOTE_RE = /^(\d{1,2}\s|[*†‡])/
const EQ_NUM_RE = /^\(\d+[a-z]?\)|^\[\d+\]$/
const URL_RE = /^(https?:\/\/|doi:|www\.)/i
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const NON_TEXT_RE = /^[\d\s\-–—./,:;+±×÷=<>()[\]{}%]+$/

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0)
}

function union(a: Rect, b: Rect): Rect {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]
}

function overlapArea(a: Rect, b: Rect): number {
  const x = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]))
  const y = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]))
  return x * y
}

function variance(values: number[]): number {
  if (values.length === 0) return 0
  const mean = values.reduce((s, v) => s + v, 0) / values.length
  return values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length
}

function mainColor(line: Lined): [number, number, number] {
  const g = line.glyphs.find((glyph) => !glyph.isSpace) ?? line.glyphs[0]
  return g ? [...g.color] : [0, 0, 0]
}

function lettersOf(text: string): string {
  return text.replace(/\{v\d+\}/g, '').replace(/\s+/g, '')
}

type Draft = {
  lines: Lined[]
  formulaLine: boolean
}

function shouldStartNew(
  prev: Lined,
  cur: Lined,
  para: Draft,
  bodySize: number,
  colRight: number,
): boolean {
  const sizes = para.lines.map((l) => l.size)
  const paraSize = median(sizes)
  const gaps = para.lines.slice(1).map((l, i) => para.lines[i]!.baseline - l.baseline)
  const lineHeight = gaps.length ? median(gaps) : PDF.LINE_HEIGHT_FACTOR * paraSize
  if (prev.baseline - cur.baseline > PDF.PARA_GAP_FACTOR * lineHeight) return true
  if (Math.abs(cur.size - paraSize) > PDF.PARA_FONT_TOLERANCE * paraSize) return true
  const pb = union(para.lines[0]!.bbox, para.lines[para.lines.length - 1]!.bbox)
  const overlap = Math.min(pb[2], cur.bbox[2]) - Math.max(pb[0], cur.bbox[0])
  const narrower = Math.min(pb[2] - pb[0], cur.bbox[2] - cur.bbox[0])
  if (narrower > 0 && overlap < PDF.PARA_X_OVERLAP * narrower) return true
  if (cur.bbox[0] - pb[0] > PDF.PARA_INDENT * paraSize && colRight - prev.bbox[2] > 2 * paraSize)
    return true
  if (
    /[.。?!:]$/.test(prev.text) &&
    colRight - prev.bbox[2] > 3 * paraSize &&
    /^([A-Z]|\d|[•-])/.test(cur.text)
  ) {
    return true
  }
  if (
    HEADING_RE.test(cur.text) &&
    (cur.size >= 1.05 * bodySize ||
      (cur.glyphs.filter((g) => g.bold).length > 0 && !para.lines[0]?.glyphs.some((g) => g.bold)))
  ) {
    return true
  }
  if (cur.rotated) return true
  return false
}

function roleOf(
  lines: Lined[],
  text: string,
  pageHeight: number,
  bodySize: number,
): Paragraph['role'] {
  const bbox = lines.reduce((acc, l) => union(acc, l.bbox), lines[0]!.bbox)
  const band = PDF.HEADER_FOOTER_BAND * pageHeight
  if (lines.length === 1 && text.length < 120 && (bbox[3] > pageHeight - band || bbox[1] < band)) {
    return 'headerFooter'
  }
  if (CAPTION_RE.test(text)) return 'caption'
  if (LIST_RE.test(text) && lines[0] && lines[0].bbox[0] > 80) return 'listItem'
  if (
    lines.length <= 2 &&
    (median(lines.map((l) => l.size)) >= PDF.HEADING_FONT_RATIO * bodySize ||
      (HEADING_RE.test(text) &&
        lines.some((l) => l.glyphs.filter((g) => g.bold).length > l.glyphs.length * 0.6)))
  ) {
    return 'heading'
  }
  if (
    median(lines.map((l) => l.size)) <= PDF.FOOTNOTE_FONT_RATIO * bodySize &&
    bbox[1] < 0.3 * pageHeight &&
    FOOTNOTE_RE.test(text)
  ) {
    return 'footnote'
  }
  if (bodySize === 0) return 'other'
  return 'body'
}

function alignOf(lines: Lined[], colLeft: number, colRight: number): Paragraph['align'] {
  if (lines.length < 2) return 'left'
  const lefts = lines.map((l) => l.bbox[0])
  const rights = lines.map((l) => l.bbox[2])
  const centers = lines.map((l) => (l.bbox[0] + l.bbox[2]) / 2)
  const colMid = (colLeft + colRight) / 2
  if (variance(lefts) < 1 && variance(rights) < 1) return 'justify'
  if (
    centers.every((c) => Math.abs(c - colMid) < 2) &&
    variance(lefts) >= 1 &&
    variance(rights) >= 1
  ) {
    return 'center'
  }
  return 'left'
}

function skipReason(
  p: Omit<Paragraph, 'translatable' | 'skipReason'>,
  imageRects: Rect[],
  pageRotate: number,
  shared: boolean,
  colWidth: number,
  nearbyBody: boolean,
): string | undefined {
  if (p.lines.length && p.role === 'headerFooter') return 'header_footer'
  const plain = lettersOf(p.text)
  if (p.text && /display/.test(p.role)) return undefined
  if (plain.length < PDF.MIN_PARAGRAPH_CHARS || (plain.match(/[A-Za-z]/g) ?? []).length < 2)
    return 'no_letters'
  if (URL_RE.test(plain) || EMAIL_RE.test(plain) || NON_TEXT_RE.test(plain)) return 'non_text'
  const area = Math.max(1, (p.bbox[2] - p.bbox[0]) * (p.bbox[3] - p.bbox[1]))
  if (imageRects.some((r) => overlapArea(p.bbox, r) / area > PDF.IMAGE_OVERLAP_SKIP))
    return 'inside_image'
  if (p.text.length < PDF.SHORT_PARAGRAPH_CHARS) {
    const allowed = p.role === 'heading' || p.role === 'caption' || p.role === 'listItem'
    if (!allowed && p.bbox[2] - p.bbox[0] < 0.5 * colWidth && !nearbyBody) return 'short_isolated'
  }
  if (pageRotate !== 0) return 'rotated_page'
  if (shared) return 'shared_form'
  if ((p.formPath.match(/\//g) ?? []).length + (p.formPath ? 1 : 0) > PDF.MAX_FORM_DEPTH)
    return 'form_too_deep'
  if (p.role === 'other' && p.text.length < 40) return 'unknown_role'
  return undefined
}

export function mergeParagraphs(
  lines: Lined[],
  pageHeight: number,
  pageWidth: number,
  pageRotate: number,
  imageRects: Rect[],
  sharedPaths: ReadonlySet<string>,
): Paragraph[] {
  if (lines.length === 0) return []
  const bodySize = median(lines.filter((l) => !l.formulaLine).map((l) => l.size)) || lines[0]!.size
  const drafts: Draft[] = []
  for (const line of lines) {
    if (line.formulaLine) {
      drafts.push({ lines: [line], formulaLine: true })
      continue
    }
    if (EQ_NUM_RE.test(line.text.trim()) && drafts.at(-1)?.formulaLine) {
      drafts[drafts.length - 1]!.lines.push(line)
      continue
    }
    const prevDraft = drafts.at(-1)
    const prev = prevDraft?.lines.at(-1)
    const colRight = pageWidth - 72
    if (
      !prevDraft ||
      prevDraft.formulaLine ||
      !prev ||
      prev.column !== line.column ||
      shouldStartNew(prev, line, prevDraft, bodySize, colRight)
    ) {
      drafts.push({ lines: [line], formulaLine: false })
    } else {
      prevDraft.lines.push(line)
    }
  }

  const paragraphs: Paragraph[] = []
  drafts.forEach((draft, index) => {
    const page = draft.lines[0]!.page
    let text = ''
    for (const line of draft.lines) text = joinLineTexts(text, line.text)
    text = normalizeParagraphText(text)
    const runs: FormulaRun[] = []
    for (const line of draft.lines) {
      for (const run of line.runs) runs.push({ ...run, id: runs.length + 1 })
    }
    if (runs.length) {
      let n = 1
      text = text.replace(/\{v\d+\}/g, () => `{v${n++}}`)
    }
    const bbox = draft.lines.reduce((acc, l) => union(acc, l.bbox), draft.lines[0]!.bbox)
    const size = median(draft.lines.map((l) => l.size))
    const gaps = draft.lines.slice(1).map((l, i) => draft.lines[i]!.baseline - l.baseline)
    const lineHeight = gaps.length ? median(gaps) : 1.2 * size
    const glyphs = draft.lines.flatMap((l) => l.glyphs)
    const bold = glyphs.filter((g) => g.bold).length > glyphs.length * 0.6
    const formPath = draft.lines[0]!.glyphs[0]?.formPath ?? ''
    const role = draft.formulaLine ? 'other' : roleOf(draft.lines, text, pageHeight, bodySize)
    const colLeft = Math.min(...draft.lines.map((l) => l.bbox[0]))
    const colRight = Math.max(...draft.lines.map((l) => l.bbox[2]))
    const para: Paragraph = {
      id: `${page}-${index}`,
      page,
      bbox,
      lines: draft.lines.map((l) => ({ bbox: l.bbox, baseline: l.baseline, opSeqs: l.opSeqs })),
      size,
      lineHeight,
      bold,
      align: alignOf(draft.lines, colLeft, colRight),
      color: mainColor(draft.lines[0]!),
      role: draft.formulaLine ? 'other' : role,
      text,
      runs,
      formPath,
      translatable: false,
    }
    let reason: string | undefined
    if (draft.formulaLine) reason = 'display_math'
    else {
      const nearby = paragraphs.some(
        (other) =>
          other.role === 'body' &&
          other.translatable &&
          Math.abs(other.bbox[1] - para.bbox[3]) < 2 * lineHeight,
      )
      reason = skipReason(
        para,
        imageRects,
        pageRotate,
        sharedPaths.has(formPath),
        Math.max(1, colRight - colLeft),
        nearby,
      )
      if (para.lines.some((_, i) => draft.lines[i]?.rotated)) reason = reason ?? 'rotated'
      const invisible =
        glyphs.length > 0 && glyphs.every((g) => g.renderMode !== 0 && g.renderMode !== 2)
      if (invisible) reason = 'invisible_text'
    }
    para.translatable = reason === undefined
    if (reason) para.skipReason = reason
    paragraphs.push(para)
  })
  return paragraphs
}
