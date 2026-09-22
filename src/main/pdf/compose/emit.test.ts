import { describe, expect, test } from 'vitest'
import { encodeCharCode, colorOp, groupFormulaGlyphs, emitTextRun } from './emit'
import { spliceRanges, shouldSkipPage, deletionSet } from './rewrite'
import type { Glyph } from '../../../shared/pdf-types'
import type { TextOp } from './content-walker'

function glyph(partial: Partial<Glyph>): Glyph {
  return {
    page: 0,
    opSeq: 0,
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
    trm: [10, 0, 0, 10, 72, 700],
    x: 72,
    y: 700,
    size: 10,
    adv: 6,
    width: 6,
    ascent: 0.8,
    descent: -0.2,
    rotated: false,
    vertical: false,
    renderMode: 0,
    color: [0, 0, 0],
    isSpace: false,
    ...partial,
  }
}

describe('emit encoding', () => {
  test('encodes 1 and 2 byte character codes as big-endian hex', () => {
    expect(encodeCharCode(0x41, 1)).toBe('41')
    expect(encodeCharCode(0x4e2d, 2)).toBe('4E2D')
  })

  test('emits rg colors with 3 decimals', () => {
    expect(colorOp([0.5, 0, 1])).toBe('0.500 0.000 1.000 rg')
  })

  test('merges adjacent same-font glyphs and splits on gaps', () => {
    const a = glyph({ x: 10, adv: 6, code: 1 })
    const b = glyph({ x: 16, adv: 6, code: 2 })
    const c = glyph({ x: 40, adv: 6, code: 3 })
    const groups = groupFormulaGlyphs([a, b, c])
    expect(groups).toHaveLength(2)
    expect(groups[0]?.glyphs).toHaveLength(2)
    expect(groups[1]?.glyphs).toHaveLength(1)
  })

  test('Tj hex uses pdf-lib style brackets', () => {
    expect(emitTextRun('DFcjk', 10, 72, 700, '<ABCD>')).toContain('<ABCD> Tj')
  })
})

describe('rewrite', () => {
  test('splices byte ranges while keeping the rest', () => {
    const bytes = Buffer.from('AAA BBB CCC')
    const out = spliceRanges(bytes, [
      [4, 7],
      [8, 11],
    ])
    expect(Buffer.from(out).toString()).toBe('AAA  ')
  })

  test('skips a page when mismatch exceeds 10%', () => {
    expect(shouldSkipPage(9, 10)).toBe(false)
    expect(shouldSkipPage(8, 10)).toBe(true)
  })

  test('deletion set uses padded boxes and form path', () => {
    const ops: TextOp[] = [
      { tokenRange: [0, 4], start: [72, 700], fontName: 'F1', formPath: '', seq: 0 },
      { tokenRange: [5, 9], start: [72, 10], fontName: 'F1', formPath: '', seq: 1 },
    ]
    const { deleted, expected, mismatch } = deletionSet(ops, [
      {
        id: '0-0',
        page: 0,
        bbox: [70, 698, 80, 710],
        lines: [{ bbox: [70, 698, 80, 710], baseline: 700, opSeqs: [0] }],
        size: 10,
        lineHeight: 12,
        bold: false,
        align: 'left',
        color: [0, 0, 0],
        role: 'body',
        text: 'Hi',
        runs: [],
        formPath: '',
        translatable: true,
      },
    ])
    expect(expected).toBe(1)
    expect(deleted).toHaveLength(1)
    expect(deleted[0]?.seq).toBe(0)
    expect(mismatch).toBe(false)
  })
})
