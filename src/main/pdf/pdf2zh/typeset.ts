// Port of PDFMathTranslate 1.9.11 `pdf2zh/converter.py` TranslateConverter.receive_layout,
// part "C. 新文档排版". Behaviour is kept one-to-one; comments point at the original lines.
import type { LtLine, Pdf2zhFormula, Pdf2zhParagraph } from '../../../shared/pdf-types'

/** Resource names pdf2zh inserts into every /Font dictionary. */
export const TIRO = 'tiro'
export const NOTO = 'noto'

// LANG_LINEHEIGHT_MAP["zh"]
export const DEFAULT_LINE_HEIGHT = 1.4

export type TypesetFonts = {
  /** `fontmap["tiro"].to_unichr(ord(ch)) == ch` */
  tiroHas(ch: string): boolean
  /** `fontmap["tiro"].char_width(ord(ch))` (per 1 pt of font size) */
  tiroWidth(ch: string): number
  /** `noto.char_lengths(ch, size)[0]` */
  notoWidth(ch: string, size: number): number
  /** raw_string(noto, cstk): hex glyph ids */
  notoHex(text: string): string
}

export type TypesetUnit = {
  paragraphs: readonly Pdf2zhParagraph[]
  formulas: readonly Pdf2zhFormula[]
  lines: readonly LtLine[]
}

type OpVal =
  | { type: 'text'; font: string; size: number; x: number; dy: number; rtxt: string; lidx: number }
  | {
      type: 'line'
      x: number
      dy: number
      linewidth: number
      xlen: number
      ylen: number
      lidx: number
    }

/** Python `f"{x:f}"` */
function f(value: number): string {
  return value.toFixed(6)
}

function genOpTxt(font: string, size: number, x: number, y: number, rtxt: string): string {
  return `/${font} ${f(size)} Tf 1 0 0 1 ${f(x)} ${f(y)} Tm [<${rtxt}>] TJ `
}

function genOpLine(x: number, y: number, xlen: number, ylen: number, linewidth: number): string {
  return `ET q 1 0 0 1 ${f(x)} ${f(y)} cm [] 0 d 0 J ${f(linewidth)} w 0 0 m ${f(xlen)} ${f(ylen)} l S Q BT `
}

/** raw_string for an original font: the character code in its own byte width. */
export function codeHex(code: number, codeBytes: number): string {
  return Math.max(0, Math.trunc(code))
    .toString(16)
    .padStart(Math.max(1, Math.min(4, codeBytes)) * 2, '0')
}

// \{\s*v([\d\s]+)\} with re.IGNORECASE; Python's \d is any Unicode decimal digit.
const MARKER_RE = /\{\s*v([\p{Nd}\s]+)\}/iuy
const MODIFIER_RE = /^[\p{Lm}\p{Mn}\p{Sk}]/u

function markerId(group: string): number | undefined {
  const digits = group.replace(/\s/g, '').normalize('NFKC')
  if (!/^\d+$/.test(digits)) return undefined
  return Number.parseInt(digits, 10)
}

/**
 * Builds the text operators of one LTPage/LTFigure: `BT {ops_list} ET `.
 * @param news translated paragraph strings (same order as `unit.paragraphs`).
 */
export function typesetUnit(
  unit: TypesetUnit,
  news: readonly string[],
  fonts: TypesetFonts,
  lineHeight = DEFAULT_LINE_HEIGHT,
): string {
  const opsList: string[] = []
  const rawString = (font: string, cstk: string): string => {
    if (font === NOTO) return fonts.notoHex(cstk)
    // tiro is a simple font: one byte per character.
    return [...cstk].map((c) => (c.codePointAt(0) ?? 0).toString(16).padStart(2, '0')).join('')
  }

  news.forEach((text, id) => {
    const para = unit.paragraphs[id]
    if (!para) return
    let x = para.x
    const y = para.y
    const x0 = para.x0
    const x1 = para.x1
    const height = para.y1 - para.y0
    const size = para.size
    const brk = para.brk
    let cstk = ''
    let fcur: string | undefined
    let lidx = 0
    let tx = x
    let fcurNext = fcur
    const opsVals: OpVal[] = []

    let pos = 0 // UTF-16 index into `text` (ptr counts code points in Python)
    while (pos < text.length) {
      MARKER_RE.lastIndex = pos
      const vy = MARKER_RE.exec(text)
      let mod = 0
      let adv: number
      let vid = 0
      let ch = ''
      if (vy) {
        pos += vy[0].length
        const parsed = markerId(vy[1] ?? '')
        const formula = parsed === undefined ? undefined : unit.formulas[parsed]
        if (parsed === undefined || !formula) continue // 翻译器可能会自动补个越界的公式标记
        vid = parsed
        adv = formula.len
        const lastChar = formula.chars.at(-1)
        if (lastChar?.text && MODIFIER_RE.test(lastChar.text)) {
          mod = lastChar.x1 - lastChar.x0
        }
      } else {
        ch = String.fromCodePoint(text.codePointAt(pos) ?? 0)
        fcurNext = undefined
        if (fonts.tiroHas(ch)) fcurNext = TIRO
        if (fcurNext === undefined) fcurNext = NOTO
        adv = fcurNext === NOTO ? fonts.notoWidth(ch, size) : fonts.tiroWidth(ch) * size
        pos += ch.length
      }
      // 输出文字缓冲区
      if (fcurNext !== fcur || vy || x + adv > x1 + 0.1 * size) {
        if (cstk) {
          opsVals.push({
            type: 'text',
            font: fcur ?? NOTO,
            size,
            x: tx,
            dy: 0,
            rtxt: rawString(fcur ?? NOTO, cstk),
            lidx,
          })
          cstk = ''
        }
      }
      if (brk && x + adv > x1 + 0.1 * size) {
        x = x0
        lidx += 1
      }
      if (vy) {
        const formula = unit.formulas[vid]!
        let fix = 0
        if (fcur !== undefined) fix = formula.fix
        const first = formula.chars[0]!
        for (const vch of formula.chars) {
          // A glyph whose operator could not be paired has no resource name to draw with.
          if (!vch.font) continue
          opsVals.push({
            type: 'text',
            font: vch.font,
            size: vch.size,
            x: x + vch.x0 - first.x0,
            dy: fix + vch.y0 - first.y0,
            rtxt: codeHex(vch.code, vch.codeBytes),
            lidx,
          })
        }
        for (const l of formula.lines) {
          if (l.linewidth < 5) {
            opsVals.push({
              type: 'line',
              x: l.pts[0][0] + x - first.x0,
              dy: l.pts[0][1] + fix - first.y0,
              linewidth: l.linewidth,
              xlen: l.pts[1][0] - l.pts[0][0],
              ylen: l.pts[1][1] - l.pts[0][1],
              lidx,
            })
          }
        }
      } else {
        if (!cstk) {
          tx = x
          if (x === x0 && ch === ' ')
            adv = 0 // 消除段落换行空格
          else cstk += ch
        } else {
          cstk += ch
        }
      }
      adv -= mod
      fcur = fcurNext
      x += adv
    }
    // 处理结尾
    if (cstk) {
      opsVals.push({
        type: 'text',
        font: fcur ?? NOTO,
        size,
        x: tx,
        dy: 0,
        rtxt: rawString(fcur ?? NOTO, cstk),
        lidx,
      })
    }

    let lh = lineHeight
    while ((lidx + 1) * size * lh > height && lh >= 1) lh -= 0.05

    for (const vals of opsVals) {
      const yy = vals.dy + y - vals.lidx * size * lh
      if (vals.type === 'text') opsList.push(genOpTxt(vals.font, vals.size, vals.x, yy, vals.rtxt))
      else opsList.push(genOpLine(vals.x, yy, vals.xlen, vals.ylen, vals.linewidth))
    }
  })

  for (const l of unit.lines) {
    if (l.linewidth < 5) {
      opsList.push(
        genOpLine(
          l.pts[0][0],
          l.pts[0][1],
          l.pts[1][0] - l.pts[0][0],
          l.pts[1][1] - l.pts[0][1],
          l.linewidth,
        ),
      )
    }
  }
  return `BT ${opsList.join('')}ET `
}
