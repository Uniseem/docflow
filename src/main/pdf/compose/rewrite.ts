import { PDF } from '../../../shared/pdf-constants'
import type { Paragraph, Rect } from '../../../shared/pdf-types'
import type { TextOp } from './content-walker'

export type Warning = {
  paragraphId?: string
  page?: number
  code: string
  message: string
}

export function expandRect(rect: Rect, pad: number): Rect {
  return [rect[0] - pad, rect[1] - pad, rect[2] + pad, rect[3] + pad]
}

export function pointInRect(x: number, y: number, rect: Rect): boolean {
  return x >= rect[0] && x <= rect[2] && y >= rect[1] && y <= rect[3]
}

export function spliceRanges(bytes: Uint8Array, ranges: Array<[number, number]>): Uint8Array {
  if (ranges.length === 0) return bytes
  const merged = mergeRanges(ranges.filter(([a, b]) => b > a))
  const parts: Uint8Array[] = []
  let cursor = 0
  for (const [start, end] of merged) {
    if (start > cursor) parts.push(bytes.subarray(cursor, start))
    cursor = Math.max(cursor, end)
  }
  if (cursor < bytes.length) parts.push(bytes.subarray(cursor))
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const part of parts) {
    out.set(part, o)
    o += part.length
  }
  return out
}

function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const out: Array<[number, number]> = []
  for (const range of sorted) {
    const last = out.at(-1)
    if (!last || range[0] > last[1]) out.push([range[0], range[1]])
    else last[1] = Math.max(last[1], range[1])
  }
  return out
}

export function deletionSet(
  ops: TextOp[],
  targets: Paragraph[],
): { deleted: TextOp[]; expected: number; mismatch: boolean } {
  const expected = new Set<number>()
  for (const para of targets) {
    for (const line of para.lines) for (const seq of line.opSeqs) expected.add(seq)
  }
  let deleted = ops.filter((op) => inLineBoxes(op, targets))
  if (deleted.length < expected.size) {
    deleted = ops.filter((op) => inParagraphBoxes(op, targets))
  }
  if (deleted.length < expected.size) {
    const chosen = new Set(deleted)
    const nearby = ops.filter((op) => !chosen.has(op) && nearParagraph(op, targets))
    deleted = [...deleted, ...closestToBaselines(nearby, targets, expected.size - deleted.length)]
  }
  if (deleted.length > expected.size) deleted = closestToBaselines(deleted, targets, expected.size)
  return { deleted, expected: expected.size, mismatch: deleted.length !== expected.size }
}

function nearParagraph(op: TextOp, targets: Paragraph[]): boolean {
  return targets.some((para) => {
    if (para.formPath !== op.formPath) return false
    const pad = PDF.REMOVE_PADDING * 3
    return pointInRect(op.start[0], op.start[1], expandRect(para.bbox, pad))
  })
}

function inLineBoxes(op: TextOp, targets: Paragraph[]): boolean {
  return targets.some(
    (para) =>
      para.formPath === op.formPath &&
      para.lines.some((line) =>
        pointInRect(op.start[0], op.start[1], expandRect(line.bbox, PDF.REMOVE_PADDING)),
      ),
  )
}

function inParagraphBoxes(op: TextOp, targets: Paragraph[]): boolean {
  return targets.some(
    (para) =>
      para.formPath === op.formPath &&
      pointInRect(op.start[0], op.start[1], expandRect(para.bbox, PDF.REMOVE_PADDING)),
  )
}

function closestToBaselines(ops: TextOp[], targets: Paragraph[], keep: number): TextOp[] {
  const baselines = targets.flatMap((para) => para.lines.map((line) => line.baseline))
  const scored = ops.map((op) => {
    const dist = Math.min(...baselines.map((y) => Math.abs(y - op.start[1])), 1e9)
    return { op, dist }
  })
  scored.sort((a, b) => a.dist - b.dist)
  return scored.slice(0, keep).map((row) => row.op)
}

export function shouldSkipPage(deleted: number, expected: number): boolean {
  const base = Math.max(expected, 1)
  return Math.abs(deleted - expected) / base > PDF.PAGE_SKIP_MISMATCH_RATIO
}

export function matchOpsToGlyphs(
  ops: TextOp[],
  firsts: Array<{ opSeq: number; x: number; y: number; formPath: string }>,
): number {
  let hits = 0
  for (const op of ops) {
    const hit = firsts.some(
      (g) =>
        g.formPath === op.formPath &&
        Math.hypot(g.x - op.start[0], g.y - op.start[1]) <= PDF.OP_MATCH_TOLERANCE,
    )
    if (hit) hits += 1
  }
  return hits
}
