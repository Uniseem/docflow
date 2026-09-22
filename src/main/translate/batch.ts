import {
  DEFAULT_SYSTEM_PROMPT,
  PROTOCOL_LAYOUT,
  PROTOCOL_MARKERS,
  PROTOCOL_OUTPUT,
  PROTOCOL_PREAMBLE,
} from '../../shared/constants'
import type { TranslationRuntime } from '../../shared/types'

export type MarkerMode = 'standard' | 'strict' | 'isolated'
export type Segment = { id: string; text: string }

const TOKEN_RE = /DOCFLOWKEEP\d{6}TOKEN/g
const SEGMENT_RE = /<segment\s+id\s*=\s*["']?([^"'>\s]+)["']?\s*>([\s\S]*?)<\/segment\s*>/g

export function charCount(text: string): number {
  return Array.from(text).length
}

export function smartSplit(text: string, limit: number): string[] {
  const max = Math.max(1, limit)
  const chars = Array.from(text)
  if (chars.length <= max) return [text]
  const tokenRanges: Array<[number, number]> = []
  TOKEN_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = TOKEN_RE.exec(text)) !== null) {
    const start = charCount(text.slice(0, match.index))
    tokenRanges.push([start, start + charCount(match[0])])
  }
  const insideToken = (position: number) =>
    tokenRanges.some(([start, end]) => start < position && position < end)
  const score = (position: number): number => {
    const previous = chars[position - 1]
    const before = position >= 2 ? chars[position - 2] : ' '
    if (previous === '\n') return 4
    if (
      previous === '。' ||
      previous === '！' ||
      previous === '？' ||
      previous === '；' ||
      (previous !== undefined &&
        /\s/.test(previous) &&
        (before === '.' || before === '!' || before === '?' || before === ';'))
    ) {
      return 3
    }
    if (
      (previous !== undefined && /\s/.test(previous)) ||
      previous === '，' ||
      previous === ',' ||
      previous === '、' ||
      previous === '：' ||
      previous === ':'
    ) {
      return 2
    }
    return 0
  }
  const result: string[] = []
  let start = 0
  while (chars.length - start > max) {
    const windowEnd = start + max
    const windowStart = start + Math.floor(max / 2)
    let bestScore = 0
    let bestEnd = windowEnd
    for (let position = windowEnd; position >= Math.max(windowStart, start + 1); position -= 1) {
      if (insideToken(position)) continue
      const value = score(position)
      if (value > bestScore) {
        bestScore = value
        bestEnd = position
        if (value === 4) break
      }
    }
    let end = bestEnd
    if (bestScore === 0) {
      const covering = tokenRanges.find(
        ([tokenStart, tokenEnd]) => tokenStart < end && end < tokenEnd,
      )
      if (covering) end = covering[0] > start ? covering[0] : covering[1]
    }
    result.push(chars.slice(start, end).join(''))
    start = end
  }
  if (start < chars.length) result.push(chars.slice(start).join(''))
  return result
}

export function expandLongSegments(segments: Segment[], chunkChars: number): Segment[] {
  const out: Segment[] = []
  for (const segment of segments) {
    if (charCount(segment.text) <= chunkChars) {
      out.push(segment)
      continue
    }
    const parts = smartSplit(segment.text, chunkChars)
    parts.forEach((text, index) => {
      out.push({ id: `${segment.id}#${index + 1}`, text })
    })
  }
  return out
}

export function joinSplitResults(results: Segment[]): Segment[] {
  const groups = new Map<string, Segment[]>()
  const order: string[] = []
  for (const item of results) {
    const parent = parentId(item.id)
    const list = groups.get(parent)
    if (list) list.push(item)
    else {
      groups.set(parent, [item])
      order.push(parent)
    }
  }
  return order.map((id) => {
    const parts = groups.get(id) ?? []
    if (parts.length === 1 && parts[0]?.id === id) return parts[0]
    return { id, text: parts.map((part) => part.text).join('') }
  })
}

function parentId(id: string): string {
  const hash = id.lastIndexOf('#')
  if (hash <= 0) return id
  const suffix = id.slice(hash + 1)
  return /^\d+$/.test(suffix) ? id.slice(0, hash) : id
}

export function planBatches(segments: Segment[], runtime: TranslationRuntime): Segment[][] {
  const maxSegments = Math.max(1, runtime.llm.maxSegmentsPerRequest)
  const maxChars = Math.max(runtime.llm.maxRequestChars, runtime.llm.chunkChars)
  const expanded = expandLongSegments(segments, runtime.llm.chunkChars)
  const batches: Segment[][] = []
  let current: Segment[] = []
  let chars = 0
  for (const segment of expanded) {
    const n = charCount(segment.text)
    const alone = segment.text.trim() === ''
    if (alone || current.length >= maxSegments || (current.length > 0 && chars + n > maxChars)) {
      if (current.length > 0) {
        batches.push(current)
        current = []
        chars = 0
      }
    }
    if (alone) {
      batches.push([segment])
      continue
    }
    current.push(segment)
    chars += n
  }
  if (current.length > 0) batches.push(current)
  return batches
}

export function parseBatch(reply: string): Map<string, string> {
  const found = new Map<string, string>()
  const missing = new Set<string>()
  SEGMENT_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = SEGMENT_RE.exec(reply)) !== null) {
    const id = match[1] ?? ''
    let body = match[2] ?? ''
    if (body.startsWith('\n')) body = body.slice(1)
    if (body.endsWith('\n')) body = body.slice(0, -1)
    if (!id || !body || found.has(id) || missing.has(id)) {
      found.delete(id)
      missing.add(id)
      continue
    }
    found.set(id, body)
  }
  return found
}

export function buildSystemPrompt(
  systemPrompt = DEFAULT_SYSTEM_PROMPT,
  mode: MarkerMode = 'standard',
  multi = false,
): string {
  const protocol = `${PROTOCOL_PREAMBLE}${PROTOCOL_LAYOUT}${PROTOCOL_MARKERS[mode]}${PROTOCOL_OUTPUT[multi ? 'multi' : 'single']}`
  return `${systemPrompt}\n\n${protocol}`
}

export function buildUserMessage(members: Segment[]): string {
  if (members.length === 1) return members[0]?.text ?? ''
  return members
    .map((member) => `<segment id="${member.id}">\n${member.text}\n</segment>`)
    .join('\n\n')
}
