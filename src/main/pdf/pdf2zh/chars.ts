// pdf.js glyphs as the pdfminer LTChar objects pdf2zh's converter receives, and the join of
// the glyphs with the raw show-text operators (whose Tf names pdf2zh uses to redraw formulas).
import type { Glyph, LtChar, Matrix } from '../../../shared/pdf-types'
import { applyMatrixPt, multMatrix, type TextOpInfo } from './interp'

/**
 * pdfminer LTChar for a glyph: the (0, rise)–(adv, rise + size) box through the char matrix
 * (which includes the page CTM). `size` is the box width for a vertical font or a glyph
 * turned by 90° (matrix[0] == 0), else its height (BabelDOC; pdfminer 20250416 only checks
 * the font, so a turned glyph got its advance as size).
 */
export function toLtChar(
  glyph: Glyph,
  pageCtm: Matrix,
  font: string,
  text = glyph.unicode || `(cid:${glyph.code})`,
  gstate = '',
): LtChar {
  const [llx, lly, urx, ury] = glyph.corners
  const a = applyMatrixPt(pageCtm, llx, lly)
  const b = applyMatrixPt(pageCtm, urx, ury)
  const x0 = Math.min(a[0], b[0])
  const x1 = Math.max(a[0], b[0])
  const y0 = Math.min(a[1], b[1])
  const y1 = Math.max(a[1], b[1])
  const matrix = multMatrix(glyph.trm, pageCtm)
  return {
    text,
    x0,
    y0,
    x1,
    y1,
    size: glyph.vertical || matrix[0] === 0 ? x1 - x0 : y1 - y0,
    vertical: matrix[0] === 0 && matrix[3] === 0,
    angle: (Math.atan2(matrix[1], matrix[0]) * 180) / Math.PI,
    fontname: glyph.fontName,
    font,
    code: glyph.code,
    codeBytes: glyph.codeBytes,
    gstate,
  }
}

const ALIGN_TOLERANCE = 1
// Share of operators whose first glyph must sit on the raw operator's start point before the
// one-to-one mapping is trusted.
const ALIGN_MIN_AGREEMENT = 0.95

/**
 * Maps pdf.js show-text operator numbers (Glyph.opSeq) to the raw operators. Both count in
 * execution order, so equal counts map one to one; otherwise operators are paired in order
 * within each form by their starting point.
 */
export function alignTextOps(
  glyphs: readonly Glyph[],
  textOps: readonly TextOpInfo[],
  pageCtm: Matrix,
): Map<number, TextOpInfo> {
  const firsts = new Map<number, Glyph>()
  let maxSeq = -1
  for (const glyph of glyphs) {
    if (!firsts.has(glyph.opSeq)) firsts.set(glyph.opSeq, glyph)
    maxSeq = Math.max(maxSeq, glyph.opSeq)
  }
  const mapped = new Map<number, TextOpInfo>()
  const near = (op: TextOpInfo, glyph: Glyph) => {
    const origin = applyMatrixPt(pageCtm, glyph.x, glyph.y)
    if (!op.positioned) return Math.abs(op.start[1] - origin[1]) <= ALIGN_TOLERANCE
    return Math.hypot(op.start[0] - origin[0], op.start[1] - origin[1]) <= ALIGN_TOLERANCE
  }
  if (maxSeq < textOps.length) {
    let samePath = true
    let agree = 0
    for (const [seq, glyph] of firsts) {
      const op = textOps[seq]
      if (!op || op.formPath !== glyph.formPath) samePath = false
      else if (near(op, glyph)) agree += 1
    }
    if (samePath && agree >= firsts.size * ALIGN_MIN_AGREEMENT) {
      for (const seq of firsts.keys()) mapped.set(seq, textOps[seq]!)
      return mapped
    }
  }
  const byPath = new Map<string, TextOpInfo[]>()
  for (const op of textOps) {
    const list = byPath.get(op.formPath) ?? []
    list.push(op)
    byPath.set(op.formPath, list)
  }
  const cursor = new Map<string, number>()
  for (const [seq, glyph] of [...firsts].sort((a, b) => a[0] - b[0])) {
    const list = byPath.get(glyph.formPath) ?? []
    for (let i = cursor.get(glyph.formPath) ?? 0; i < list.length; i += 1) {
      const op = list[i]!
      if (near(op, glyph)) {
        mapped.set(seq, op)
        cursor.set(glyph.formPath, i + 1)
        break
      }
    }
  }
  return mapped
}
