// Prompt templates of BabelDOC 0.6.4, verbatim: il_translator_llm_only.PROMPT_TEMPLATE (a batch
// of paragraphs as JSON), il_translator.PROMPT_TEMPLATE (one paragraph, the fallback) and
// automatic_term_extractor.LLM_PROMPT_TEMPLATE.
import type { Glossary } from './glossary'
import { BATCH_TEMPLATE, SINGLE_TEMPLATE, TERMS_TEMPLATE } from './templates'
import { substitute } from './text'

/** pdf2zh-next passes "zh-CN" to BabelDOC when the target is Simplified Chinese. */
export const LANG_OUT = 'zh-CN'

export type TitleSnapshot = { id: string; unicode: string }

/** _build_role_block */
export function roleBlock(customPrompt: string): string {
  if (customPrompt) {
    let role = customPrompt.trim()
    if (!role.includes('Follow all rules strictly.')) {
      if (!role.endsWith('\n')) role += '\n'
      role += 'Follow all rules strictly.'
    }
    return role
  }
  return (
    `You are a professional ${LANG_OUT} native translator who needs to fluently translate text ` +
    `into ${LANG_OUT}.\n\n` +
    'Follow all rules strictly.'
  )
}

/** Python `sorted()` of (source, target) pairs. */
function sortedEntries(entries: ReadonlyArray<[string, string]>): Array<[string, string]> {
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
  return [...entries].sort((x, y) => cmp(x[0], y[0]) || cmp(x[1], y[1]))
}

function activeGlossaries(
  glossaries: readonly Glossary[],
  text: string,
): Array<[string, Array<[string, string]>]> {
  const out: Array<[string, Array<[string, string]>]> = []
  for (const glossary of glossaries) {
    const active = glossary.activeEntries(text)
    // A dict keyed by name: a later glossary with the same name replaces the earlier one.
    if (active.length > 0) {
      const at = out.findIndex(([name]) => name === glossary.name)
      const row: [string, Array<[string, string]>] = [glossary.name, sortedEntries(active)]
      if (at >= 0) out[at] = row
      else out.push(row)
    }
  }
  return out
}

function glossaryTables(entries: Array<[string, Array<[string, string]>]>): string[] {
  const lines: string[] = []
  for (const [name, rows] of entries) {
    lines.push(`### Glossary: ${name}`)
    lines.push('')
    lines.push('| Source Term | Target Term |\n|-------------|-------------|')
    for (const [source, target] of rows) lines.push(`| ${source} | ${target} |`)
    lines.push('')
  }
  return lines
}

/** ILTranslatorLLMOnly._build_llm_prompt */
export function batchPrompt(input: {
  jsonInput: string
  customPrompt: string
  title: TitleSnapshot | null
  localTitle: TitleSnapshot | null
  glossaries: readonly Glossary[]
  glossaryText: string
}): string {
  const contextual: string[] = []
  let hint = 1
  if (input.title) {
    contextual.push(`${hint}. First title in full text: ${input.title.unicode}`)
    hint += 1
  }
  if (input.localTitle && (!input.title || input.localTitle.id !== input.title.id)) {
    contextual.push(`${hint}. The most recent title is: ${input.localTitle.unicode}`)
  }
  const contextualHints = contextual.length
    ? `## Contextual Hints for Better Translation\n${contextual.join('\n')}\n`
    : ''

  const active = activeGlossaries(input.glossaries, input.glossaryText)
  let usageRules = ''
  let tables = ''
  if (active.length > 0) {
    usageRules =
      '## Glossary\n' +
      'If a glossary is provided:\n' +
      '- Always use the exact target term.\n' +
      '- Apply glossary items even inside tags or when broken by hyphens/line breaks.\n' +
      '- If glossary does NOT include a term, translate it naturally.\n\n'
    tables = ['## Glossary Tables', '', ...glossaryTables(active)].join('\n')
  }
  return substitute(BATCH_TEMPLATE, {
    role_block: roleBlock(input.customPrompt),
    glossary_usage_rules_block: usageRules,
    contextual_hints_block: contextualHints,
    json_input_str: input.jsonInput,
    glossary_tables_block: tables,
    lang_out: LANG_OUT,
  })
}

/** ILTranslator.generate_prompt_for_llm (without the formula placeholder hint, off by default). */
export function singlePrompt(input: {
  text: string
  customPrompt: string
  title: TitleSnapshot | null
  localTitle: TitleSnapshot | null
  glossaries: readonly Glossary[]
}): string {
  const context: string[] = []
  let hint = 1
  if (input.title) {
    context.push(`${hint}. First title in the full text: ${input.title.unicode}`)
    hint += 1
  }
  if (input.localTitle && (!input.title || input.localTitle.id !== input.title.id)) {
    context.push(`${hint}. The most recent title is: ${input.localTitle.unicode}`)
  }
  const contextBlock = context.length ? `## Context / Hints\n${context.join('\n')}\n` : ''

  const active = activeGlossaries(input.glossaries, input.text)
  const glossaryBlock = active.length
    ? [
        '## Glossary',
        '',
        "Always use the glossary's **Target Term** for any occurrence of its **Source Term** " +
          '(including variants, inside tags, or broken across lines).',
        '',
        'Unlisted terms are translated naturally.',
        '',
        ...glossaryTables(active),
      ].join('\n')
    : ''
  return substitute(SINGLE_TEMPLATE, {
    role_block: roleBlock(input.customPrompt),
    glossary_block: glossaryBlock,
    context_block: contextBlock,
    lang_out: LANG_OUT,
    text_to_translate: input.text,
  })
}

const TERMS_EXAMPLE = `[
  {"src": "LLM", "tgt": "大语言模型"},
  {"src": "GPT", "tgt": "GPT"}
]`

/** AutomaticTermExtractor.extract_terms_from_paragraphs: the prompt (str.format semantics). */
export function termsPrompt(
  inputs: readonly string[],
  userGlossaries: readonly Glossary[],
): string {
  let reference = ''
  if (userGlossaries.length > 0) {
    const text = inputs.join('\n\n')
    const found: Array<[string, Array<[string, string]>]> = []
    for (const glossary of userGlossaries) {
      const active = glossary.activeEntries(text)
      if (active.length === 0) continue
      const at = found.findIndex(([name]) => name === glossary.name)
      if (at >= 0) found[at] = [glossary.name, active]
      else found.push([glossary.name, active])
    }
    if (found.length > 0) {
      reference = 'Reference Glossaries (for consistency and quality):\n'
      for (const [name, entries] of found) {
        reference += `\n${name}:\n`
        const unique = new Map(entries.map((e) => [`${e[0]}\u0000${e[1]}`, e]))
        for (const [src, tgt] of sortedEntries([...unique.values()])) {
          reference += `- ${src} → ${tgt}\n`
        }
      }
      reference +=
        "\nPlease consider these existing translations for consistency when extracting new terms. IMPORTANT: You should also extract terms that appear in the reference glossaries above if they are found in the input text - don't skip them just because they already exist in the reference."
    }
  }
  const values: Record<string, string> = {
    target_language: LANG_OUT,
    text_to_process: inputs.join('\n\n'),
    reference_glossary_section: reference,
    example_output: TERMS_EXAMPLE,
  }
  // str.format: {name} fields, {{ and }} escapes.
  return TERMS_TEMPLATE.replace(/\{\{|\}\}|\{([a-z_]+)\}/g, (match, name?: string) => {
    if (match === '{{') return '{'
    if (match === '}}') return '}'
    return values[name!] ?? match
  })
}
