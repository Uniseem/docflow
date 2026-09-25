import { describe, expect, test } from 'vitest'
import { LAYOUT_MODEL, fixture, referenceLayouts } from '../../../../tests/unit/pdf2zh-reference'
import { buildLayoutMap, imageSize, postprocess, prepareInput, pyRound } from './doclayout'
import { detectPage } from './detect'

describe('doclayout pre/post-processing', () => {
  test('pyRound rounds halves to even like Python', () => {
    expect([0.5, 1.5, 2.5, 2.4, 2.6, -0.5, -1.5].map(pyRound)).toEqual([0, 2, 2, 2, 3, 0, -2])
  })

  test('imgsz = int(height / 32) * 32', () => {
    expect(imageSize(792)).toBe(768)
    expect(imageSize(842)).toBe(832)
  })

  test('resize keeps the aspect ratio and pads only to a multiple of the stride (value 114)', () => {
    const rgb = new Uint8Array(612 * 792 * 3).fill(255)
    const input = prepareInput(rgb, 612, 792, 768)
    // r = min(768/792, 768/612) → 593 × 768, padded by (768 − 593) % 32 = 15 → 608 wide.
    expect([input.width, input.height]).toEqual([608, 768])
    const plane = input.width * input.height
    expect(input.data[0]).toBeCloseTo(114 / 255, 6) // left padding column
    expect(input.data[input.width / 2]).toBeCloseTo(1, 6)
    expect(input.data.length).toBe(3 * plane)
  })

  test('postprocess drops conf <= 0.25, undoes the letterbox and sorts by confidence', () => {
    const rows = new Float32Array([
      10, 20, 110, 220, 0.5, 1,
      0, 0, 5, 5, 0.25, 3,
      7, 20, 107, 220, 0.9, 2,
    ]) // prettier-ignore
    const boxes = postprocess(rows, 3, { width: 608, height: 768 }, { width: 612, height: 792 })
    expect(boxes.map((b) => [b.name, b.conf.toFixed(1)])).toEqual([
      ['abandon', '0.9'],
      ['plain text', '0.5'],
    ])
    const gain = Math.min(768 / 792, 608 / 612)
    const padX = pyRound((608 - 612 * gain) / 2 - 0.1)
    expect(boxes[1]!.xyxy[0]).toBeCloseTo((10 - padX) / gain, 3)
  })

  test('layout map: 1 by default, text boxes i + 2 in order, preserved classes 0 last', () => {
    const map = buildLayoutMap({
      width: 100,
      height: 100,
      boxes: [
        { name: 'plain text', conf: 0.9, xyxy: [10, 10, 50, 50] },
        { name: 'figure', conf: 0.8, xyxy: [40, 40, 90, 90] },
        { name: 'title', conf: 0.7, xyxy: [0, 0, 20, 20] },
      ],
    })
    const at = (x: number, y: number) => map.cls[y * 100 + x]
    // Rows count from the bottom: image y 30 → row 100 − 30.
    expect(at(30, 70)).toBe(2)
    expect(at(60, 40)).toBe(0) // figure wins over the text box
    expect(at(5, 95)).toBe(4) // later text box overwrites the earlier one
    expect(at(95, 5)).toBe(1)
  })
})

describe('detectPage (MuPDF.js + DocLayout-YOLO)', () => {
  test("reproduces pdf2zh's boxes on two-column", { timeout: 120_000 }, async () => {
    const expected = referenceLayouts('two-column')
    for (let i = 0; i < expected.length; i += 1) {
      const got = await detectPage(fixture('two-column'), i, LAYOUT_MODEL)
      const want = expected[i]!
      expect([got.width, got.height]).toEqual([want.width, want.height])
      expect(got.boxes.map((b) => b.name)).toEqual(want.boxes.map((b) => b.name))
      got.boxes.forEach((box, k) => {
        expect(box.conf).toBeCloseTo(want.boxes[k]!.conf, 2)
        box.xyxy.forEach((v, j) => expect(Math.abs(v - want.boxes[k]!.xyxy[j]!)).toBeLessThan(1))
      })
    }
  })
})
