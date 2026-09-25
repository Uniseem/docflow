// PDFMathTranslate 1.9.11 `pdf2zh/translator.py`: BaseTranslator.prompt and the reply clean-up
// of OpenAITranslator.do_translate.
import { DEFAULT_SYSTEM_PROMPT, LEGACY_SYSTEM_PROMPT } from '../../shared/constants'

/** pdf2zh lang_in / lang_out defaults ("en" → "zh"). */
export const LANG_IN = 'en'
export const LANG_OUT = 'zh'

/** BaseTranslator.prompt's default message; see DEFAULT_SYSTEM_PROMPT. */
export const PDF2ZH_PROMPT_TEMPLATE = DEFAULT_SYSTEM_PROMPT

/** Python string.Template.safe_substitute: $name, ${name}, $$; unknown names stay as they are. */
export function safeSubstitute(template: string, values: Record<string, string>): string {
  return template.replace(
    /\$(?:(\$)|([_a-zA-Z][_a-zA-Z0-9]*)|\{([_a-zA-Z][_a-zA-Z0-9]*)\})/g,
    (match, escaped: string | undefined, named?: string, braced?: string) => {
      if (escaped) return '$'
      const key = named ?? braced ?? ''
      return Object.hasOwn(values, key) ? values[key]! : match
    },
  )
}

/** The single user message pdf2zh sends for one paragraph. */
export function pdf2zhPrompt(text: string, template = PDF2ZH_PROMPT_TEMPLATE): string {
  // Documents queued by 4.0.0 carry its batch system prompt in their settings snapshot.
  const effective =
    !template || template === LEGACY_SYSTEM_PROMPT ? PDF2ZH_PROMPT_TEMPLATE : template
  return safeSubstitute(effective, {
    lang_in: LANG_IN,
    lang_out: LANG_OUT,
    text,
  })
}

// think_filter_regex = r"^<think>.+?\n*(</think>|\n)*(</think>)\n*" with re.DOTALL
const THINK_FILTER = /^<think>[\s\S]+?\n*(<\/think>|\n)*(<\/think>)\n*/

/** `content.strip()`, drop a leading <think> block, `.strip()` again. */
export function cleanReply(content: string): string {
  return pyStrip(pyStrip(content).replace(THINK_FILTER, ''))
}

/** Python str.isspace() for one character (\s plus U+001C–U+001F and U+0085, minus U+FEFF). */
function isPySpace(ch: string): boolean {
  const code = ch.charCodeAt(0)
  if (code === 0xfeff) return false
  return /\s/.test(ch) || (code >= 0x1c && code <= 0x1f) || code === 0x85
}

/** Python str.strip() */
function pyStrip(text: string): string {
  let start = 0
  let end = text.length
  while (start < end && isPySpace(text[start]!)) start += 1
  while (end > start && isPySpace(text[end - 1]!)) end -= 1
  return text.slice(start, end)
}
