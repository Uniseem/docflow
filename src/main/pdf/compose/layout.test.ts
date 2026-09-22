import { describe, expect, test } from 'vitest'
import { layoutParagraph, tokenizeTranslated } from './layout'
import type { Paragraph } from '../../../shared/pdf-types'
import { PDF } from '../../../shared/pdf-constants'

function para(partial: Partial<Paragraph> & { text: string }): Paragraph {
  const size = partial.size ?? 10
  return {
    id: '0-0',
    page: 0,
    bbox: partial.bbox ?? [72, 500, 372, 620],
    lines: partial.lines ?? [{ bbox: [72, 600, 372, 620], baseline: 608, opSeqs: [0] }],
    size,
    lineHeight: partial.lineHeight ?? 13,
    bold: false,
    align: partial.align ?? 'left',
    color: [0, 0, 0],
    role: 'body',
    text: partial.text,
    runs: partial.runs ?? [],
    formPath: '',
    translatable: true,
  }
}

const measure = (text: string, size: number) => {
  let w = 0
  for (const ch of text) w += /[A-Za-z0-9]/.test(ch) ? size * 0.5 : size
  return w
}

const options = {
  minFontScale: PDF.MIN_FONT_SCALE,
  lineHeightFactor: PDF.LINE_HEIGHT_FACTOR,
  minLineHeightFactor: PDF.MIN_LINE_HEIGHT_FACTOR,
}

describe('layoutParagraph', () => {
  test('does not split latin words', () => {
    const tokens = tokenizeTranslated('Hello world')
    expect(
      tokens.filter((t) => t.kind === 'text').map((t) => (t.kind === 'text' ? t.text : '')),
    ).toEqual(['Hello', 'world'])
  })

  test('keeps {vN} as formula tokens with run width', () => {
    const result = layoutParagraph(
      para({
        text: 'E={v1} mc',
        runs: [
          {
            id: 1,
            glyphs: [],
            bbox: [0, 0, 20, 10],
            baselineOffset: 0,
            width: 40,
            text: 'α',
          },
        ],
      }),
      '能量={v1}质量',
      measure,
      options,
    )
    const ids = result.lines.flatMap((l) => l.tokens.filter((t) => t.kind === 'formula'))
    expect(ids).toHaveLength(1)
    expect(ids[0]?.width).toBeCloseTo(40)
  })

  test('moves forbidden punctuation off the line start', () => {
    const result = layoutParagraph(
      para({ bbox: [0, 0, 30, 40], text: '甲。乙' }),
      '甲。乙丙丁戊己庚',
      (text, size) => text.length * size,
      options,
    )
    expect(result.lines.length).toBeGreaterThan(1)
    expect(
      result.lines.some((line) => line.tokens[0]?.kind === 'text' && line.tokens[0].text === '。'),
    ).toBe(false)
  })

  test('justify distributes extra width on non-last lines', () => {
    const result = layoutParagraph(
      para({
        align: 'justify',
        bbox: [0, 0, 90, 80],
        text: 'one two three four five six seven eight',
      }),
      'one two three four five six seven eight',
      (text, size) => (text === ' ' ? size * 0.3 : [...text].length * size * 0.5),
      options,
    )
    expect(result.lines.length).toBeGreaterThan(1)
    const first = result.lines[0]!
    const span = (first.tokens.at(-1)?.x ?? 0) + (first.tokens.at(-1)?.width ?? 0)
    expect(span).toBeGreaterThan(70)
    expect(first.tokens.length).toBeGreaterThan(1)
  })

  test('shrinks line height then font size when overflowing', () => {
    const result = layoutParagraph(
      para({
        bbox: [0, 0, 40, 16],
        size: 12,
        lineHeight: 16,
        text: '这是一段非常长的中文句子需要缩小字号才能放进很矮的框里继续写下去',
      }),
      '这是一段非常长的中文句子需要缩小字号才能放进很矮的框里继续写下去',
      (text, size) => text.length * size,
      options,
    )
    expect(result.fontSize).toBeLessThan(12)
    expect(result.overflow || result.fontSize <= 12 * PDF.MIN_FONT_SCALE + 0.01).toBe(true)
  })
})
