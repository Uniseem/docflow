import { describe, expect, test } from 'vitest'
import { AnalysisResult, Glyph, PdfInspection } from './pdf-types'

describe('pdf schemas', () => {
  test('parses inspection', () => {
    const parsed = PdfInspection.parse({
      pages: 3,
      pageSizes: [[612, 792]],
      rotations: [0],
      textChars: 10,
      visibleTextChars: 10,
      hasTextLayer: true,
    })
    expect(parsed.pages).toBe(3)
  })

  test('rejects analysis without version 2', () => {
    expect(() =>
      AnalysisResult.parse({
        version: 1,
        pages: 1,
        pageSizes: [[1, 1]],
        paragraphs: [],
        fontMap: {},
        forms: [],
        stats: { glyphs: 0, lines: 0, paragraphs: 0, translatable: 0, runs: 0 },
      }),
    ).toThrow()
  })

  test('glyph requires matrix of 6', () => {
    const base = {
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
      trm: [10, 0, 0, 10, 72, 720],
      x: 72,
      y: 720,
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
    }
    expect(Glyph.parse(base).unicode).toBe('A')
    expect(() => Glyph.parse({ ...base, trm: [1, 2, 3] })).toThrow()
  })
})
