import { describe, expect, test } from 'vitest'
import { AffineMatrix } from './dom-matrix'

function values(m: AffineMatrix): number[] {
  return [m.a, m.b, m.c, m.d, m.e, m.f]
}

describe('AffineMatrix', () => {
  test('matches what the pdf.js worker builds for a Type3 bitmap glyph', () => {
    const width = 40
    const height = 25
    const m = new AffineMatrix().scaleSelf(1 / width, -1 / height).translateSelf(0, -height)
    expect(values(m)).toEqual([1 / width, 0, 0, -1 / height, 0, 1])
    // The glyph's top-left pixel (0, 0) maps to (0, 1) and bottom-right to (1, 0).
    expect(m.transformPoint({ x: 0, y: 0 })).toEqual({ x: 0, y: 1 })
    expect(m.transformPoint({ x: width, y: height })).toEqual({ x: 1, y: 0 })
  })

  // Expected values cross-checked against @napi-rs/canvas's native DOMMatrix.
  test('multiplies, pre-multiplies and inverts like DOMMatrix', () => {
    const m = new AffineMatrix([2, 1, 0.5, 3, 10, -4])
    const n = new AffineMatrix([1, -1, 2, 0.5, 3, 7])
    expect(values(m.multiply(n))).toEqual([1.5, -2, 4.25, 3.5, 19.5, 20])
    const pre = new AffineMatrix([2, 1, 0.5, 3, 10, -4]).preMultiplySelf(n)
    expect(values(pre)).toEqual([4, -1.5, 6.5, 1, 5, -5])
    const inverse = [6 / 11, -2 / 11, -1 / 11, 4 / 11, -64 / 11, 36 / 11]
    values(m.inverse()).forEach((v, i) => expect(v).toBeCloseTo(inverse[i]!, 12))
  })

  test('is installed as DOMMatrix when the runtime has none', async () => {
    await import('./pdfjs')
    expect(typeof (globalThis as { DOMMatrix?: unknown }).DOMMatrix).toBe('function')
  })
})
