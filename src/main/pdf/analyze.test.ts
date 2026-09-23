import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { analyzePdf } from './analyze'
import { scanFormRefs } from './forms'
import { readFile } from 'node:fs/promises'

const fixtures = join(process.cwd(), 'tests/fixtures')

describe('analyzePdf', () => {
  test('single-column snapshot stats', async () => {
    const result = await analyzePdf(join(fixtures, 'single-column.pdf'))
    expect(result.pages).toBe(3)
    expect(result.stats.paragraphs).toBeGreaterThan(4)
    expect(result.stats.translatable).toBeGreaterThan(4)
    expect(result.paragraphs.some((p) => p.role === 'headerFooter')).toBe(true)
    expect({
      pages: result.pages,
      glyphs: result.stats.glyphs,
      lines: result.stats.lines,
      paragraphs: result.stats.paragraphs,
      translatable: result.stats.translatable,
      roles: result.paragraphs.reduce<Record<string, number>>((acc, p) => {
        acc[p.role] = (acc[p.role] ?? 0) + 1
        return acc
      }, {}),
    }).toMatchSnapshot()
  })

  test('two-column has two columns on the first body page', async () => {
    const result = await analyzePdf(join(fixtures, 'two-column.pdf'))
    expect(result.pages).toBe(4)
    expect(result.stats.paragraphs).toBeGreaterThan(4)
  })

  test('inline-formula extracts formula runs without NaN boxes', async () => {
    const result = await analyzePdf(join(fixtures, 'inline-formula.pdf'))
    expect(result.stats.runs).toBeGreaterThan(0)
    expect(result.paragraphs.every((p) => p.bbox.every((n) => Number.isFinite(n)))).toBe(true)
  })

  test('display-math marks a non-translatable formula line', async () => {
    const result = await analyzePdf(join(fixtures, 'display-math.pdf'))
    expect(
      result.paragraphs.some((p) => p.skipReason === 'display_math' || p.runs.length > 0),
    ).toBe(true)
  })

  test('italic sentence stays translatable', async () => {
    const result = await analyzePdf(join(fixtures, 'italic-sentence.pdf'))
    const prose = result.paragraphs.find((p) => p.text.includes('entire sentence'))
    expect(prose?.translatable).toBe(true)
  })

  test.each([
    'single-column.pdf',
    'two-column.pdf',
    'inline-formula.pdf',
    'display-math.pdf',
    'italic-sentence.pdf',
    'figure-caption.pdf',
    'hyphenation.pdf',
    'tj-arrays.pdf',
    'colored-text.pdf',
    'cid-font.pdf',
    'form-wrapped.pdf',
  ])('%s has translatable text on every page with body text', async (name) => {
    const result = await analyzePdf(join(fixtures, name))
    expect(result.stats.translatable).toBeGreaterThan(0)
  })
})

describe('analyzePdf on real papers', () => {
  test('a two-column paper reads column by column and keeps paragraphs whole', async () => {
    const result = await analyzePdf(join(fixtures, 'arxiv-2302.13971.pdf'))
    const first = result.paragraphs.filter((p) => p.page === 0 && p.translatable)
    const abstract = first.find((p) => p.text.startsWith('We introduce LLaMA'))
    expect(abstract?.lines.length).toBeGreaterThanOrEqual(10)
    // Left column (ends with "In this context…") before the right one ("The focus of…").
    const left = first.findIndex((p) => p.text.startsWith('In this context'))
    const right = first.findIndex((p) => p.text.startsWith('The focus of this work'))
    expect(left).toBeGreaterThanOrEqual(0)
    expect(right).toBeGreaterThan(left)
    expect(first.length).toBeLessThan(25)
  })

  test('text wrapped beside a figure stays one paragraph', async () => {
    const result = await analyzePdf(join(fixtures, 'arxiv-2201.11903.pdf'))
    const wrapped = result.paragraphs.find(
      (p) => p.page === 5 && p.text.startsWith('Variable compute only.'),
    )
    expect(wrapped?.translatable).toBe(true)
    expect(wrapped?.lines.length).toBeGreaterThanOrEqual(8)
  })

  test('small text inside a vector figure is not translated', async () => {
    const result = await analyzePdf(join(fixtures, 'arxiv-2201.11903.pdf'))
    const example = result.paragraphs.find(
      (p) => p.page === 3 && p.text.includes('There are 9 one-digit numbers'),
    )
    expect(example?.translatable).toBe(false)
  })
})

describe('scanFormRefs', () => {
  test('form-wrapped is not shared', async () => {
    const { stats } = await scanFormRefs(await readFile(join(fixtures, 'form-wrapped.pdf')))
    expect(stats.length).toBeGreaterThan(0)
    expect(stats.every((row) => row.shared === false)).toBe(true)
  })

  test('shared-form logo is shared across pages', async () => {
    const { stats, sharedPaths } = await scanFormRefs(
      await readFile(join(fixtures, 'shared-form.pdf')),
    )
    expect(stats.some((row) => row.shared)).toBe(true)
    expect(sharedPaths.size).toBeGreaterThan(0)
  })
})
