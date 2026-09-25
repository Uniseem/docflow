import { describe, expect, test } from 'vitest'
import type {
  LtChar,
  OutputComp,
  ParagraphItem,
  Pdf2zhFormula,
  Pdf2zhParagraph,
} from '../../../shared/pdf-types'
import { FontMapper } from '../babeldoc/fontmap'
import {
  fixOverlappingParagraphs,
  preprocessDocument,
  renderPage,
  type ReflowFonts,
  type ReflowPage,
  type ReflowParagraph,
} from './reflow'

// Only Source Han Serif CN Regular has glyphs, so every regular serif character maps to it.
// Fixed-width stand-ins: ASCII 0.5 em, the rest 1 em; glyph ids are the code points.
const FONT = 'DocFlow-SourceHanSerifCN-Regular'
const fonts: ReflowFonts = {
  mapper: new FontMapper('auto', (file) => file === 'SourceHanSerifCN-Regular.ttf'),
  width: (_file, ch, size) => (/^[\x20-\x7e]$/.test(ch) ? 0.5 : 1) * size,
  hex: (_file, ch) => ch.codePointAt(0)!.toString(16).padStart(4, '0'),
}
const SERIF = { bold: false, italic: false, monospace: false, serif: true }

type Box = { x0: number; x1: number; y0: number; y1: number }

/** A translated paragraph: `text` with {vN} markers becomes BabelDOC compositions. */
function paragraph(
  text: string,
  box: Box,
  extra: Partial<Pdf2zhParagraph> = {},
  formulas: Pdf2zhFormula[] = [],
  stream = '',
): ReflowParagraph {
  const para: Pdf2zhParagraph = {
    y: box.y0,
    x: box.x0,
    ...box,
    size: 10,
    brk: false,
    gstate: null,
    ...extra,
  }
  const style = {
    font: 'F1',
    size: para.size,
    gstate: extra.gstate === undefined ? '' : extra.gstate,
  }
  const comps: OutputComp[] = text
    .split(/(\{v\d+\})/)
    .filter(Boolean)
    .map((part) => {
      const marker = /^\{v(\d+)\}$/.exec(part)
      return marker
        ? { kind: 'formula', index: Number(marker[1]) }
        : { kind: 'text', text: part, style }
    })
  return {
    para,
    formulas,
    items: [],
    styles: [{ font: 'F1', size: para.size, gstate: '' }],
    fonts: { F1: SERIF },
    comps,
    stream,
    box: { x: para.x0, y: para.y0, x2: para.x1, y2: para.y1 },
  }
}

/** An untranslated paragraph: its original items. */
function original(
  items: ParagraphItem[],
  box: Box,
  formulas: Pdf2zhFormula[] = [],
): ReflowParagraph {
  const p = paragraph('', box, {}, formulas)
  return { ...p, items, comps: undefined }
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

function page(...paragraphs: ReflowParagraph[]): ReflowPage {
  return { right: 612 * 0.9, bottom: 0, paragraphs }
}

function layout(...paragraphs: ReflowParagraph[]): ReflowPage {
  const p = page(...paragraphs)
  preprocessDocument([p], fonts)
  renderPage(p, fonts)
  return p
}

type Drawn = {
  state: string
  font: string
  size: number
  tm: string
  x: number
  y: number
  text: string
}

/** Every TJ in the ops, with the q-state it is drawn in. */
function drawn(ops: string): Drawn[] {
  const out: Drawn[] = []
  const tj = /\/(\S+) ([\d.]+) Tf (1 0 0 1|0 1 -1 0) (-?[\d.]+) (-?[\d.]+) Tm \[<([0-9a-f]*)>\] TJ/g
  for (const block of ops.matchAll(/(?:q (.*?) )?BT (.*?)ET/g)) {
    const state = block[1] ?? ''
    for (const [, font, size, tm, x, y, hex] of block[2]!.matchAll(tj)) {
      const width = font === FONT ? 4 : 2
      let text = ''
      for (let i = 0; i < hex!.length; i += width) {
        text += String.fromCodePoint(Number.parseInt(hex!.slice(i, i + width), 16))
      }
      out.push({
        state,
        font: font!,
        size: Number(size),
        tm: tm!,
        x: Number(x),
        y: Number(y),
        text,
      })
    }
  }
  return out
}

/** Lines of text, top to bottom: the drawn glyph runs grouped by baseline. */
function lines(ops: string): string[] {
  const byY = new Map<number, Drawn[]>()
  for (const d of drawn(ops)) byY.set(d.y, [...(byY.get(d.y) ?? []), d])
  return [...byY]
    .sort((a, b) => b[0] - a[0])
    .map(([, runs]) =>
      runs
        .sort((a, b) => a.x - b.x)
        .map((r) => r.text)
        .join(''),
    )
}

describe('BabelDOC typesetting on pdf2zh paragraphs', () => {
  test('a single-line paragraph wraps inside its box and shrinks, growing into the space below', () => {
    const p = paragraph('中文中文中文中文', { x0: 100, x1: 140, y0: 700, y1: 710 })
    layout(p)
    // Pre-pass: 1.0 … 0.75 fail (the second line falls below the box); at 0.7 the box grows
    // downwards and fits. The drawing pass starts again at 0.7 with the original box, fails,
    // steps to 0.65 and only then grows the box: BabelDOC draws at 0.65.
    expect(p.optimalScale).toBeCloseTo(0.7, 10)
    expect(p.box.y).toBe(2) // cropbox.y * 1.1 + 2
    const runs = drawn(p.ops!)
    expect(lines(p.ops!)).toEqual(['中文中文中文', '中文'])
    for (const run of runs) {
      expect(run.size).toBeCloseTo(6.5, 6)
      expect(run.x).toBeGreaterThanOrEqual(100)
      expect(run.x + run.text.length * run.size).toBeLessThanOrEqual(140 + 1e-6)
    }
    // First baseline: box.y2 - font_size * scale; line advance font_size * scale * 1.5.
    const ys = [...new Set(runs.map((r) => r.y))]
    expect(ys[0]).toBeCloseTo(710 - 6.5, 6)
    expect(ys[0]! - ys[1]!).toBeCloseTo(6.5 * 1.5, 6)
  })

  test('Latin words move to the next line whole; CJK breaks anywhere; spaces at a line start go', () => {
    const latin = paragraph('aaaa bbbb cccc dddd', { x0: 100, x1: 190, y0: 500, y1: 710 })
    const cjk = paragraph('中文中文 中', { x0: 300, x1: 320, y0: 500, y1: 710 })
    layout(latin, cjk)
    expect(lines(latin.ops!)).toEqual(['aaaa bbbb cccc ', 'dddd'])
    expect(lines(cjk.ops!)).toEqual(['中文', '中文', '中'])
    expect(drawn(latin.ops!)[0]).toMatchObject({ font: FONT, x: 100, y: 700, size: 10 })
  })

  test('closing punctuation hangs past the edge; an opening bracket never ends a line', () => {
    const hung = paragraph('中文，中', { x0: 100, x1: 120, y0: 500, y1: 710 })
    const opening = paragraph('中文（中', { x0: 300, x1: 330, y0: 500, y1: 710 })
    layout(hung, opening)
    expect(lines(hung.ops!)).toEqual(['中文，', '中'])
    expect(lines(opening.ops!)).toEqual(['中文', '（中'])
  })

  test('first_line_indent: two CJK widths when the first character sits right of the box', () => {
    const p = paragraph('中文', { x0: 100, x1: 300, y0: 700, y1: 710 }, { x: 115 })
    layout(p)
    expect(drawn(p.ops!)[0]).toMatchObject({ x: 120, text: '中文' })
  })

  test('the translation keeps its style colour; a base style without one uses the default', () => {
    const red = paragraph('中文', { x0: 100, x1: 300, y0: 700, y1: 710 }, { gstate: '1 0 0 rg' })
    const mixed = paragraph('中文', { x0: 100, x1: 300, y0: 600, y1: 610 }, { gstate: null })
    layout(red, mixed)
    expect(red.ops).toMatch(new RegExp(`^q 1 0 0 rg BT /${FONT} `))
    expect(red.ops).toMatch(/ET Q $/)
    expect(mixed.ops).toMatch(new RegExp(`^BT /${FONT} .* ET $`))
  })

  test('styled spans keep their colour and size; original spans keep their glyphs', () => {
    const p = paragraph('中文', { x0: 100, x1: 300, y0: 700, y1: 710 })
    const c = {
      kind: 'char',
      text: 'A',
      x0: 0,
      y0: 0,
      x1: 6,
      y1: 10,
      code: 65,
      codeBytes: 1,
      style: 0,
    }
    p.items = [c as ParagraphItem]
    p.comps = [
      { kind: 'text', text: '中', style: { font: 'F1', size: 10, gstate: '' } },
      { kind: 'text', text: '文', style: { font: 'F1', size: 10, gstate: '0 0 1 rg' } },
      { kind: 'original', from: 0, to: 1 },
    ]
    layout(p)
    expect(drawn(p.ops!).map((r) => [r.state, r.font, r.text, r.x])).toEqual([
      ['', FONT, '中', 100],
      ['0 0 1 rg', FONT, '文', 110],
      ['', 'F1', 'A', 120],
    ])
  })

  test('formulas: placed after the text before them, scaled with it, in their own colour', () => {
    const x = vchar('x', 400, 300, { gstate: '0 0 1 rg' })
    const i = vchar('i', 404, 297, { size: 6, y1: 303, x1: 407, gstate: '0 0 1 rg' })
    const formula: Pdf2zhFormula = { chars: [x, i], lines: [], fix: 1, len: 7 }
    const p = paragraph('中{v0}中', { x0: 100, x1: 300, y0: 700, y1: 710 }, {}, [formula])
    layout(p)
    const runs = drawn(p.ops!)
    expect(runs.map((r) => [r.state, r.font, r.text])).toEqual([
      ['', FONT, '中'],
      ['0 0 1 rg', 'F7', 'x'],
      ['0 0 1 rg', 'F7', 'i'],
      ['', FONT, '中'],
    ])
    // Baseline 700; the formula keeps pdf2zh's fix (text came before it) and relative offsets.
    expect(runs[1]).toMatchObject({ x: 110, y: 701, size: 8 })
    expect(runs[2]).toMatchObject({ x: 114, y: 698, size: 6 })
    expect(runs[3]).toMatchObject({ x: 117 })
  })

  test('an untranslated paragraph passes through with its original glyphs', () => {
    const formula: Pdf2zhFormula = { chars: [vchar('y', 250, 420)], lines: [], fix: 3, len: 4 }
    const space = {
      kind: 'char',
      text: ' ',
      x0: 254,
      y0: 420,
      x1: 257,
      y1: 430,
      code: -1,
      codeBytes: 0,
      style: 0,
      dummy: true,
    }
    const b = {
      kind: 'char',
      text: 'b',
      x0: 257,
      y0: 420,
      x1: 262,
      y1: 430,
      code: 98,
      codeBytes: 1,
      style: 0,
    }
    const p = original(
      [{ kind: 'formula', index: 0 }, space as ParagraphItem, b as ParagraphItem],
      { x0: 250, x1: 262, y0: 420, y1: 430 },
      [formula],
    )
    layout(p)
    expect(p.passthrough).toBe(true)
    expect(drawn(p.ops!)).toEqual([
      { state: '', font: 'F7', size: 8, tm: '1 0 0 1', x: 250, y: 420, text: 'y' },
      { state: '', font: 'F1', size: 10, tm: '1 0 0 1', x: 257, y: 420, text: 'b' },
    ])
  })

  test('a glyph turned by 90° is redrawn turned (0 1 -1 0 x2 y Tm)', () => {
    const turned = vchar('t', 50, 300, { vertical: true, angle: 90, x1: 60, y1: 305, size: 10 })
    const formula: Pdf2zhFormula = { chars: [turned], lines: [], fix: 0, len: 10 }
    const p = original([{ kind: 'formula', index: 0 }], { x0: 50, x1: 60, y0: 300, y1: 305 }, [
      formula,
    ])
    layout(p)
    expect(drawn(p.ops!)).toMatchObject([{ tm: '0 1 -1 0', x: 60, y: 300, size: 10 }])
  })

  test('document scale: every paragraph is capped at the most common scale (per unit)', () => {
    // 10 units need 0.9, 3 units fit at 1.0: the common scale is 0.9 for both.
    const tight = paragraph('中文中文中文中文中文', { x0: 100, x1: 190, y0: 700, y1: 710 })
    const loose = paragraph('中文中', { x0: 100, x1: 300, y0: 600, y1: 610 })
    const p = page(tight, loose)
    const lower = paragraph('中', { x0: 100, x1: 300, y0: 680, y1: 690 }) // blocks growing down
    p.paragraphs.push(lower)
    preprocessDocument([p], fonts)
    expect(tight.optimalScale).toBeCloseTo(0.9, 10)
    expect(loose.optimalScale).toBeCloseTo(0.9, 10)
    renderPage(p, fonts)
    expect(drawn(loose.ops!)[0]!.size).toBeCloseTo(9, 6)
  })

  test('blocked below, the box grows to the right up to the next paragraph', () => {
    const p = paragraph('中文中文中文', { x0: 100, x1: 120, y0: 700, y1: 710 })
    const below = paragraph('', { x0: 100, x1: 300, y0: 690, y1: 699 })
    const right = paragraph('', { x0: 200, x1: 300, y0: 700, y1: 710 })
    layout(p, below, right)
    expect(p.box.x2).toBe(195)
    expect(lines(p.ops!)).toEqual(['中文中文中文'])
  })

  test('fix_overlapping_paragraphs cuts two overlapping boxes of one stream at the midpoint', () => {
    const a = paragraph('', { x0: 100, x1: 300, y0: 100, y1: 200 })
    const b = paragraph('', { x0: 150, x1: 350, y0: 150, y1: 250 })
    const other = paragraph('', { x0: 150, x1: 350, y0: 150, y1: 250 }, {}, [], '1')
    fixOverlappingParagraphs([a, b, other])
    expect(a.box).toMatchObject({ y: 100, y2: 174 })
    expect(b.box).toMatchObject({ y: 176, y2: 250 })
    expect(other.box).toMatchObject({ y: 150, y2: 250 })
  })

  test('render_page raises a box to leave a gap above the paragraph just below it', () => {
    const upper = paragraph('', { x0: 100, x1: 300, y0: 700, y1: 720 })
    const lower = paragraph('', { x0: 150, x1: 250, y0: 680, y1: 700.2 })
    const aside = paragraph('', { x0: 400, x1: 500, y0: 690, y1: 700.4 })
    renderPage(page(upper, lower, aside), fonts)
    expect(upper.box.y).toBeCloseTo(700.7, 10)
  })
})
