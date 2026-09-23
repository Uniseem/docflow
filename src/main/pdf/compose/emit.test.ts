import { describe, expect, test } from 'vitest'
import { encodeCharCode, colorOp, groupFormulaGlyphs, emitTextRun, emitPageOps } from './emit'
import type { MappedFont } from './fonts'
import type { LayoutResult } from './layout'
import { spliceRanges, shouldSkipPage, deletionSet, inSharedForm } from './rewrite'
import type { Glyph, Paragraph } from '../../../shared/pdf-types'
import { PDFRef } from '@cantoo/pdf-lib'
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

  test('restores the paragraph colour after a coloured formula run', () => {
    const red = glyph({ color: [1, 0, 0], code: 0x78 })
    const para: Paragraph = {
      id: '0-0',
      page: 0,
      bbox: [72, 690, 300, 710],
      lines: [{ bbox: [72, 690, 300, 710], baseline: 700, opSeqs: [0] }],
      size: 10,
      lineHeight: 12,
      bold: false,
      align: 'left',
      color: [0, 0, 0],
      role: 'body',
      text: '令 {v0} 为',
      runs: [
        { id: 0, glyphs: [red], bbox: [72, 698, 78, 708], baselineOffset: 0, width: 6, text: 'x' },
      ],
      formPath: '',
      translatable: true,
    }
    const layout: LayoutResult = {
      lines: [
        {
          baseline: 700,
          width: 30,
          tokens: [
            { kind: 'text', text: '令', x: 72, width: 10 },
            { kind: 'formula', id: 0, x: 82, width: 6 },
            { kind: 'text', text: '为', x: 88, width: 10 },
          ],
        },
      ],
      fontSize: 10,
      lineHeight: 12,
      overflow: false,
      fontScale: 1,
    }
    const aliases = new Map<string, MappedFont>([
      ['g_d0_f1', { fontKey: 'g_d0_f1', resourceName: 'F1', ref: PDFRef.of(9), alias: 'DFo1' }],
    ])
    const out = emitPageOps(
      [para],
      new Map([[para.id, layout]]),
      (text) => `<${Buffer.from(text).toString('hex')}>`,
      aliases,
      () => 'DFcjk',
    )
    const afterFormula = out.slice(out.indexOf('<78> Tj'))
    const black = afterFormula.indexOf('0.000 0.000 0.000 rg')
    const nextText = afterFormula.indexOf('/DFcjk')
    expect(black).toBeGreaterThan(0)
    expect(black).toBeLessThan(nextText)
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

  test('treats forms nested in a shared form as shared', () => {
    const shared = new Set(['3'])
    expect(inSharedForm('3', shared)).toBe(true)
    expect(inSharedForm('3/1', shared)).toBe(true)
    expect(inSharedForm('3/1/2', shared)).toBe(true)
    expect(inSharedForm('31', shared)).toBe(false)
    expect(inSharedForm('1/3', shared)).toBe(false)
    expect(inSharedForm('', shared)).toBe(false)
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
