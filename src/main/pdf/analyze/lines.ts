import { PDF } from '../../../shared/pdf-constants'
import type { Glyph, Rect } from '../../../shared/pdf-types'
import { inSharedForm } from '../form-path'

export type RawLine = {
  page: number
  glyphs: Glyph[]
  rotated: boolean
}

function glyphY0(g: Glyph): number {
  return g.y + g.descent * g.size
}

function glyphY1(g: Glyph): number {
  return g.y + g.ascent * g.size
}

function overlapFrac(a0: number, a1: number, b0: number, b1: number): number {
  const lo = Math.max(a0, b0)
  const hi = Math.min(a1, b1)
  const glyphH = Math.max(0.01, a1 - a0)
  return Math.max(0, hi - lo) / glyphH
}

function lineBox(glyphs: Glyph[]): { x0: number; x1: number; y0: number; y1: number } {
  let x0 = Infinity
  let x1 = -Infinity
  let y0 = Infinity
  let y1 = -Infinity
  for (const g of glyphs) {
    x0 = Math.min(x0, g.x)
    x1 = Math.max(x1, g.x + g.width)
    y0 = Math.min(y0, glyphY0(g))
    y1 = Math.max(y1, glyphY1(g))
  }
  return { x0, x1, y0, y1 }
}

export function mergeLines(glyphs: readonly Glyph[], sharedPaths: ReadonlySet<string>): RawLine[] {
  const usable = glyphs.filter(
    (g) =>
      !g.vertical &&
      g.renderMode !== 3 &&
      g.renderMode !== 7 &&
      !inSharedForm(g.formPath, sharedPaths),
  )
  const lines: RawLine[] = []
  const open: RawLine[] = []
  const assigned = new Map<number, RawLine>()

  for (const g of usable) {
    const existing = assigned.get(g.opSeq)
    if (existing) {
      existing.glyphs.push(g)
      continue
    }
    const gy0 = glyphY0(g)
    const gy1 = glyphY1(g)
    let found: RawLine | undefined
    for (let i = open.length - 1; i >= 0; i -= 1) {
      const line = open[i]
      if (!line || line.rotated !== g.rotated) continue
      const box = lineBox(line.glyphs)
      const overlap = overlapFrac(gy0, gy1, box.y0, box.y1)
      if (overlap < PDF.LINE_OVERLAP_MIN) continue
      const size = g.size || 1
      const append = g.x >= box.x1 - 0.5 * size && g.x <= box.x1 + PDF.LINE_GAP_MAX * size
      const prepend =
        g.x + g.width >= box.x0 - PDF.LINE_GAP_MAX * size && g.x + g.width <= box.x0 + 0.5 * size
      if (append || prepend) {
        found = line
        break
      }
    }
    if (!found) {
      found = { page: g.page, glyphs: [], rotated: g.rotated }
      lines.push(found)
      open.push(found)
      if (open.length > PDF.OPEN_LINES) open.shift()
    }
    found.glyphs.push(g)
    assigned.set(g.opSeq, found)
  }

  for (const line of lines) {
    line.glyphs.sort((a, b) => a.x - b.x)
  }
  return lines.filter((line) => line.glyphs.length > 0)
}

export function lineBBox(glyphs: readonly Glyph[]): Rect {
  const box = lineBox(glyphs as Glyph[])
  return [box.x0, box.y0, box.x1, box.y1]
}
