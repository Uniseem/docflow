// Small pieces of BabelDOC 0.6.4 / pdf2zh-next 2.9.0 the translation port shares.
import { encode } from 'gpt-tokenizer/encoding/o200k_base'

/**
 * `len(tiktoken.encoding_for_model("gpt-4o").encode(text, disallowed_special=()))`; o200k_base
 * through gpt-tokenizer. Special-token strings count as ordinary text; errors count 0.
 */
export function countTokens(text: string): number {
  try {
    return encode(text, { disallowedSpecial: new Set() }).length
  } catch {
    return 0
  }
}

/** Python `len(s)`: code points. */
export function pyLen(text: string): number {
  return [...text].length
}

// Python's whitespace (str.isspace): JavaScript's \s without U+FEFF, plus U+001C–U+001F, U+0085.
const PY_SPACE_CLASS =
  '\\t\\n\\v\\f\\r\\u001c-\\u001f \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000'
const PY_SPACE = new RegExp(`^[${PY_SPACE_CLASS}]$`, 'u')
const PY_SPACE_RUN = new RegExp(`[${PY_SPACE_CLASS}]+`, 'gu')

/** Python str.isspace() for one character. */
export function isPySpace(ch: string): boolean {
  return PY_SPACE.test(ch)
}

/** Python str.strip() */
export function pyStrip(text: string): string {
  const chars = [...text]
  let start = 0
  let end = chars.length
  while (start < end && isPySpace(chars[start]!)) start += 1
  while (end > start && isPySpace(chars[end - 1]!)) end -= 1
  return chars.slice(start, end).join('')
}

/** `regex.sub(r"\s+", " ", unicodedata.normalize("NFKC", s))` */
export function normalizeSpaces(text: string): string {
  return text.normalize('NFKC').replace(PY_SPACE_RUN, ' ')
}

/** pdf2zh-next BaseTranslator._remove_cot_content, after the reply's `.strip()`. */
export function cleanLlmReply(content: string): string {
  return pyStrip(content).replace(/^<think>[\s\S]+?<\/think>/, '')
}

/** ILTranslatorLLMOnly._clean_json_output / AutomaticTermExtractor._clean_json_output */
export function cleanJsonOutput(output: string): string {
  let text = pyStrip(output)
  if (text.startsWith('<json>')) text = text.slice(6)
  if (text.endsWith('</json>')) text = text.slice(0, -7)
  if (text.startsWith('```json')) text = text.slice(7)
  if (text.startsWith('```')) text = text.slice(3)
  if (text.endsWith('```')) text = text.slice(0, -3)
  return pyStrip(text)
}

/** `re.sub(r"[. 。…，]{20,}", ".", text)` */
export function collapsePunctuationRuns(text: string): string {
  return text.replace(/[. 。…，]{20,}/g, '.')
}

/** python-Levenshtein `distance` over code points. */
export function levenshtein(a: string, b: string): number {
  const s = [...a]
  const t = [...b]
  if (s.length === 0) return t.length
  if (t.length === 0) return s.length
  let prev = Array.from({ length: t.length + 1 }, (_, i) => i)
  let cur = new Array<number>(t.length + 1).fill(0)
  for (let i = 1; i <= s.length; i += 1) {
    cur[0] = i
    for (let j = 1; j <= t.length; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost)
    }
    ;[prev, cur] = [cur, prev]
  }
  return prev[t.length]!
}

/** Python string.Template.substitute for the $name placeholders the prompts use. */
export function substitute(template: string, values: Record<string, string>): string {
  return template.replace(/\$(?:(\$)|([_a-zA-Z][_a-zA-Z0-9]*))/g, (match, escaped, name) => {
    if (escaped) return '$'
    const key = name as string
    if (!Object.hasOwn(values, key)) throw new Error(`missing template value ${key}`)
    return values[key]!
  })
}
