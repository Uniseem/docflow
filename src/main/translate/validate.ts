import { stripReasoning } from './response'

const ZERO_WIDTH = /[\u200b\ufeff]/g
const PDF_MARK = /\{\s*v\s*\d+\s*\}/g
const GENERIC_MARKER =
  /D\s*O\s*C\s*F\s*L\s*O\s*W\s*K\s*E\s*E\s*P[\s:_-]*(\d[\s\d]{0,11})[\s_-]*T\s*O\s*K\s*E\s*N/gi

export type MarkerMode = 'standard' | 'strict' | 'isolated'

export class ValidateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValidateError'
  }
}

export function cleanReply(text: string, source = ''): string {
  let value = stripReasoning(text).replace(ZERO_WIDTH, '')
  if (!source.trimStart().startsWith('```')) {
    const fenced = value.trim().match(/^```[^\n]*\n([\s\S]*?)\n```$/)
    if (fenced?.[1] !== undefined) value = fenced[1]
  }
  return value
}

export function pdfMarkerSequence(text: string): string[] {
  return text.match(/\{\s*v\s*\d+\s*\}/g) ?? []
}

function gap(extra = ''): string {
  return `[\\\`\\s\\t_${extra}-]*`
}

function tokenPattern(token: string): RegExp {
  const digits = token.slice('DOCFLOWKEEP'.length, -'TOKEN'.length)
  const chars = [
    'D',
    'O',
    'C',
    'F',
    'L',
    'O',
    'W',
    'K',
    'E',
    'E',
    'P',
    ...Array.from(digits),
    'T',
    'O',
    'K',
    'E',
    'N',
  ]
  const last = chars.length - 1
  const body = chars
    .map((char, index) => {
      if (index === 10) return `${char}[\\\`\\s\\t:_-]*`
      if (index === last) return char
      return `${char}${gap()}`
    })
    .join('')
  return new RegExp(`\`*\\s*${body}\\s*\`*`, 'gi')
}

function markerDigits(token: string): string {
  return token.replace(/\D/g, '').slice(0, 6)
}

export function normalizeMarkers(text: string, tokens: string[]): string {
  let value = text.replace(ZERO_WIDTH, '')
  for (const token of tokens) {
    value = value.replace(tokenPattern(token), token)
  }
  GENERIC_MARKER.lastIndex = 0
  const suspected = [...value.matchAll(GENERIC_MARKER)]
  if (suspected.length !== tokens.length) {
    throw new ValidateError(
      `保护标记数量不匹配：原文需要 ${tokens.length} 个，译文检测到 ${suspected.length} 个`,
    )
  }
  const foundDigits = suspected.map((row) =>
    (row[1] ?? '').replace(/\D/g, '').padStart(6, '0').slice(-6),
  )
  const expectedDigits = tokens.map(markerDigits).sort()
  const sortedFound = [...foundDigits].sort()
  if (sortedFound.join(',') !== expectedDigits.join(',')) {
    throw new ValidateError('保护标记的编号发生变化，需要重译')
  }
  for (const token of tokens) {
    if (value.split(token).length - 1 !== 1) {
      throw new ValidateError(`保护标记 ${token} 无法恢复为唯一位置`)
    }
  }
  return value
}

export function restoreAndCheckPdf(
  text: string,
  originals: Map<string, string>,
  source: string,
  mode: MarkerMode,
): string {
  let restored = text
  for (const [token, original] of originals) {
    restored = restored.split(token).join(original)
  }
  for (const token of originals.keys()) {
    if (restored.includes(token)) {
      throw new ValidateError('译文中仍有未恢复的保护标记')
    }
  }
  if (mode === 'isolated') {
    GENERIC_MARKER.lastIndex = 0
    PDF_MARK.lastIndex = 0
    if (GENERIC_MARKER.test(restored) || PDF_MARK.test(restored)) {
      throw new ValidateError('隔离模式的译文不得含保护标记')
    }
    return restored
  }
  if (pdfMarkerSequence(restored).join('\0') !== pdfMarkerSequence(source).join('\0')) {
    throw new ValidateError('PDF 公式或样式标记丢失、增加或顺序改变')
  }
  return restored
}

export type ReplyCheck =
  | { ok: true; text: string }
  | { ok: false; kind: 'truncated' | 'refused' | 'empty' | 'invalid'; message: string }

export function checkReply(input: {
  text: string
  finish: 'complete' | 'truncated' | 'refused'
  source: string
  tokens: string[]
  originals: Map<string, string>
  mode: MarkerMode
}): ReplyCheck {
  if (input.finish === 'truncated') {
    return { ok: false, kind: 'truncated', message: '译文输出被截断（达到输出长度上限）' }
  }
  if (input.finish === 'refused') {
    return { ok: false, kind: 'refused', message: '服务拒绝翻译这段内容' }
  }
  const cleaned = cleanReply(input.text, input.source)
  if (!cleaned.trim()) return { ok: false, kind: 'empty', message: '译文为空' }
  try {
    const normalized = normalizeMarkers(cleaned, input.tokens)
    const restored = restoreAndCheckPdf(normalized, input.originals, input.source, input.mode)
    return { ok: true, text: restored }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, kind: 'invalid', message }
  }
}
