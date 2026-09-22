import { PDF } from '../../../shared/pdf-constants'
import type { Lined } from './formula'

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0)
}

export function assignColumns(lines: Lined[], pageWidth: number): Lined[] {
  if (lines.length === 0) return lines
  const weights = lines.map((line) => Math.max(1, line.text.replace(/\{v\d+\}/g, '').length))
  const bodySize = median(
    lines.flatMap((line, i) => Array.from({ length: weights[i] ?? 1 }, () => line.size)),
  )
  const candidates = lines.filter(
    (line) => !line.formulaLine && line.size >= 0.75 * bodySize && line.size <= 1.25 * bodySize,
  )
  const bins = new Map<number, number>()
  for (const line of candidates) {
    const key = Math.floor(line.bbox[0] / PDF.COLUMN_BIN)
    bins.set(key, (bins.get(key) ?? 0) + 1)
  }
  const peaks = [...bins.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
  const minSep = PDF.COLUMN_MIN_SEPARATION * pageWidth
  let leftPeak: number | undefined
  let rightPeak: number | undefined
  for (let i = 0; i < peaks.length; i += 1) {
    for (let j = i + 1; j < peaks.length; j += 1) {
      const a = (peaks[i]?.[0] ?? 0) * PDF.COLUMN_BIN
      const b = (peaks[j]?.[0] ?? 0) * PDF.COLUMN_BIN
      if (Math.abs(a - b) < minSep) continue
      const coverA = (peaks[i]?.[1] ?? 0) / Math.max(1, candidates.length)
      const coverB = (peaks[j]?.[1] ?? 0) / Math.max(1, candidates.length)
      if (coverA >= PDF.COLUMN_MIN_COVERAGE && coverB >= PDF.COLUMN_MIN_COVERAGE) {
        leftPeak = Math.min(a, b)
        rightPeak = Math.max(a, b)
      }
    }
  }

  if (leftPeak === undefined || rightPeak === undefined) {
    return lines.map((line) => ({ ...line, column: 0 }))
  }

  let split = (leftPeak + rightPeak) / 2
  let best = Infinity
  for (let x = leftPeak; x <= rightPeak; x += PDF.COLUMN_BIN) {
    const count = candidates.filter(
      (line) => line.bbox[0] >= x && line.bbox[0] < x + PDF.COLUMN_BIN,
    ).length
    if (count < best) {
      best = count
      split = x
    }
  }

  return lines.map((line) => {
    const mid = (line.bbox[0] + line.bbox[2]) / 2
    const wide = line.bbox[2] - line.bbox[0] > PDF.SPAN_MIN_WIDTH * pageWidth
    if (wide && line.bbox[0] < split && line.bbox[2] > split) return { ...line, column: -1 }
    return { ...line, column: mid < split ? 0 : 1 }
  })
}

export function readingOrder(lines: Lined[]): Lined[] {
  const bands: Lined[][] = []
  const sorted = [...lines].sort((a, b) => b.bbox[3] - a.bbox[3])
  let current: Lined[] = []
  let span = false
  for (const line of sorted) {
    if (line.column === -1) {
      if (current.length) bands.push(current)
      bands.push([line])
      current = []
      span = true
      continue
    }
    current.push(line)
    void span
  }
  if (current.length) bands.push(current)

  const ordered: Lined[] = []
  for (const band of bands) {
    const left = band.filter((l) => l.column <= 0).sort((a, b) => b.baseline - a.baseline)
    const right = band.filter((l) => l.column === 1).sort((a, b) => b.baseline - a.baseline)
    if (band.length === 1 && band[0]?.column === -1) ordered.push(band[0])
    else ordered.push(...left, ...right)
  }
  return ordered
}
