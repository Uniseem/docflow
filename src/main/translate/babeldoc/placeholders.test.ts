import { describe, expect, test } from 'vitest'
import { analysisOf, BOLD_SERIF, line, ltChar, unitOf } from '../../../../tests/unit/layout-units'
import { FontMapper } from '../../pdf/babeldoc/fontmap'
import { baseStyle, buildParagraphs, getCharUnicodeString } from './paragraphs'
import { getTranslateInput, parseTranslateOutput } from './placeholders'

const mapper = new FontMapper('auto', () => true)
const BOLD = { font: 'F2', fontname: 'ABCDEF+NimbusRomNo9L-Medi' }
const MATH = { font: 'F3', fontname: 'ABCDEF+CMMI10' }

function paragraph(items: ReturnType<typeof line>, fonts = {}) {
  const unit = unitOf(items, { fonts })
  const [p] = buildParagraphs(analysisOf([unit]))
  return p!
}

function input(p: ReturnType<typeof paragraph>, disableRichText = false) {
  return getTranslateInput(p, { disableRichText, mapper, fonts: p.unit.fonts })
}

describe('StylesAndFormulas base style and runs', () => {
  const s = (size: number) => ({ font: 'F1', size, gstate: '' })
  test('_merge_styles restarts from the next style once the size became None', () => {
    expect(baseStyle([s(10), s(10), s(12), s(12), s(12)])!.size).toBe(12)
    expect(baseStyle([s(12), s(10), s(10)])!.size).toBe(10)
    // Two sizes and nothing after: the mode, first seen on a tie.
    expect(baseStyle([s(10), s(12)])!.size).toBe(10)
  })

  test('a colour that differs clears the base graphic state', () => {
    const base = baseStyle([s(10), { font: 'F1', size: 10, gstate: '1 0 0 rg' }])
    expect(base).toEqual({ font: 'F1', size: 10, gstate: null })
  })

  test('runs follow the first character style, dummy spaces take the previous one', () => {
    const p = paragraph(
      [...line('Hello', 10, 700), ...line('bold', 40, 700, BOLD), ...line('world', 65, 700)],
      {
        F2: BOLD_SERIF,
      },
    )
    const runs = p.compositions.map((c) =>
      c.kind === 'run' ? `${c.style.font}:${c.chars.map((ch) => ch.text).join('')}` : 'f',
    )
    expect(runs).toEqual(['F1:Hello ', 'F2:bold ', 'F1:world'])
    expect(p.unicode).toBe('Hello bold world')
    expect(p.base).toEqual({ font: 'F1', size: 10, gstate: '' })
  })
})

describe('get_translate_input', () => {
  test('one run: the paragraph unicode, no placeholders', () => {
    const got = input(paragraph(line('Plain text here', 10, 700)))
    expect(got?.unicode).toBe('Plain text here')
    expect(got?.placeholders).toEqual([])
  })

  test('a bold span mapped to another font gets a style placeholder', () => {
    const p = paragraph(
      [...line('Hello', 10, 700), ...line('bold', 40, 700, BOLD), ...line('world', 65, 700)],
      { F2: BOLD_SERIF },
    )
    expect(input(p)?.unicode).toBe("Hello <style id='1'>bold </style>world")
    expect(input(p, true)?.unicode).toBe('Hello bold world')
  })

  test('formulas become {vN} numbered from 1 in the paragraph', () => {
    const p = paragraph([...line('a', 10, 700), ltChar('x', 20, 700, MATH), ...line('b', 30, 700)])
    expect(p.unit.texts).toEqual(['a {v0} b'])
    expect(input(p)?.unicode).toBe('a {v1} b')
  })

  test('a paragraph that starts with the placeholder text shifts the number', () => {
    const p = paragraph([
      ...line('{v1}', 10, 700),
      ...line('is', 35, 700),
      ltChar('x', 50, 700, MATH),
      ...line('ok', 60, 700),
    ])
    expect(input(p)?.unicode).toBe('{v1} is {v2} ok')
  })

  test('pure numbers, a lone formula and blank paragraphs are not translated', () => {
    expect(input(paragraph(line('12.5', 10, 700)))).toBeUndefined()
    expect(input(paragraph([ltChar('x', 10, 700, MATH)]))).toBeUndefined()
  })

  test('more than 40 placeholders turn rich text off for the paragraph', () => {
    // 21 bold spans and 20 formulas over three lines: 41 placeholders.
    const items = []
    for (let i = 0; i < 21; i += 1) {
      const x = 10 + (i % 7) * 80
      const y = 700 - Math.floor(i / 7) * 15
      items.push(...line('ab', x, y), ...line('cd', x + 20, y, BOLD))
      if (i < 20) items.push(ltChar('x', x + 40, y, MATH))
    }
    const p = paragraph(items, { F2: BOLD_SERIF })
    expect(p.unit.texts).toHaveLength(1)
    const got = input(p)
    expect(got?.placeholders).toHaveLength(20)
    expect(got?.placeholders.every((ph) => ph.kind === 'formula')).toBe(true)
    expect(got?.unicode).not.toContain('<style')
  })
})

describe('parse_translate_output', () => {
  const p = paragraph(
    [
      ...line('Hello', 10, 700),
      ...line('bold', 40, 700, BOLD),
      ltChar('x', 65, 700, MATH),
      ...line('world', 75, 700),
    ],
    { F2: BOLD_SERIF },
  )
  const ti = input(p)!

  test('the input marks the span and the formula', () => {
    expect(ti.unicode).toBe("Hello <style id='1'>bold </style>{v3} world")
  })

  test('text, styled span and formula come back as compositions', () => {
    const out = parseTranslateOutput(ti, "你好<style id='1'>粗体</style>{v3}世界")
    expect(out).toEqual([
      { kind: 'text', text: '你好', style: { font: 'F1', size: 10, gstate: '' } },
      { kind: 'text', text: '粗体', style: { font: 'F2', size: 10, gstate: '' } },
      { kind: 'formula', index: 0 },
      { kind: 'text', text: '世界', style: { font: 'F1', size: 10, gstate: '' } },
    ])
  })

  test('a span left as it was keeps its original glyphs', () => {
    const out = parseTranslateOutput(ti, "你好 < style id = '1' >bold</style> {v3}")
    expect(out[1]).toEqual({ kind: 'original', from: 6, to: 11 })
  })

  test('placeholders the model invented are dropped', () => {
    const out = parseTranslateOutput(ti, "你好{v9}<style id='1'>粗体</style>{v3}世界</style>")
    expect(out.map((c) => (c.kind === 'text' ? c.text : c.kind))).toEqual([
      '你好',
      '粗体',
      'formula',
      '世界',
    ])
  })
})

describe('get_char_unicode_string', () => {
  test('inserts a space at a line break and at a wide gap', () => {
    const c = (text: string, x0: number, y0: number) => ({ text, x0, y0, x1: x0 + 5, y1: y0 + 10 })
    expect(getCharUnicodeString([c('a', 10, 700), c('b', 15, 700), c('c', 10, 680)])).toBe('ab c')
    expect(
      getCharUnicodeString([c('a', 10, 700), c('b', 18, 700), c('c', 23, 700), c('d', 31, 700)]),
    ).toBe('a bc d')
  })
})
