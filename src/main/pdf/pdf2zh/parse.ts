// Port of PDFMathTranslate 1.9.11 `pdf2zh/converter.py` TranslateConverter.receive_layout,
// part "A. 原文档解析". Behaviour is kept one-to-one; comments point at the original lines.
import type { LtChar, LtLine, Pdf2zhFormula, Pdf2zhParagraph } from '../../../shared/pdf-types'
import type { LayoutMap } from './doclayout'

export type LtItem = ({ kind: 'char' } & LtChar) | ({ kind: 'line' } & LtLine)

export type ParsedUnit = {
  /** sstk: paragraph strings with {vN} formula markers. */
  texts: string[]
  /** pstk */
  paragraphs: Pdf2zhParagraph[]
  /** var + varl + varf + vlen */
  formulas: Pdf2zhFormula[]
  /** lstk: lines outside formulas, redrawn in place. */
  lines: LtLine[]
}

// vflag: fonts of LaTeX and code (re.match anchors at the start).
const FORMULA_FONT_RE =
  /^(CM[^R]|MS.M|XY|MT|BL|RM|EU|LA|RS|LINE|LCIRCLE|TeX-|rsfs|txsy|wasy|stmary|.*Mono|.*Code|.*Ital|.*Sym|.*Math)/
// unicodedata.category(char[0]) in ["Lm", "Mn", "Sk", "Sm", "Zl", "Zp", "Zs"]
const FORMULA_CATEGORY_RE = /^[\p{Lm}\p{Mn}\p{Sk}\p{Sm}\p{Zl}\p{Zp}\p{Zs}]/u

/** Python `len(s.strip())`: code points after stripping whitespace. */
function strippedLength(s: string): number {
  return [...s.trim()].length
}

export function vflag(font: string, char: string): boolean {
  const name = font.split('+').pop() ?? ''
  if (/^\(cid:/.test(char)) return true
  if (FORMULA_FONT_RE.test(name)) return true
  if (char && char !== ' ') {
    const first = String.fromCodePoint(char.codePointAt(0) ?? 0)
    const code = first.codePointAt(0) ?? 0
    if (FORMULA_CATEGORY_RE.test(first) || (code >= 0x370 && code < 0x400)) return true
  }
  return false
}

/** Python `int()` truncates toward zero; numpy clip. */
function cell(value: number, max: number): number {
  return Math.min(Math.max(Math.trunc(value), 0), max - 1)
}

function layoutClass(layout: LayoutMap, x: number, y: number): number {
  const cx = cell(x, layout.width)
  const cy = cell(y, layout.height)
  return layout.cls[cy * layout.width + cx] ?? 1
}

/**
 * @param items LTChar / LTLine in content-stream order for one LTPage or LTFigure.
 * @param width ltpage.width (vmax = width / 4).
 */
export function parseLayout(
  items: readonly LtItem[],
  layout: LayoutMap,
  width: number,
): ParsedUnit {
  const sstk: string[] = []
  const pstk: Pdf2zhParagraph[] = []
  let vbkt = 0
  let vstk: LtChar[] = []
  let vlstk: LtLine[] = []
  let vfix = 0
  const formulas: Pdf2zhFormula[] = []
  const lstk: LtLine[] = []
  let xt: LtChar | undefined
  let xtCls = -1
  const vmax = width / 4

  const pushFormula = () => {
    formulas.push({ chars: vstk, lines: vlstk, fix: vfix, len: 0 })
  }

  for (const child of items) {
    if (child.kind === 'char') {
      let curV = false
      let cls = layoutClass(layout, child.x0, child.y0)
      // 锚定文档中 bullet 的位置
      if (child.text === '•') cls = 0
      const last = sstk.length - 1
      if (
        cls === 0 ||
        (cls === xtCls &&
          strippedLength(sstk[last] ?? '') > 1 &&
          child.size < (pstk[last]?.size ?? 0) * 0.79) ||
        vflag(child.fontname, child.text) ||
        child.vertical
      ) {
        curV = true
      }
      // 判定括号组是否属于公式
      if (!curV) {
        if (vstk.length > 0 && child.text === '(') {
          curV = true
          vbkt += 1
        }
        if (vbkt && child.text === ')') {
          curV = true
          vbkt -= 1
        }
      }
      if (
        !curV ||
        cls !== xtCls ||
        (sstk[sstk.length - 1] !== '' && Math.abs(child.x0 - (xt?.x0 ?? 0)) > vmax)
      ) {
        if (vstk.length > 0) {
          if (!curV && cls === xtCls && child.x0 > Math.max(...vstk.map((vch) => vch.x0))) {
            vfix = (vstk[0]?.y0 ?? 0) - child.y0
          }
          if (sstk[sstk.length - 1] === '') xtCls = -1
          sstk[sstk.length - 1] += `{v${formulas.length}}`
          pushFormula()
          vstk = []
          vlstk = []
          vfix = 0
        }
      }
      // 当前字符不属于公式或当前字符是公式的第一个字符
      if (vstk.length === 0) {
        if (cls === xtCls && xt) {
          if (child.x0 > xt.x1 + 1) {
            sstk[sstk.length - 1] += ' '
          } else if (child.x1 < xt.x0) {
            sstk[sstk.length - 1] += ' '
            pstk[pstk.length - 1]!.brk = true
          }
        } else {
          sstk.push('')
          pstk.push({
            y: child.y0,
            x: child.x0,
            x0: child.x0,
            x1: child.x0,
            y0: child.y0,
            y1: child.y1,
            size: child.size,
            brk: false,
          })
        }
      }
      const para = pstk[pstk.length - 1]!
      if (!curV) {
        if (
          (child.size > para.size || strippedLength(sstk[sstk.length - 1] ?? '') === 1) &&
          child.text !== ' '
        ) {
          para.y -= child.size - para.size
          para.size = child.size
        }
        sstk[sstk.length - 1] += child.text
      } else {
        if (vstk.length === 0 && cls === xtCls && xt && child.x0 > xt.x0) {
          vfix = child.y0 - xt.y0
        }
        vstk.push(child)
      }
      // 更新段落边界
      para.x0 = Math.min(para.x0, child.x0)
      para.x1 = Math.max(para.x1, child.x1)
      para.y0 = Math.min(para.y0, child.y0)
      para.y1 = Math.max(para.y1, child.y1)
      xt = child
      xtCls = cls
    } else {
      const cls = layoutClass(layout, child.x0, child.y0)
      if (vstk.length > 0 && cls === xtCls) vlstk.push(child)
      else lstk.push(child)
    }
  }
  // 处理结尾
  if (vstk.length > 0) {
    sstk[sstk.length - 1] += `{v${formulas.length}}`
    pushFormula()
  }
  for (const formula of formulas) {
    const first = formula.chars[0]
    formula.len = Math.max(...formula.chars.map((vch) => vch.x1)) - (first?.x0 ?? 0)
  }
  return { texts: sstk, paragraphs: pstk, formulas, lines: lstk }
}
