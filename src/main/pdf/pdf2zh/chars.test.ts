import { describe, expect, test } from 'vitest'
import type { Glyph, Matrix } from '../../../shared/pdf-types'
import { alignTextOps, toLtChar } from './chars'
import type { TextOpInfo } from './interp'

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

function glyph(opSeq: number, x: number, y: number, extra: Partial<Glyph> = {}): Glyph {
  return {
    page: 0,
    opSeq,
    formPath: '',
    code: 65,
    unicode: 'A',
    fontKey: 'g_d0_f1',
    fontFamily: 'Times-Roman',
    composite: false,
    codeBytes: 1,
    bold: false,
    italic: false,
    type3: false,
    trm: [10, 0, 0, 10, x, y],
    x,
    y,
    size: 10,
    adv: 7,
    width: 7,
    corners: [x, y, x + 7, y + 10],
    fontName: 'ABCDEF+Times-Roman',
    ascent: 0.8,
    descent: -0.2,
    rotated: false,
    vertical: false,
    renderMode: 0,
    color: [0, 0, 0],
    isSpace: false,
    ...extra,
  }
}

function op(seq: number, x: number, y: number, extra: Partial<TextOpInfo> = {}): TextOpInfo {
  return {
    seq,
    font: `F${seq}`,
    formPath: '',
    start: [x, y],
    positioned: true,
    gstate: '',
    ...extra,
  }
}

describe('toLtChar', () => {
  test('box through the page CTM; size is the box height; unknown text becomes (cid:N)', () => {
    const char = toLtChar(glyph(0, 110, 720, { unicode: '' }), [1, 0, 0, 1, -10, -20], 'F1')
    expect(char).toMatchObject({ x0: 100, y0: 700, x1: 107, y1: 710, size: 10, text: '(cid:65)' })
    expect(char.vertical).toBe(false)
  })

  test('glyphs rotated by 90° are vertical for pdfminer (matrix[0] == matrix[3] == 0)', () => {
    const char = toLtChar(glyph(0, 100, 100, { trm: [0, -10, 10, 0, 100, 100] }), IDENTITY, 'F1')
    expect(char.vertical).toBe(true)
    expect(char.angle).toBe(-90)
  })

  test('a turned glyph takes the box width as size (BabelDOC); the graphic state is kept', () => {
    // 90°: the box is 10 wide (the font size) and 7 high (the advance).
    const turned = glyph(0, 100, 100, {
      trm: [0, 10, -10, 0, 100, 100],
      corners: [90, 100, 100, 107],
    })
    const char = toLtChar(turned, IDENTITY, 'F1', 'A', '/CS0 cs 1 sc')
    expect(char).toMatchObject({ size: 10, angle: 90, vertical: true, gstate: '/CS0 cs 1 sc' })
  })
})

describe('alignTextOps', () => {
  test('equal counts map one to one when the start points agree', () => {
    const glyphs = [glyph(0, 72, 700), glyph(1, 72, 688)]
    const map = alignTextOps(glyphs, [op(0, 72, 700), op(1, 72, 688)], IDENTITY)
    expect([...map].map(([seq, info]) => [seq, info.font])).toEqual([
      [0, 'F0'],
      [1, 'F1'],
    ])
  })

  test('an operator that continues the line is checked on its baseline only', () => {
    const glyphs = [glyph(0, 72, 700), glyph(1, 140, 700)]
    const ops = [op(0, 72, 700), op(1, 72, 700, { positioned: false })]
    expect(alignTextOps(glyphs, ops, IDENTITY).get(1)?.font).toBe('F1')
  })

  test('when pdf.js has an operator the raw stream lacks, operators pair by position', () => {
    // pdf.js numbered an extra operator first: its seq numbers are shifted by one.
    const glyphs = [glyph(0, 10, 10), glyph(1, 72, 700), glyph(2, 72, 688)]
    const map = alignTextOps(glyphs, [op(0, 72, 700), op(1, 72, 688)], IDENTITY)
    expect(map.has(0)).toBe(false)
    expect(map.get(1)?.font).toBe('F0')
    expect(map.get(2)?.font).toBe('F1')
  })
})
