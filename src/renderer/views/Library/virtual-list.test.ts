import { describe, expect, test } from 'vitest'
import {
  ROW_ACTIVE_HEIGHT,
  ROW_IDLE_HEIGHT,
  rowOffsets,
  scrollTopFor,
  visibleRange,
} from './virtual-list'

const idle = { status: 'completed' as const }
const active = { status: 'processing' as const }

describe('virtual list', () => {
  test('offsets use the height of each row kind', () => {
    expect(rowOffsets([idle, active, idle])).toEqual([
      0,
      ROW_IDLE_HEIGHT,
      ROW_IDLE_HEIGHT + ROW_ACTIVE_HEIGHT,
      2 * ROW_IDLE_HEIGHT + ROW_ACTIVE_HEIGHT,
    ])
  })

  test('the visible range covers exactly the rows on screen plus overscan', () => {
    const offsets = rowOffsets(Array.from({ length: 1000 }, (_, i) => (i % 3 ? idle : active)))
    const top = offsets[500] ?? 0
    const range = visibleRange(offsets, top + 1, 300, 0)
    expect(range.start).toBe(500)
    expect(offsets[range.end - 1]).toBeLessThan(top + 301)
    expect(offsets[range.end]).toBeGreaterThanOrEqual(top + 301)
    const padded = visibleRange(offsets, top + 1, 300, 20)
    expect(padded.start).toBe(480)
    expect(padded.end).toBe(range.end + 20)
  })

  test('the range is clamped at both ends', () => {
    const offsets = rowOffsets(Array.from({ length: 10 }, () => idle))
    expect(visibleRange(offsets, 0, 10_000, 20)).toEqual({ start: 0, end: 10 })
    expect(visibleRange(rowOffsets([]), 0, 500, 20)).toEqual({ start: 0, end: 0 })
  })

  test('scrollTopFor reveals a row with minimal movement', () => {
    const offsets = rowOffsets(Array.from({ length: 300 }, () => idle))
    // Below the viewport: align its bottom edge with the viewport bottom.
    expect(scrollTopFor(offsets, 250, 0, 560)).toBe(251 * ROW_IDLE_HEIGHT - 560)
    // Above the viewport: align its top edge.
    expect(scrollTopFor(offsets, 3, 1000, 560)).toBe(3 * ROW_IDLE_HEIGHT)
    // Already visible: leave the scroll position alone.
    expect(scrollTopFor(offsets, 20, 1000, 560)).toBeNull()
  })
})
