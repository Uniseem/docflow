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
