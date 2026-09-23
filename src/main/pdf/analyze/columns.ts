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

/** Median line size weighted by text length, so a crowd of tiny figure labels can't win. */
export function bodySizeOf(lines: Lined[]): number {
  const weights = lines.map((line) => Math.max(1, line.text.replace(/\{v\d+\}/g, '').length))
  return median(
    lines.flatMap((line, i) => Array.from({ length: weights[i] ?? 1 }, () => line.size)),
  )
}

function bodyLines(lines: Lined[]): Lined[] {
  const bodySize = bodySizeOf(lines)
  return lines.filter(
    (line) => !line.formulaLine && line.size >= 0.75 * bodySize && line.size <= 1.25 * bodySize,
  )
}

function crossesSplit(line: Lined, split: number): boolean {
  const margin = PDF.COLUMN_BIN / 2
  return line.bbox[0] < split - margin && line.bbox[2] > split + margin
}

/** x of the gutter when the page's body text sits in two columns. */
export function detectColumnSplit(lines: Lined[], pageWidth: number): number | undefined {
  if (lines.length === 0) return undefined
  const candidates = bodyLines(lines)
  const binOf = (line: Lined) => Math.floor(line.bbox[0] / PDF.COLUMN_BIN)
  const bins = new Map<number, number>()
  for (const line of candidates) bins.set(binOf(line), (bins.get(binOf(line)) ?? 0) + 1)
  // A column's left edges can straddle a bin boundary (72 pt vs 81 pt indents), so each peak
  // counts its neighbours too.
  const windowCount = (bin: number) =>
    (bins.get(bin - 1) ?? 0) + (bins.get(bin) ?? 0) + (bins.get(bin + 1) ?? 0)
  const peaks = [...bins.keys()].sort((a, b) => windowCount(b) - windowCount(a)).slice(0, 6)
  const minSep = PDF.COLUMN_MIN_SEPARATION * pageWidth
  const minCount = PDF.COLUMN_MIN_COVERAGE * Math.max(1, candidates.length)
  let pair: [number, number] | undefined
  for (let i = 0; i < peaks.length && !pair; i += 1) {
    for (let j = i + 1; j < peaks.length; j += 1) {
      const a = peaks[i]!
      const b = peaks[j]!
      if (Math.abs(a - b) * PDF.COLUMN_BIN < minSep) continue
      if (windowCount(a) >= minCount && windowCount(b) >= minCount) {
        pair = [Math.min(a, b), Math.max(a, b)]
        break
      }
    }
  }
  if (!pair) return undefined
  const [leftBin, rightBin] = pair
  const near = (bin: number) => candidates.filter((line) => Math.abs(binOf(line) - bin) <= 1)
  // Scan from where every left-column line has started to where the first right one starts.
  const from = Math.max(...near(leftBin).map((line) => line.bbox[0]))
  const to = Math.min(...near(rightBin).map((line) => line.bbox[0]))
  if (!(to - from > 2)) return undefined
  return gutterCenter(candidates, from, to)
}

/**
 * Whether a split found on an earlier page also fits this one: body text on both sides and
 * hardly any body line crossing it. Pages where a figure fills one column have too little
 * text there for detectColumnSplit, but still read column by column.
 */
export function columnSplitFits(lines: Lined[], split: number): boolean {
  const candidates = bodyLines(lines)
  let left = 0
  let right = 0
  let crossing = 0
  for (const line of candidates) {
    if (crossesSplit(line, split)) crossing += 1
    else if ((line.bbox[0] + line.bbox[2]) / 2 < split) left += 1
    else right += 1
  }
  return left > 0 && right > 0 && crossing <= 0.15 * candidates.length
}

export function assignColumns(lines: Lined[], split: number | undefined): Lined[] {
  if (split === undefined) return lines.map((line) => ({ ...line, column: 0 }))
  // Column text never crosses the gutter, so a text line that does (a centered title, a wide
  // caption or table) spans both columns, however narrow it is. Formula-only lines (margin
  // watermarks, figure ticks) never open a band of their own.
  return lines.map((line) => {
    if (!line.formulaLine && crossesSplit(line, split)) return { ...line, column: -1 }
    const mid = (line.bbox[0] + line.bbox[2]) / 2
    return { ...line, column: mid < split ? 0 : 1 }
  })
}

/**
 * The split is the middle of the widest stretch between the two columns' left edges that the
 * fewest candidate lines cross — the gutter. Justified columns share one left edge, so the
 * first empty left-edge bin sits right after the left margin, not in the gutter.
 */
function gutterCenter(candidates: Lined[], from: number, to: number): number {
  let best = Infinity
  let bestStart = from
  let bestEnd = to
  let runStart = -1
  for (let x = Math.floor(from) + 1; x < to; x += 1) {
    const cover = candidates.filter((line) => line.bbox[0] < x && line.bbox[2] > x).length
    if (cover < best) {
      best = cover
      bestStart = x
      bestEnd = x
      runStart = x
    } else if (cover === best) {
      if (runStart < 0) runStart = x
      if (x - runStart > bestEnd - bestStart) {
        bestStart = runStart
        bestEnd = x
      }
    } else {
      runStart = -1
    }
  }
  return (bestStart + bestEnd) / 2
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
