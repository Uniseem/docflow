import { PDF } from '../../../shared/pdf-constants'
import type { FormulaRun, Glyph } from '../../../shared/pdf-types'
import type { RawLine } from './lines'
import { lineBBox } from './lines'

const CHAR_CAT = /^[\p{Lm}\p{Mn}\p{Sk}\p{Sm}\p{Zl}\p{Zp}\p{Zs}]/u
const GREEK = /^[\u0370-\u03FF]/
const ITALIC_WORD = /[A-Za-z]{2,}/g

export type Lined = RawLine & {
  bbox: ReturnType<typeof lineBBox>
  baseline: number
  size: number
  runs: FormulaRun[]
  text: string
  opSeqs: number[]
  column: number
  formulaLine: boolean
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0)
}

function weightedMode(pairs: Array<{ value: number; weight: number }>): number {
  if (pairs.length === 0) return 0
  const buckets = new Map<string, { value: number; weight: number }>()
  for (const pair of pairs) {
    const key = pair.value.toFixed(2)
    const cur = buckets.get(key)
    if (cur) cur.weight += pair.weight
    else buckets.set(key, { value: pair.value, weight: pair.weight })
  }
  let best = pairs[0]!
  for (const row of buckets.values()) {
    if (row.weight > best.weight) best = row
  }
  return best.value
}

function isZsOnly(g: Glyph): boolean {
  return g.unicode !== '' && g.unicode !== ' ' && /^\p{Zs}/u.test(g.unicode)
}

export function isFormulaGlyph(
  g: Glyph,
  lineSize: number,
  priorMain: number,
  prevFormula: boolean,
  depth: { n: number },
): boolean {
  if (PDF.FORMULA_FONT_RE.test(g.fontFamily)) return true
  if (g.unicode === '') return true
  if (g.unicode && g.unicode !== ' ' && (CHAR_CAT.test(g.unicode) || GREEK.test(g.unicode))) {
    if (isZsOnly(g)) return prevFormula
    return true
  }
  if (g.size < PDF.SUBSCRIPT_SIZE_RATIO * lineSize && priorMain >= 2) return true
  if (g.vertical || g.rotated) return true
  if (prevFormula && g.unicode === '(') {
    depth.n += 1
    return true
  }
  if (depth.n > 0 && g.unicode === ')') {
    depth.n -= 1
    return true
  }
  return false
}

function italicProse(glyphs: Glyph[], size: number): boolean {
  // TeX output has no space glyphs; words are split by gaps, as in the line text below.
  let text = ''
  let last: Glyph | undefined
  for (const g of glyphs) {
    if (
      last &&
      (g.isSpace || last.isSpace || g.x - (last.x + last.width) > PDF.LINE_SPACE_GAP * size)
    ) {
      text += ' '
    }
    text += g.unicode
    last = g
  }
  const words = text.match(ITALIC_WORD) ?? []
  return words.length >= PDF.ITALIC_TEXT_MIN_WORDS
}

export function attachFormulas(lines: RawLine[]): Lined[] {
  return lines.map((line) => {
    const prelimSize =
      weightedMode(line.glyphs.map((g) => ({ value: g.size, weight: Math.max(g.width, 0.1) }))) ||
      line.glyphs[0]?.size ||
      10
    const flags: boolean[] = []
    const depth = { n: 0 }
    let priorMain = 0
    let prevFormula = false
    for (const g of line.glyphs) {
      const flag = isFormulaGlyph(g, prelimSize, priorMain, prevFormula, depth)
      flags.push(flag)
      if (flag) prevFormula = true
      else {
        prevFormula = false
        if (!g.isSpace) priorMain += 1
      }
    }

    // Relax italic prose runs
    let i = 0
    while (i < flags.length) {
      if (!flags[i] || !PDF.FORMULA_FONT_RE.test(line.glyphs[i]?.fontFamily ?? '')) {
        i += 1
        continue
      }
      let j = i
      while (
        j < flags.length &&
        flags[j] &&
        PDF.FORMULA_FONT_RE.test(line.glyphs[j]?.fontFamily ?? '')
      )
        j += 1
      const slice = line.glyphs.slice(i, j)
      if (italicProse(slice, prelimSize)) {
        for (let k = i; k < j; k += 1) {
          const g = line.glyphs[k]
          if (!g) continue
          const other =
            g.unicode === '' ||
            (g.unicode !== ' ' && (CHAR_CAT.test(g.unicode) || GREEK.test(g.unicode))) ||
            g.size < PDF.SUBSCRIPT_SIZE_RATIO * prelimSize
          flags[k] = other
        }
      }
      i = j
    }

    const runs: FormulaRun[] = []
    let runGlyphs: Glyph[] = []
    const flush = () => {
      if (runGlyphs.length === 0) return
      const bbox = lineBBox(runGlyphs)
      runs.push({
        id: runs.length + 1,
        glyphs: runGlyphs,
        bbox,
        baselineOffset: 0,
        width: bbox[2] - bbox[0],
        text: runGlyphs.map((g) => g.unicode).join(''),
      })
      runGlyphs = []
    }
    for (let idx = 0; idx < line.glyphs.length; idx += 1) {
      const g = line.glyphs[idx]!
      if (!flags[idx]) {
        flush()
        continue
      }
      const last = runGlyphs[runGlyphs.length - 1]
      if (last && g.x - (last.x + last.width) > PDF.FORMULA_MERGE_GAP * (g.size || prelimSize))
        flush()
      runGlyphs.push(g)
    }
    flush()

    const formulaIds = new Map<Glyph, number>()
    for (const run of runs) {
      for (const g of run.glyphs) formulaIds.set(g, run.id)
    }

    const main = line.glyphs.filter((g, idx) => !flags[idx] && !g.isSpace)
    const baseline = median((main.length ? main : line.glyphs).map((g) => g.y))
    const size = weightedMode(
      (main.length ? main : line.glyphs).map((g) => ({
        value: g.size,
        weight: Math.max(g.width, 0.1),
      })),
    )
    for (const run of runs) {
      run.baselineOffset = (run.glyphs[0]?.y ?? baseline) - baseline
    }

    const bbox = lineBBox(line.glyphs)
    const runWidth = runs.reduce((sum, run) => sum + run.width, 0)
    const leftover = line.glyphs
      .filter((g, idx) => !flags[idx])
      .map((g) => g.unicode)
      .join('')
    const hasWord = /[A-Za-z]{3,}/.test(leftover)
    const formulaLine =
      runWidth >= PDF.DISPLAY_MATH_WIDTH_RATIO * Math.max(1, bbox[2] - bbox[0]) || !hasWord

    const parts: string[] = []
    let last: Glyph | undefined
    const emitted = new Set<number>()
    for (const g of line.glyphs) {
      const runId = formulaIds.get(g)
      if (runId && !emitted.has(runId)) {
        if (last && (g.x - (last.x + last.width) > PDF.LINE_SPACE_GAP * size || last.isSpace))
          parts.push(' ')
        parts.push(`{v${runId}}`)
        emitted.add(runId)
        last = g
        continue
      }
      if (runId) {
        last = g
        continue
      }
      if (
        last &&
        (g.x - (last.x + last.width) > PDF.LINE_SPACE_GAP * size || last.isSpace || g.isSpace)
      ) {
        parts.push(' ')
      }
      parts.push(g.unicode)
      last = g
    }

    return {
      ...line,
      bbox,
      baseline,
      size: size || prelimSize,
      runs: formulaLine ? runs : runs,
      text: parts.join('').replace(/\s+/g, ' ').trim(),
      opSeqs: [...new Set(line.glyphs.map((g) => g.opSeq))],
      column: 0,
      formulaLine,
    }
  })
}
