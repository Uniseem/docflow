import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { detectScanned, ssim, type PageCheck } from './scanned'

const fixtures = join(__dirname, '../../../tests/fixtures')

function image(width: number, height: number, value: (x: number, y: number) => number) {
  const out = new Uint8Array(width * height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) out[y * width + x] = value(x, y) % 256
  }
  return out
}

describe('ssim', () => {
  // Reference values from skimage.metrics.structural_similarity 0.26 on the same arrays.
  const a = image(23, 17, (x, y) => x * 37 + y * 11)

  test('matches skimage', () => {
    const b = image(23, 17, (x, y) => x * x + 3 * y * y + x * y)
    expect(ssim(a, b, 23, 17)).toBeCloseTo(0.06947135485157506, 12)
    const c = a.slice()
    for (let y = 5; y < 9; y += 1) for (let x = 4; x < 15; x += 1) c[y * 23 + x] = 255
    expect(ssim(a, c, 23, 17)).toBeCloseTo(0.6690704036064975, 12)
  })

  test('identical images score 1', () => {
    expect(ssim(a, a, 23, 17)).toBeCloseTo(1, 12)
  })
})

describe('detectScanned', () => {
  test('an OCR scan (page pictures under invisible text) is scanned', async () => {
    const checks: PageCheck[] = []
    const result = await detectScanned(join(fixtures, 'ocr-scan.pdf'), null, (_, check) =>
      checks.push(check),
    )
    expect(result).toEqual({ scanned: true, scannedPages: 3, checkedPages: 3, total: 3 })
    for (const check of checks) {
      expect(check.coverage).toBe(1)
      expect(check.similarity).toBeGreaterThan(0.99)
    }
  })

  test('ordinary text pages are not, even sparse ones without pictures', async () => {
    for (const name of ['two-column.pdf', 'long.pdf', 'shared-form.pdf']) {
      const result = await detectScanned(join(fixtures, name), null)
      expect(result.scanned, name).toBe(false)
      expect(result.scannedPages, name).toBe(0)
    }
  })

  test('stops as soon as the answer is settled', async () => {
    // 60 pages: 20% not scanned (12 pages) settles it.
    const result = await detectScanned(join(fixtures, 'long.pdf'), null)
    expect(result.checkedPages).toBe(12)
    expect(result.total).toBe(60)
  })

  test('a single chosen page is never checked (threshold 1, nothing left to prove)', async () => {
    const result = await detectScanned(join(fixtures, 'ocr-scan.pdf'), [1])
    expect(result).toEqual({ scanned: false, scannedPages: 0, checkedPages: 0, total: 1 })
  })

  test('only the chosen pages count', async () => {
    const result = await detectScanned(join(fixtures, 'ocr-scan.pdf'), [0, 2])
    expect(result).toEqual({ scanned: true, scannedPages: 2, checkedPages: 2, total: 2 })
  })
})
