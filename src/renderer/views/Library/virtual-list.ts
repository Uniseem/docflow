import { isActiveStatus } from '../../../shared/library-filter'
import type { DocumentStatus } from '../../../shared/types'

// Every row has a fixed height (the progress line only shows while a document is in
// progress), so the virtual list can place rows exactly without measuring them.
export const ROW_IDLE_HEIGHT = 56
export const ROW_ACTIVE_HEIGHT = 76

export function rowHeight(item: { status: DocumentStatus }): number {
  return isActiveStatus(item.status) ? ROW_ACTIVE_HEIGHT : ROW_IDLE_HEIGHT
}

/** offsets[i] is the top of row i; offsets[n] is the total height. */
export function rowOffsets(items: readonly { status: DocumentStatus }[]): number[] {
  const offsets = [0]
  let top = 0
  for (const item of items) {
    top += rowHeight(item)
    offsets.push(top)
  }
  return offsets
}

/** Rows intersecting [top, top + height), widened by `overscan` rows on each side. */
export function visibleRange(
  offsets: readonly number[],
  top: number,
  height: number,
  overscan: number,
): { start: number; end: number } {
  const count = offsets.length - 1
  let low = 0
  let high = count
  // First row whose bottom edge is below `top`.
  while (low < high) {
    const mid = (low + high) >> 1
    if ((offsets[mid + 1] ?? 0) <= top) low = mid + 1
    else high = mid
  }
  let end = low
  while (end < count && (offsets[end] ?? 0) < top + height) end += 1
  return { start: Math.max(0, low - overscan), end: Math.min(count, end + overscan) }
}

/** The scrollTop that brings row `index` fully into view with minimal movement, or null. */
export function scrollTopFor(
  offsets: readonly number[],
  index: number,
  scrollTop: number,
  clientHeight: number,
): number | null {
  const top = offsets[index] ?? 0
  const bottom = offsets[index + 1] ?? top
  if (top < scrollTop) return top
  if (bottom > scrollTop + clientHeight) return Math.max(0, bottom - clientHeight)
  return null
}
