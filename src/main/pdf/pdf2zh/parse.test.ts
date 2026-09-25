import { describe, expect, test } from 'vitest'
import type { LtChar } from '../../../shared/pdf-types'
import { buildLayoutMap, type LayoutMap } from './doclayout'
import { isFormulasFont, parseLayout, vflag, type LtItem } from './parse'

/** A layout map of one class everywhere (a single text box covering the page). */
function flat(cls = 2, width = 600, height = 800): LayoutMap {
  return { width, height, cls: new Int32Array(width * height).fill(cls) }
}

function char(text: string, x: number, y: number, extra: Partial<LtChar> = {}): LtItem {
  const size = extra.size ?? 10
  const width = extra.x1 !== undefined ? extra.x1 - x : 5
  return {
    kind: 'char',
    text,
    x0: x,
    y0: y,
    x1: x + width,
    y1: y + size,
    size,
    vertical: false,
    angle: 0,
    fontname: 'ABCDEF+Times-Roman',
    font: 'F1',
    code: text.charCodeAt(0),
    codeBytes: 1,
    gstate: '',
    ...extra,
  }
}

/** Characters of `word` laid out left to right from x. */
function word(text: string, x: number, y: number, extra: Partial<LtChar> = {}): LtItem[] {
  return [...text].map((c, i) => char(c, x + i * 5, y, extra))
}

describe('vflag (formula fonts and characters)', () => {
  test.each([
    ['CMMI10', 'x', true],
    ['XYZ+CMSY10', 'a', true],
    ['CMR10', 'a', false],
    ['Courier-Mono', 'a', true],
    ['NimbusRomNo9L-ReguItal', 'a', true],
    ['Times-Roman', 'α', true], // Greek block
    ['Times-Roman', '+', true], // Sm
    ['Times-Roman', '́', true], // Mn
    ['Times-Roman', ' ', false],
    ['Times-Roman', '(cid:12)', true],
    ['Times-Roman', 'a', false],
  ])('%s %j → %s', (font, text, expected) => {
    expect(vflag(font, text)).toBe(expected)
  })
})

describe('parseLayout (receive_layout part A)', () => {
  test('words on one line build one paragraph, a gap adds a space', () => {
    const unit = parseLayout([...word('ab', 10, 700), ...word('cd', 30, 700)], flat(), 600)
    expect(unit.texts).toEqual(['ab cd'])
    expect(unit.paragraphs[0]).toMatchObject({ x: 10, y: 700, x0: 10, x1: 40, brk: false })
  })

  test('a return to the left marks the paragraph as broken (brk)', () => {
    // child.x1 < xt.x0: the next line ends left of where the previous character began.
    const unit = parseLayout([...word('ab', 10, 700), ...word('cd', 0, 685)], flat(), 600)
    expect(unit.texts).toEqual(['ab cd'])
    expect(unit.paragraphs[0]!.brk).toBe(true)
  })

  test('another layout class starts another paragraph', () => {
    const map = buildLayoutMap({
      width: 600,
      height: 800,
      boxes: [
        { name: 'plain text', conf: 0.9, xyxy: [0, 0, 600, 200] },
        { name: 'plain text', conf: 0.8, xyxy: [0, 300, 600, 800] },
      ],
    })
    const unit = parseLayout([...word('top', 10, 700), ...word('low', 10, 100)], map, 600)
    expect(unit.texts).toEqual(['top', 'low'])
  })

  test('characters in preserved boxes and bullets become formulas', () => {
    const map = buildLayoutMap({
      width: 600,
      height: 800,
      boxes: [{ name: 'figure', conf: 0.9, xyxy: [0, 0, 600, 200] }],
    })
    const unit = parseLayout(word('fig', 10, 700), map, 600)
    expect(unit.texts).toEqual(['{v0}'])
    expect(unit.formulas[0]!.chars.map((c) => c.text).join('')).toBe('fig')
    expect(parseLayout([char('•', 10, 700)], flat(), 600).texts).toEqual(['{v0}'])
  })

  test('formula fonts, subscripts (< 0.79 size) and brackets after a formula', () => {
    const items = [
      ...word('Let', 10, 700),
      char('x', 30, 700, { fontname: 'CMMI10' }),
      char('(', 35, 700),
      char('t', 40, 700),
      char(')', 45, 700),
      char('2', 50, 697, { size: 7 }),
      ...word('be', 70, 700),
    ]
    const unit = parseLayout(items, flat(), 600)
    // Only "(" (while a formula is open) and the matching ")" join it: t is text again.
    expect(unit.texts).toEqual(['Let {v0}t{v1} be'])
    expect(unit.formulas.map((f) => f.chars.map((c) => c.text).join(''))).toEqual(['x(', ')2'])
  })

  test('vfix: the formula baseline relative to the text before it', () => {
    const unit = parseLayout(
      [...word('ab', 10, 700), char('x', 25, 703, { fontname: 'CMMI10' }), ...word('cd', 40, 700)],
      flat(),
      600,
    )
    expect(unit.formulas[0]!.fix).toBe(3)
  })

  test('a paragraph that starts with a formula stays a pure formula', () => {
    const unit = parseLayout(
      [char('x', 10, 700, { fontname: 'CMMI10' }), ...word('text', 30, 700)],
      flat(),
      600,
    )
    expect(unit.texts).toEqual(['{v0}', 'text'])
  })

  test('the second character sets size and moves y (首字母放大)', () => {
    const unit = parseLayout(
      [char('A', 10, 700, { size: 20 }), ...word('bc', 30, 700)],
      flat(),
      600,
    )
    expect(unit.paragraphs[0]).toMatchObject({ size: 10, y: 710 })
    // A character larger than the paragraph also takes over.
    const big = parseLayout([...word('ab', 10, 700), char('C', 20, 700, { size: 14 })], flat(), 600)
    expect(big.paragraphs[0]).toMatchObject({ size: 14, y: 696 })
  })

  test('vlen is the formula width; lines inside a formula move with it', () => {
    const unit = parseLayout(
      [
        ...word('ab', 10, 700),
        char('x', 25, 705, { fontname: 'CMMI10', x1: 30 }),
        {
          kind: 'line',
          x0: 25,
          y0: 703,
          pts: [
            [25, 703],
            [35, 703],
          ],
          linewidth: 0.4,
        },
        char('y', 25, 695, { fontname: 'CMMI10', x1: 32 }),
        ...word('cd', 45, 700),
        {
          kind: 'line',
          x0: 0,
          y0: 100,
          pts: [
            [0, 100],
            [600, 100],
          ],
          linewidth: 1,
        },
      ],
      flat(),
      600,
    )
    expect(unit.formulas[0]!.len).toBe(7)
    expect(unit.formulas[0]!.lines).toHaveLength(1)
    expect(unit.lines).toHaveLength(1)
  })

  test('a wide jump inside text ends the formula (vmax = width / 4)', () => {
    const unit = parseLayout(
      [
        ...word('ab', 10, 700),
        char('x', 20, 700, { fontname: 'CMMI10' }),
        char('y', 200, 690, { fontname: 'CMMI10' }),
      ],
      flat(),
      600,
    )
    // The formula ends, then the gap to the next character adds a space.
    expect(unit.texts).toEqual(['ab{v0} {v1}'])
  })
})

describe('BabelDOC rules (parseLayout without strict)', () => {
  test.each([
    ['ABCDEF+Times-Italic', false], // pdf2zh: .*Ital
    ['NimbusRomNo9L-ReguItal', false],
    ['CMBX10', false], // pdf2zh: CM[^R]
    ['CMTI10', false],
    ['CMR10', false],
    ['Symbol', false],
    ['CourierNewPSMT', false],
    ['CMMI10', true],
    ['XYZ+CMSY10', true],
    ['MSAM10', true],
    ['STIXMath-Regular', true],
    ['LatinModernMath-Regular', true],
    ['DejaVuSansMono', true],
  ])('is_formulas_font(%s) → %s', (font, expected) => {
    expect(isFormulasFont(font)).toBe(expected)
  })

  test("an italic sentence is text; strict keeps pdf2zh's .*Ital rule", () => {
    const items = word('word', 10, 700, { fontname: 'ABCDEF+Times-Italic' })
    expect(parseLayout(items, flat(), 600).texts).toEqual(['word'])
    expect(parseLayout(items, flat(), 600, { strict: true }).texts).toEqual(['{v0}'])
  })

  test('a space in a small font is text, not a subscript formula', () => {
    const items = [
      ...word('ab', 10, 700),
      char(' ', 20, 700, { size: 6.4, x1: 25 }),
      ...word('cd', 25, 700),
    ]
    const unit = parseLayout(items, flat(), 600)
    expect(unit.texts).toEqual(['ab cd'])
    expect(unit.formulas).toEqual([])
    expect(parseLayout(items, flat(), 600, { strict: true }).texts).toEqual(['ab{v0}cd'])
  })

  test('other whitespace becomes a space; a space inside a formula stays in it', () => {
    const nbsp = [...word('ab', 10, 700), char(' ', 20, 700), ...word('cd', 25, 700)]
    expect(parseLayout(nbsp, flat(), 600).texts).toEqual(['ab cd'])
    const math = [
      ...word('ab', 10, 700),
      char('x', 25, 700, { fontname: 'CMMI10' }),
      char(' ', 30, 700),
      char('y', 35, 700, { fontname: 'CMMI10' }),
    ]
    const unit = parseLayout(math, flat(), 600)
    expect(unit.texts).toEqual(['ab {v0}'])
    expect(unit.formulas[0]!.chars.map((c) => c.text)).toEqual(['x', ' ', 'y'])
  })

  test('a space in another layout box stays with the paragraph before it and adds no width', () => {
    const map = buildLayoutMap({
      width: 600,
      height: 800,
      boxes: [{ name: 'plain text', conf: 0.9, xyxy: [0, 90, 42, 110] }],
    })
    // "abc" in the box, two trailing spaces outside it, then the next line outside it too.
    const items = [
      ...word('abc', 10, 700),
      char(' ', 45, 700),
      char(' ', 50, 700),
      ...word('next', 10, 685),
    ]
    const unit = parseLayout(items, map, 600)
    expect(unit.texts).toEqual(['abc   ', 'next']) // the gap before the spaces adds one (pdf2zh)
    expect(unit.paragraphs[0]).toMatchObject({ x0: 10, x1: 25 })
    expect(parseLayout(items, map, 600, { strict: true }).texts).toEqual(['abc', '   next'])
  })

  test("the paragraph style is the text characters' common graphic state, else null", () => {
    const red = { gstate: '1 0 0 rg' }
    const same = parseLayout(
      [...word('ab', 10, 700, red), char('x', 25, 700, { fontname: 'CMMI10' })],
      flat(),
      600,
    )
    expect(same.paragraphs[0]!.gstate).toBe('1 0 0 rg')
    const mixed = parseLayout([...word('ab', 10, 700, red), ...word('cd', 25, 700)], flat(), 600)
    expect(mixed.paragraphs[0]!.gstate).toBeNull()
  })
})
