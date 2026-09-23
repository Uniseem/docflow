import type { HostState } from '../../shared/types'

export type Rect = { x: number; y: number; width: number; height: number }
export type SavedWindow = NonNullable<HostState['window']>

export const WINDOW_DEFAULT_SIZE = { width: 1240, height: 800 }
export const WINDOW_MIN_SIZE = { width: 960, height: 600 }

/** Height of the strip at the top of the window that must stay reachable (title bar). */
const TITLE_STRIP = 40

function overlap(a: Rect, b: Rect): { width: number; height: number } {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return { width: Math.max(0, width), height: Math.max(0, height) }
}

/**
 * The saved window bounds, or undefined when they would put the title bar off every current
 * display (monitor unplugged, resolution changed) — then the window opens at the default
 * size, centered.
 */
export function restorableBounds(
  saved: SavedWindow | undefined,
  workAreas: readonly Rect[],
): Rect | undefined {
  if (!saved) return undefined
  const values = [saved.x, saved.y, saved.width, saved.height]
  if (!values.every((value) => Number.isFinite(value))) return undefined
  const bounds: Rect = {
    x: Math.round(saved.x),
    y: Math.round(saved.y),
    width: Math.max(WINDOW_MIN_SIZE.width, Math.round(saved.width)),
    height: Math.max(WINDOW_MIN_SIZE.height, Math.round(saved.height)),
  }
  const strip: Rect = { x: bounds.x, y: bounds.y, width: bounds.width, height: TITLE_STRIP }
  const reachable = workAreas.some((area) => {
    const seen = overlap(strip, area)
    return seen.width >= 120 && seen.height >= TITLE_STRIP / 2
  })
  return reachable ? bounds : undefined
}
