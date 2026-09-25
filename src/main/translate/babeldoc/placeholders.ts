// BabelDOC 0.6.4 il_translator.ILTranslator: get_translate_input, create_*_placeholder and
// parse_translate_output, with the OpenAI translator's placeholder shapes ({vN} and
// <style id='N'>…</style>) that pdf2zh-next's LLM translators use.
import type { BaseStyle, CharStyle, FontFlags, OutputComp } from '../../../shared/pdf-types'
import type { FontMapper } from '../../pdf/babeldoc/fontmap'
import {
  getCharUnicodeString,
  isPlaceholderOnlyParagraph,
  isPureNumericParagraph,
  isSameStyle,
  isSameStyleExceptFont,
  isSameStyleExceptSize,
  type BdParagraph,
  type CharLike,
  type FormulaComp,
  type Run,
} from './paragraphs'

type FormulaPlaceholder = {
  kind: 'formula'
  id: number
  formula: FormulaComp
  placeholder: string
  pattern: string
}

type RichTextPlaceholder = {
  kind: 'rich'
  id: number
  run: Run
  left: string
  right: string
  leftPattern: string
  rightPattern: string
}

export type Placeholder = FormulaPlaceholder | RichTextPlaceholder

export type TranslateInput = {
  unicode: string
  placeholders: Placeholder[]
  base: BaseStyle | null
  /** Placeholder-like tokens already in the source text, with their counts. */
  originalTokens: Map<string, number>
}

// OpenAITranslator.get_formular_placeholder / get_rich_text_*_placeholder
const formulaPlaceholder = (id: number | string) => ({
  text: `{v${id}}`,
  pattern: `\\{\\s*v\\s*${id}\\s*\\}`,
})
const leftPlaceholder = (id: number | string) => ({
  text: `<style id='${id}'>`,
  pattern: `<\\s*style\\s*id\\s*=\\s*'\\s*${id}\\s*'\\s*>`,
})
const RIGHT = { text: '</style>', pattern: '<\\s*\\/\\s*style\\s*>' }

// The same shapes with any number: ILTranslator's hallucination filters.
const FORMULA_ANY = formulaPlaceholder('\\d+').pattern
const LEFT_ANY = leftPlaceholder('\\d+').pattern

/** Python re.match with re.IGNORECASE: anchored at the start only. */
function matchesAtStart(pattern: string, text: string): boolean {
  return new RegExp(`^(?:${pattern})`, 'iu').test(text)
}

function createFormulaPlaceholder(
  formula: FormulaComp,
  id: number,
  p: BdParagraph,
): FormulaPlaceholder {
  const shape = formulaPlaceholder(id)
  if (matchesAtStart(shape.pattern, p.unicode)) return createFormulaPlaceholder(formula, id + 1, p)
  return { kind: 'formula', id, formula, placeholder: shape.text, pattern: shape.pattern }
}

function createRichTextPlaceholder(run: Run, id: number, p: BdParagraph): RichTextPlaceholder {
  const left = leftPlaceholder(id)
  if (matchesAtStart(`${left.pattern}|${RIGHT.pattern}`, p.unicode)) {
    return createRichTextPlaceholder(run, id + 1, p)
  }
  return {
    kind: 'rich',
    id,
    run,
    left: left.text,
    right: RIGHT.text,
    leftPattern: left.pattern,
    rightPattern: RIGHT.pattern,
  }
}

function scanTokens(text: string): Map<string, number> {
  const tokens = new Map<string, number>()
  for (const pattern of [FORMULA_ANY, LEFT_ANY, RIGHT.pattern]) {
    for (const match of text.matchAll(new RegExp(pattern, 'giu'))) {
      tokens.set(match[0], (tokens.get(match[0]) ?? 0) + 1)
    }
  }
  return tokens
}

export type InputOptions = {
  disableRichText: boolean
  mapper: FontMapper
  fonts: Readonly<Record<string, FontFlags>>
}

/** ILTranslator.get_translate_input; undefined when the paragraph is not translated. */
export function getTranslateInput(
  p: BdParagraph,
  options: InputOptions,
): TranslateInput | undefined {
  if (p.compositions.length === 0) return undefined
  if (isPureNumericParagraph(p)) return undefined
  if (isPlaceholderOnlyParagraph(p)) return undefined
  const originalTokens = p.unicode ? scanTokens(p.unicode) : new Map<string, number>()
  if (p.compositions.length === 1) {
    const only = p.compositions[0]!
    if (only.kind === 'formula') return undefined
    return { unicode: p.unicode, placeholders: [], base: p.base, originalTokens }
  }

  let placeholderId = 1
  const placeholders: Placeholder[] = []
  const chars: Array<CharLike | string> = []
  for (const comp of p.compositions) {
    if (comp.kind === 'formula') {
      const placeholder = createFormulaPlaceholder(comp, placeholderId, p)
      placeholders.push(placeholder)
      placeholderId = placeholder.id + 1
      chars.push(...placeholder.placeholder)
    } else if (options.disableRichText || !p.base) {
      chars.push(...comp.chars)
    } else {
      const base = p.base
      const fonta = options.mapper.map(options.fonts[comp.style.font], '1')
      const fontb = options.mapper.map(options.fonts[base.font], '1')
      if (
        isSameStyle(comp.style, base) ||
        isSameStyleExceptSize(comp.style, base) ||
        (isSameStyleExceptFont(comp.style, base) && fonta && fontb && fonta === fontb)
      ) {
        chars.push(...comp.chars)
      } else {
        const placeholder = createRichTextPlaceholder(comp, placeholderId, p)
        placeholders.push(placeholder)
        placeholderId = placeholder.id + 2
        chars.push(placeholder.left, ...comp.chars, placeholder.right)
      }
    }
    // 如果占位符数量超过阈值，且未禁用富文本翻译，则递归调用并禁用富文本翻译
    if (placeholders.length > 40 && !options.disableRichText) {
      return getTranslateInput(p, { ...options, disableRichText: true })
    }
  }
  return {
    unicode: getCharUnicodeString(chars),
    placeholders,
    base: p.base,
    originalTokens,
  }
}

function styleOf(style: CharStyle | BaseStyle | null, fallback: BaseStyle | null): BaseStyle {
  const s = style ?? fallback
  return s ? { font: s.font, size: s.size, gstate: s.gstate } : { font: '', size: 0, gstate: null }
}

/** ILTranslator.parse_translate_output → paragraph compositions for the typesetter. */
export function parseTranslateOutput(input: TranslateInput, output: string): OutputComp[] {
  const base = styleOf(input.base, null)
  if (input.placeholders.length === 0) return [{ kind: 'text', text: output, style: base }]

  const patterns: string[] = []
  const placeholderPatterns: string[] = []
  for (const p of input.placeholders) {
    if (p.kind === 'formula') {
      patterns.push(`(${p.pattern})`)
      placeholderPatterns.push(`(${p.pattern})`)
    } else {
      patterns.push(`(${p.leftPattern}.*?${p.rightPattern})`)
      placeholderPatterns.push(`(${p.leftPattern})`, `(${p.rightPattern})`)
    }
  }
  const combined = patterns.join('|')
  const combinedPlaceholders = placeholderPatterns.join('|')
  const allowed = new Set<string>(input.originalTokens.keys())
  for (const p of input.placeholders) {
    if (p.kind === 'formula') allowed.add(p.placeholder)
    else allowed.add(p.left).add(p.right)
  }
  const removePlaceholder = (text: string): string => {
    let out = combinedPlaceholders
      ? text.replace(new RegExp(combinedPlaceholders, 'giu'), '')
      : text
    const keep = (token: string) => (allowed.has(token) ? token : '')
    out = out.replace(new RegExp(FORMULA_ANY, 'giu'), keep)
    out = out.replace(new RegExp(LEFT_ANY, 'giu'), keep)
    out = out.replace(new RegExp(RIGHT.pattern, 'giu'), keep)
    return out
  }

  const result: OutputComp[] = []
  let lastEnd = 0
  for (const match of output.matchAll(new RegExp(combined, 'giu'))) {
    const start = match.index
    if (start > lastEnd) {
      const text = output.slice(lastEnd, start)
      if (text) result.push({ kind: 'text', text: removePlaceholder(text), style: base })
    }
    const matched = match[0]
    const formula = input.placeholders.find(
      (p): p is FormulaPlaceholder =>
        p.kind === 'formula' && new RegExp(`^${p.pattern}$`, 'iu').test(matched),
    )
    if (formula) {
      result.push({ kind: 'formula', index: formula.formula.index })
    } else {
      const rich = input.placeholders.find(
        (p): p is RichTextPlaceholder =>
          p.kind === 'rich' && new RegExp(`^${p.leftPattern}`, 'iu').test(matched),
      )!
      const inner =
        new RegExp(`^${rich.leftPattern}(.*)${rich.rightPattern}$`, 'iu').exec(matched)?.[1] ?? ''
      const original = rich.run.chars.map((c) => c.text).join('')
      if (inner.replaceAll(' ', '') === original.replaceAll(' ', '')) {
        result.push({ kind: 'original', from: rich.run.from, to: rich.run.to })
      } else {
        result.push({
          kind: 'text',
          text: removePlaceholder(inner),
          style: styleOf(rich.run.style, null),
        })
      }
    }
    lastEnd = start + matched.length
  }
  if (lastEnd < output.length) {
    const text = output.slice(lastEnd)
    if (text) result.push({ kind: 'text', text: removePlaceholder(text), style: base })
  }
  return result
}
