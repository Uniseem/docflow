import { describe, expect, test } from 'vitest'
import { fixture, reference, referenceLayouts } from '../../../tests/unit/pdf2zh-reference'
import { analyzePdf } from './analyze'

// Given pdf2zh's own layout boxes, the port must build the same paragraph strings (sstk) as
// PDFMathTranslate 1.9.11 did on the same file.
const PARITY = [
  'arxiv-2201.11903',
  'arxiv-2302.13971',
  'cid-font',
  'colored-text',
  'display-math',
  'figure-caption',
  'form-wrapped',
  'hyphenation',
  'inline-formula',
  'italic-sentence',
  'long',
  'shared-form',
  'single-column',
  'two-column',
]

describe('analyzePdf matches pdf2zh receive_layout', () => {
  test.each(PARITY)('%s', { timeout: 120_000 }, async (name) => {
    const ref = reference(name)
    const result = await analyzePdf(fixture(name), referenceLayouts(name))
    expect(result.version).toBe(3)
    ref.pages.forEach((page, index) => {
      const pageUnit = page.units.find((unit) => unit.kind === 'page')
      const ours = result.units.find((unit) => unit.page === index && unit.formPath === '')
      expect(ours?.texts, `page ${index + 1}`).toEqual(pageUnit?.sstk ?? [])
      expect(ours?.formulas.length, `page ${index + 1} formulas`).toBe(pageUnit?.formulas ?? 0)
      const refForms = page.units.filter((unit) => unit.kind === 'figure').map((u) => u.sstk)
      const ourForms = result.units
        .filter((unit) => unit.page === index && unit.formPath !== '' && unit.texts.length > 0)
        .map((unit) => unit.texts)
      expect(ourForms, `page ${index + 1} forms`).toEqual(refForms)
    })
  })

  test('pdfminer\'s " operator does not start a new line; pdf.js positions are kept', async () => {
    // pdfminer.six do__w skips T*, so pdf2zh sees the quoted line continue the previous one.
    // The port keeps pdf.js's (specification) positions: same characters, one paragraph.
    const ref = reference('tj-arrays').pages[0]!.units.find((unit) => unit.kind === 'page')!
    const result = await analyzePdf(fixture('tj-arrays'), referenceLayouts('tj-arrays'))
    const texts = result.units.find((unit) => unit.formPath === '')!.texts
    expect(texts.join('').replaceAll(' ', '')).toBe(ref.sstk.join('').replaceAll(' ', ''))
  })

  test('stats count chars, paragraphs to translate and formulas', async () => {
    const result = await analyzePdf(fixture('inline-formula'), referenceLayouts('inline-formula'))
    const texts = result.units.flatMap((unit) => unit.texts)
    expect(result.stats.paragraphs).toBe(texts.length)
    expect(result.stats.translatable).toBeGreaterThan(0)
    expect(result.stats.formulas).toBe(result.units.reduce((n, u) => n + u.formulas.length, 0))
    expect(result.stats.chars).toBeGreaterThan(0)
  })
})
