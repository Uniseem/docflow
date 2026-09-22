import { PDF } from '../../../shared/pdf-constants'
import type { Paragraph } from '../../../shared/pdf-types'

export type MeasureFn = (text: string, fontSize: number) => number

export type LaidToken =
  | { kind: 'text'; text: string; x: number; width: number }
  | { kind: 'formula'; id: number; x: number; width: number }

export type LaidLine = {
  baseline: number
  tokens: LaidToken[]
  width: number
}

export type LayoutResult = {
  lines: LaidLine[]
  fontSize: number
  lineHeight: number
  overflow: boolean
  fontScale: number
}

export type LayoutOptions = {
  minFontScale: number
  lineHeightFactor: number
  minLineHeightFactor: number
}

type RawToken = { kind: 'text'; text: string } | { kind: 'formula'; id: number } | { kind: 'space' }

const LATIN_RE = /^[A-Za-z0-9@#$%&*+\-=/<>'"_.,:;!?()[\]]+/
const FORMULA_RE = /^\{v(\d+)\}/
const HEAD_FORBIDDEN = new Set(Array.from('，。、；：？！）】》」』〕〉…—'))
const TAIL_FORBIDDEN = new Set(Array.from('（【《「『〔〈'))

export function tokenizeTranslated(text: string): RawToken[] {
  const tokens: RawToken[] = []
  let i = 0
  while (i < text.length) {
    const rest = text.slice(i)
    if (/^\s/.test(rest)) {
      tokens.push({ kind: 'space' })
      i += 1
      while (i < text.length && /\s/.test(text[i] ?? '')) i += 1
      continue
    }
    const formula = FORMULA_RE.exec(rest)
    if (formula) {
      tokens.push({ kind: 'formula', id: Number(formula[1]) })
      i += formula[0].length
      continue
    }
    const latin = LATIN_RE.exec(rest)
    if (latin) {
      tokens.push({ kind: 'text', text: latin[0] })
      i += latin[0].length
      continue
    }
    tokens.push({ kind: 'text', text: rest[0] ?? '' })
    i += 1
  }
  return tokens
}

function tokenWidth(
  token: RawToken,
  fontSize: number,
  measure: MeasureFn,
  runs: Paragraph['runs'],
  fontScale: number,
): number {
  if (token.kind === 'space') return measure(' ', fontSize)
  if (token.kind === 'formula') {
    const run = runs.find((item) => item.id === token.id)
    return (run?.width ?? fontSize) * fontScale
  }
  return measure(token.text, fontSize)
}

function isHeadForbidden(token: RawToken): boolean {
  return token.kind === 'text' && token.text.length === 1 && HEAD_FORBIDDEN.has(token.text)
}

function isTailForbidden(token: RawToken): boolean {
  return token.kind === 'text' && token.text.length === 1 && TAIL_FORBIDDEN.has(token.text)
}

type Sized = { token: RawToken; width: number }

function wrap(items: Sized[], lineWidth: number, em: number): Sized[][] {
  const lines: Sized[][] = []
  let current: Sized[] = []
  let used = 0
  const pushLine = () => {
    while (current.length && current[0]?.token.kind === 'space') current.shift()
    while (current.length && current.at(-1)?.token.kind === 'space') current.pop()
    if (current.length) lines.push(current)
    current = []
    used = 0
  }
  for (const item of items) {
    if (item.width > lineWidth && item.token.kind === 'text' && item.token.text.length > 1) {
      if (current.length) pushLine()
      let buf = ''
      for (const ch of item.token.text) {
        const next = buf + ch
        const w = (item.width / item.token.text.length) * next.length
        if (buf && w > lineWidth) {
          lines.push([
            {
              token: { kind: 'text', text: buf },
              width: (item.width / item.token.text.length) * buf.length,
            },
          ])
          buf = ch
        } else buf = next
      }
      if (buf) {
        current = [
          {
            token: { kind: 'text', text: buf },
            width: (item.width / item.token.text.length) * buf.length,
          },
        ]
        used = current[0]!.width
      }
      continue
    }
    if (current.length && used + item.width > lineWidth) pushLine()
    current.push(item)
    used += item.width
  }
  pushLine()
  applyKinsoku(lines, lineWidth, em)
  return lines.filter((line) => line.length > 0)
}

function applyKinsoku(lines: Sized[][], lineWidth: number, em: number): void {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (!line) continue
    if (i > 0 && line[0] && isHeadForbidden(line[0].token)) {
      const prev = lines[i - 1]
      if (prev) {
        const moved = line.shift()
        if (moved) prev.push(moved)
      }
    }
    const last = line.at(-1)
    if (last && isTailForbidden(last.token) && i + 1 < lines.length) {
      const next = lines[i + 1]
      const moved = line.pop()
      if (moved && next) next.unshift(moved)
    }
    const overflow = line.reduce((n, t) => n + t.width, 0) - lineWidth
    if (overflow > 0.5 * em && line.length > 1) {
      const extra = line.pop()
      if (extra) {
        if (!lines[i + 1]) lines.splice(i + 1, 0, [])
        lines[i + 1]?.unshift(extra)
      }
    }
  }
}

function place(
  wrapped: Sized[][],
  para: Paragraph,
  fontSize: number,
  lineHeight: number,
): LaidLine[] {
  const lineWidth = para.bbox[2] - para.bbox[0]
  const firstBaseline = para.lines[0]?.baseline ?? para.bbox[3] - fontSize
  return wrapped.map((row, index) => {
    const content = row.filter((item) => item.token.kind !== 'space' || row.length > 1)
    const natural = content.reduce((n, t) => n + t.width, 0)
    let x = para.bbox[0]
    const last = index === wrapped.length - 1
    if (para.align === 'center') x += Math.max(0, (lineWidth - natural) / 2)
    else if (para.align === 'right') x += Math.max(0, lineWidth - natural)
    const gaps = Math.max(0, content.length - 1)
    const extra =
      para.align === 'justify' && !last && gaps > 0 ? Math.max(0, lineWidth - natural) / gaps : 0
    const tokens: LaidToken[] = []
    content.forEach((item, idx) => {
      if (item.token.kind === 'space') {
        x += item.width + extra
        return
      }
      if (item.token.kind === 'formula') {
        tokens.push({ kind: 'formula', id: item.token.id, x, width: item.width })
      } else {
        tokens.push({ kind: 'text', text: item.token.text, x, width: item.width })
      }
      x += item.width + (idx < content.length - 1 ? extra : 0)
    })
    return {
      baseline: firstBaseline - index * lineHeight,
      tokens,
      width: natural,
    }
  })
}

function totalHeight(lineCount: number, lineHeight: number): number {
  if (lineCount <= 0) return 0
  return lineCount * lineHeight
}

export function layoutParagraph(
  para: Paragraph,
  text: string,
  measure: MeasureFn,
  options: LayoutOptions,
): LayoutResult {
  const raw = tokenizeTranslated(text)
  let fontSize = para.size || 10
  const minSize = Math.max(1, options.minFontScale * fontSize)
  const boxH = para.bbox[3] - para.bbox[1]
  const single = para.lines.length <= 1
  let lineHeight = single
    ? options.lineHeightFactor * fontSize
    : para.lineHeight || options.lineHeightFactor * fontSize
  let overflow = false

  const tryLayout = (size: number, lh: number) => {
    const fontScale = para.size ? size / para.size : 1
    const sized = raw.map((token) => ({
      token,
      width: tokenWidth(token, size, measure, para.runs, fontScale),
    }))
    const wrapped = wrap(sized, Math.max(1, para.bbox[2] - para.bbox[0]), size)
    return { wrapped, fontScale, height: totalHeight(wrapped.length, lh) }
  }

  let attempt = tryLayout(fontSize, lineHeight)
  const fits = (height: number, lh: number) => height <= boxH + 0.5 * lh

  if (!fits(attempt.height, lineHeight)) {
    while (lineHeight > options.minLineHeightFactor * fontSize + 1e-6) {
      lineHeight = Math.max(
        options.minLineHeightFactor * fontSize,
        lineHeight - PDF.LINE_HEIGHT_STEP * fontSize,
      )
      attempt = tryLayout(fontSize, lineHeight)
      if (fits(attempt.height, lineHeight)) break
    }
  }
  if (!fits(attempt.height, lineHeight)) {
    while (fontSize > minSize + 1e-6) {
      fontSize = Math.max(minSize, fontSize - PDF.FONT_SIZE_STEP)
      lineHeight = single
        ? options.lineHeightFactor * fontSize
        : Math.min(lineHeight, options.lineHeightFactor * fontSize)
      attempt = tryLayout(fontSize, lineHeight)
      if (fits(attempt.height, lineHeight)) break
    }
  }
  if (!fits(attempt.height, lineHeight)) overflow = true

  return {
    lines: place(attempt.wrapped, para, fontSize, lineHeight),
    fontSize,
    lineHeight,
    overflow,
    fontScale: para.size ? fontSize / para.size : 1,
  }
}
