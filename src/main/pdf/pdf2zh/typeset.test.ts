import { describe, expect, test } from 'vitest'
import type { LtChar, Pdf2zhParagraph } from '../../../shared/pdf-types'
import { codeHex, typesetUnit, type TypesetFonts } from './typeset'

// Fixed-width stand-ins: tiro 0.5 em, noto 1 em; noto glyph ids are the code points.
const fonts: TypesetFonts = {
  tiroHas: (ch) => /^[\x20-\x7e]$/.test(ch),
  tiroWidth: () => 0.5,
  notoWidth: (_ch, size) => size,
  notoHex: (text) => [...text].map((c) => c.codePointAt(0)!.toString(16).padStart(4, '0')).join(''),
}

function para(extra: Partial<Pdf2zhParagraph> = {}): Pdf2zhParagraph {
  return {
    y: 700,
    x: 100,
    x0: 100,
    x1: 140,
    y0: 690,
    y1: 720,
    size: 10,
    brk: false,
    gstate: null,
    ...extra,
  }
}

function vchar(text: string, x0: number, y0: number, extra: Partial<LtChar> = {}): LtChar {
  return {
    text,
    x0,
    y0,
    x1: x0 + 4,
    y1: y0 + 8,
    size: 8,
    vertical: false,
    angle: 0,
    fontname: 'CMMI10',
    font: 'F7',
    code: text.charCodeAt(0),
    codeBytes: 1,
    gstate: '',
    ...extra,
  }
}

/** [font, size, x, y, hex] of every `/f s Tf 1 0 0 1 x y Tm [<hex>] TJ`. */
function runs(ops: string): Array<[string, number, number, number, string]> {
  const out: Array<[string, number, number, number, string]> = []
  const re = /\/(\S+) ([\d.-]+) Tf 1 0 0 1 ([\d.-]+) ([\d.-]+) Tm \[<([0-9a-f]*)>\] TJ /g
  for (const m of ops.matchAll(re)) {
    out.push([m[1]!, Number(m[2]), Number(m[3]), Number(m[4]), m[5]!])
  }
  return out
}

describe('typesetUnit (receive_layout part C)', () => {
  test('Latin goes to tiro, the rest to noto, one run per font change', () => {
    const ops = typesetUnit({ paragraphs: [para()], formulas: [], lines: [] }, ['ab中'], fonts)
    expect(ops.startsWith('BT ')).toBe(true)
    expect(ops.endsWith('ET ')).toBe(true)
    expect(runs(ops)).toEqual([
      ['tiro', 10, 100, 700, '6162'],
      ['noto', 10, 110, 700, '4e2d'],
    ])
  })

  test('without brk a paragraph never wraps; with brk it wraps at x1 + 0.1 size', () => {
    const text = '中'.repeat(6)
    const single = runs(
      typesetUnit({ paragraphs: [para()], formulas: [], lines: [] }, [text], fonts),
    )
    // Past x1 the buffer is still flushed into a new run, but the pen stays on the line.
    expect(single.map((r) => [r[2], r[3]])).toEqual([
      [100, 700],
      [140, 700],
      [150, 700],
    ])
    const wrapped = runs(
      typesetUnit({ paragraphs: [para({ brk: true })], formulas: [], lines: [] }, [text], fonts),
    )
    // Four 10 pt glyphs fit between x0 = 100 and x1 + 1 = 141; line height 1.4 → 14 pt.
    expect(wrapped.map((r) => [r[2], r[3]])).toEqual([
      [100, 700],
      [100, 686],
    ])
  })

  test('line height shrinks by 0.05 from 1.4 while the lines overflow the paragraph', () => {
    const text = '中'.repeat(12) // three lines
    const ops = typesetUnit(
      { paragraphs: [para({ brk: true, y0: 690, y1: 715 })], formulas: [], lines: [] },
      [text],
      fonts,
    )
    // (2 + 1) × 10 × lh > 25 while lh >= 1: in floating point 1.4 − 8 × 0.05 is
    // 0.9999999999999996 (as in Python), so the loop stops there.
    const ys = runs(ops).map((r) => r[3])
    expect(ys[1]).toBeCloseTo(700 - 10 * 0.9999999999999996, 5)
    expect(ys[2]).toBeCloseTo(700 - 20 * 0.9999999999999996, 5)
  })

  test('a formula is redrawn with its own font, size and code at the pen position', () => {
    const formula = {
      chars: [vchar('x', 50, 400), vchar('2', 55, 403, { size: 5 })],
      lines: [
        {
          x0: 50,
          y0: 399,
          pts: [
            [50, 399],
            [58, 399],
          ] as [[number, number], [number, number]],
          linewidth: 0.5,
        },
      ],
      fix: 2,
      len: 9,
    }
    const ops = typesetUnit(
      { paragraphs: [para({ x1: 400 })], formulas: [formula], lines: [] },
      ['ab{v0}c'],
      fonts,
    )
    expect(runs(ops)).toEqual([
      ['tiro', 10, 100, 700, '6162'],
      ['F7', 8, 110, 702, '78'],
      ['F7', 5, 115, 705, '32'],
      ['tiro', 10, 119, 700, '63'],
    ])
    expect(ops).toContain(
      'ET q 1 0 0 1 110.000000 701.000000 cm [] 0 d 0 J 0.500000 w 0 0 m 8.000000 0.000000 l S Q BT ',
    )
  })

  test('a leading formula gets no vertical fix; unknown markers are skipped', () => {
    const formula = { chars: [vchar('x', 50, 400)], lines: [], fix: 3, len: 4 }
    const ops = typesetUnit(
      { paragraphs: [para()], formulas: [formula], lines: [] },
      ['{v0}{ v7 }a'],
      fonts,
    )
    expect(runs(ops)).toEqual([
      ['F7', 8, 100, 700, '78'],
      ['tiro', 10, 104, 700, '61'],
    ])
  })

  test('a space at the start of a wrapped line is dropped', () => {
    const ops = typesetUnit(
      { paragraphs: [para({ brk: true, x1: 115 })], formulas: [], lines: [] },
      ['中 a'],
      fonts,
    )
    expect(runs(ops)).toEqual([
      ['noto', 10, 100, 700, '4e2d'],
      ['tiro', 10, 110, 700, '20'],
      ['tiro', 10, 100, 686, '61'],
    ])
  })

  test('lines outside formulas are redrawn in place (linewidth < 5 only)', () => {
    const ops = typesetUnit(
      {
        paragraphs: [],
        formulas: [],
        lines: [
          {
            x0: 10,
            y0: 20,
            pts: [
              [10, 20],
              [110, 20],
            ],
            linewidth: 1,
          },
          {
            x0: 10,
            y0: 30,
            pts: [
              [10, 30],
              [110, 30],
            ],
            linewidth: 6,
          },
        ],
      },
      [],
      fonts,
    )
    expect(ops).toBe(
      'BT ET q 1 0 0 1 10.000000 20.000000 cm [] 0 d 0 J 1.000000 w 0 0 m 100.000000 0.000000 l S Q BT ET ',
    )
  })

  test('codeHex writes the original code in its byte width', () => {
    expect(codeHex(0x41, 1)).toBe('41')
    expect(codeHex(0x41, 2)).toBe('0041')
    expect(codeHex(0x1f600, 3)).toBe('01f600')
  })
})
