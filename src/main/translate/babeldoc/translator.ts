// BabelDOC 0.6.4 il_translator_llm_only.ILTranslatorLLMOnly (with ILTranslator as its
// fallback) over pdf2zh's paragraphs (ADR-0018). The model call is injected: `llm(prompt)`
// resolves with the reply after pdf2zh-next's clean-up, and rejects with the provider error.
import type { OutputComp } from '../../../shared/pdf-types'
import type { FontMapper } from '../../pdf/babeldoc/fontmap'
import type { Glossary } from './glossary'
import {
  isCidParagraph,
  isPlaceholderOnlyParagraph,
  isPureNumericParagraph,
  type BdParagraph,
} from './paragraphs'
import { getTranslateInput, parseTranslateOutput, type TranslateInput } from './placeholders'
import { batchPrompt, singlePrompt, type TitleSnapshot } from './prompts'
import {
  cleanJsonOutput,
  collapsePunctuationRuns,
  countTokens,
  levenshtein,
  pyLen,
  pyStrip,
} from './text'

export type TranslatorOptions = {
  /** translation_config.min_text_length */
  minTextLength: number
  /** translation_config.disable_rich_text_translate */
  disableRichText: boolean
  /** custom_system_prompt ('' for BabelDOC's default role) */
  customPrompt: string
  mapper: FontMapper
  glossaries: readonly Glossary[]
  /** Pool size for batches and, separately, for fallbacks (pool_max_workers). */
  concurrency: number
}

export type ParagraphResult = { id: string; text: string; comps: OutputComp[] }

export type TranslatorHooks = {
  llm(prompt: string): Promise<string>
  /** An error the document cannot survive (cancellation, credentials): rethrown at once. */
  isFatal(error: unknown): boolean
  /** Called once for the first fatal error, so the caller can stop requests in flight. */
  onFatal(error: unknown): void
  onPlanned(paragraphs: number, batches: number): void
  onParagraphDone(): void
  onFallback(paragraph: BdParagraph, reason: string): void
  onKept(paragraph: BdParagraph, error: unknown): void
}

type Batch = {
  paragraphs: BdParagraph[]
  title: TitleSnapshot | null
  localTitle: TitleSnapshot | null
  tokens: number
  seq: number
}

const BODY_LABELS = new Set(['text', 'plain text', 'paragraph_hybrid'])

function snapshot(p: BdParagraph | undefined): TitleSnapshot | null {
  return p ? { id: p.id, unicode: p.unicode } : null
}

/** Paragraphs grouped by page, in document order. */
function byPage(paragraphs: readonly BdParagraph[]): BdParagraph[][] {
  const pages: BdParagraph[][] = []
  for (const p of paragraphs) (pages[p.page] ??= []).push(p)
  // Array.from, not map: map skips the holes pages without paragraphs leave.
  return Array.from(pages, (page) => page ?? [])
}

/** ILTranslatorLLMOnly.translate: plan the batches, run them, fall back paragraph by paragraph. */
export async function translateParagraphs(
  paragraphs: readonly BdParagraph[],
  options: TranslatorOptions,
  hooks: TranslatorHooks,
): Promise<Map<string, ParagraphResult>> {
  const results = new Map<string, ParagraphResult>()
  const pages = byPage(paragraphs)
  const translated = new Set<string>()
  const batches: Batch[] = []
  let seq = 0
  const tokensOf = (p: BdParagraph) => countTokens(p.unicode)

  const first = paragraphs.find((p) => p.label === 'title')
  const title = snapshot(first)
  let recentTitle = snapshot(first)

  const shouldTranslate = (p: BdParagraph, requireBody: boolean) =>
    !translated.has(p.id) &&
    !isCidParagraph(p) &&
    pyLen(p.unicode) >= options.minTextLength &&
    (!requireBody || (p.label !== null && BODY_LABELS.has(p.label)))
  const add = (list: BdParagraph[], tokens: number) => {
    batches.push({ paragraphs: list, title, localTitle: recentTitle, tokens, seq: seq++ })
    for (const p of list) translated.add(p.id)
  }

  // process_cross_page_paragraph
  for (let i = 0; i + 1 < pages.length; i += 1) {
    const curr = pages[i]!.filter((p) => shouldTranslate(p, true))
    const next = pages[i + 1]!.filter((p) => shouldTranslate(p, true))
    if (curr.length === 0 || next.length === 0) continue
    const last = curr[curr.length - 1]!
    const head = next[0]!
    if (translated.has(last.id) || translated.has(head.id)) continue
    add([last, head], tokensOf(last) + tokensOf(head))
  }
  // process_cross_column_paragraph
  for (const page of pages) {
    const body = page.filter((p) => shouldTranslate(p, true))
    if (body.length < 2) continue
    for (let i = 0; i + 1 < body.length; i += 1) {
      const p1 = body[i]!
      const p2 = body[i + 1]!
      if (translated.has(p1.id) || translated.has(p2.id)) continue
      if (p2.top - p1.top <= 20) continue
      add([p1, p2], tokensOf(p1) + tokensOf(p2))
    }
  }
  // process_page
  for (const page of pages) {
    let list: BdParagraph[] = []
    let tokens = 0
    for (const p of page) {
      if (translated.has(p.id)) continue
      if (
        isCidParagraph(p) ||
        pyLen(p.unicode) < options.minTextLength ||
        isPureNumericParagraph(p) ||
        isPlaceholderOnlyParagraph(p)
      ) {
        continue
      }
      tokens += tokensOf(p)
      list.push(p)
      translated.add(p.id)
      if (p.label === 'title') recentTitle = snapshot(p)
      if (tokens > 200 || list.length > 5) {
        add(list, tokens)
        list = []
        tokens = 0
      }
    }
    if (list.length > 0) add(list, tokens)
  }
  hooks.onPlanned(
    batches.reduce((n, b) => n + b.paragraphs.length, 0),
    batches.length,
  )

  const primary = createPool(options.concurrency)
  const secondary = createPool(options.concurrency)
  const fallbacks: Array<Promise<void>> = []
  // The first error the document cannot survive: later tasks do nothing, and it is rethrown.
  let fatal: { error: unknown } | undefined
  const guard = (task: Promise<void>): Promise<void> =>
    task.catch((error: unknown) => {
      if (!hooks.isFatal(error)) throw error
      if (fatal) return
      fatal = { error }
      hooks.onFatal(error)
    })
  const finished = new Set<string>()
  const finish = (p: BdParagraph) => {
    if (finished.has(p.id)) return
    finished.add(p.id)
    hooks.onParagraphDone()
  }

  const preTranslate = (p: BdParagraph): TranslateInput | undefined => {
    const input = getTranslateInput(p, {
      disableRichText: options.disableRichText,
      mapper: options.mapper,
      fonts: p.unit.fonts,
    })
    if (!input) return undefined
    if (pyLen(input.unicode) < options.minTextLength) return undefined
    return input
  }
  const post = (p: BdParagraph, input: TranslateInput, text: string) => {
    results.set(p.id, { id: p.id, text, comps: parseTranslateOutput(input, text) })
  }

  // ILTranslator.translate_paragraph (use_as_fallback)
  const fallback = (p: BdParagraph, batch: Batch) => {
    fallbacks.push(
      guard(
        secondary(async () => {
          if (fatal) return
          try {
            const input = preTranslate(p)
            if (!input) return
            const prompt = singlePrompt({
              text: input.unicode,
              customPrompt: options.customPrompt,
              title: batch.title,
              localTitle: batch.localTitle,
              glossaries: options.glossaries,
            })
            const reply = await hooks.llm(prompt)
            post(p, input, collapsePunctuationRuns(reply))
          } catch (error) {
            if (hooks.isFatal(error)) throw error
            results.delete(p.id)
            hooks.onKept(p, error)
          } finally {
            finish(p)
          }
        }),
      ),
    )
  }

  // ILTranslatorLLMOnly.translate_paragraph
  const runBatch = async (batch: Batch) => {
    if (fatal) return
    const inputs: Array<{ p: BdParagraph; input: TranslateInput }> = []
    try {
      for (const p of batch.paragraphs) {
        const input = preTranslate(p)
        if (!input) {
          finish(p)
          continue
        }
        inputs.push({ p, input })
      }
      if (inputs.length === 0) return
      const json = inputs.map(({ p, input }, id) => ({
        id,
        input: input.unicode,
        layout_label: p.label,
      }))
      const prompt = batchPrompt({
        jsonInput: pyJsonDumps(json),
        customPrompt: options.customPrompt,
        title: batch.title,
        localTitle: batch.localTitle,
        glossaries: options.glossaries,
        glossaryText: json.map((item) => item.input).join('\n'),
      })
      const reply = cleanJsonOutput(pyStrip(await hooks.llm(prompt)))
      let parsed: unknown = JSON.parse(reply)
      if (isRecord(parsed) && truthy('output' in parsed ? parsed.output : parsed.input)) {
        parsed = [parsed]
      }
      if (!Array.isArray(parsed)) throw new Error('translation result is not a list')
      const outputs = new Map<number, unknown>()
      for (const item of parsed) {
        if (!isRecord(item) || !('id' in item)) throw new Error('translation item without id')
        const id = pyInt(item.id)
        outputs.set(id, 'output' in item ? item.output : item.input)
      }
      if (outputs.size !== inputs.length) {
        throw new Error(
          `Translation results length mismatch. Expected: ${inputs.length}, Got: ${outputs.size}`,
        )
      }
      for (const [id, output] of outputs) {
        const entry = inputs[id]
        // Python indexes inputs[id_] in `finally`, which raises for a bad id: the whole batch
        // then falls back.
        if (!entry) throw new Error(`Invalid id ${id}`)
        const reason = checkOutput(entry.input.unicode, output)
        if (reason === null) {
          post(entry.p, entry.input, collapsePunctuationRuns(output as string))
          finish(entry.p)
        } else {
          hooks.onFallback(entry.p, reason)
          fallback(entry.p, batch)
        }
      }
    } catch (error) {
      if (hooks.isFatal(error)) throw error
      const reason = error instanceof Error ? error.message : String(error)
      const targets = inputs.length > 0 ? inputs.map((i) => i.p) : batch.paragraphs
      for (const p of targets) {
        results.delete(p.id)
        hooks.onFallback(p, reason)
        fallback(p, batch)
      }
    }
  }

  // PriorityThreadPoolExecutor: priority 1048576 - tokens, so bigger batches start first.
  const ordered = [...batches].sort((a, b) => b.tokens - a.tokens || a.seq - b.seq)
  await Promise.all(ordered.map((batch) => guard(primary(() => runBatch(batch)))))
  // Only batches queue fallbacks, and they are all done here.
  await Promise.all(fallbacks)
  if (fatal) throw fatal.error
  return results
}

/** The per-item checks of translate_paragraph; null when the output is accepted. */
function checkOutput(inputUnicode: string, output: unknown): string | null {
  if (typeof output !== 'string') return 'Translation result is not a string.'
  const translated = collapsePunctuationRuns(output)
  const trimmedInput = collapsePunctuationRuns(inputUnicode)
  const inputTokens = countTokens(trimmedInput)
  const outputTokens = countTokens(translated)
  if (trimmedInput === translated && inputTokens > 10) {
    return 'Translation result is the same as input, fallback.'
  }
  if (inputTokens === 0) return 'division by zero'
  const ratio = outputTokens / inputTokens
  if (!(ratio > 0.3 && ratio < 3)) {
    return `Translation result is too long or too short. Input: ${inputTokens}, Output: ${outputTokens}`
  }
  const distance = levenshtein(inputUnicode, translated)
  if (distance < 5 && inputTokens > 20) {
    return `Translation result edit distance is too small. distance: ${distance}`
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Python truthiness of a JSON value. */
function truthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === '') {
    return false
  }
  if (Array.isArray(value)) return value.length > 0
  if (isRecord(value)) return Object.keys(value).length > 0
  return true
}

/** Python int() of a JSON value (int, integral float, or a decimal string). */
function pyInt(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'string' && /^\s*[-+]?\d+\s*$/.test(value)) return Number.parseInt(value, 10)
  throw new Error(`invalid literal for int(): ${JSON.stringify(value)}`)
}

/** json.dumps(obj, ensure_ascii=False, indent=2) for the batch input. */
export function pyJsonDumps(value: unknown): string {
  // Python separates items with ",\n" and keys with ": ", like JSON.stringify with indent.
  return JSON.stringify(value, null, 2)
}

/** A concurrency limiter: at most `max` tasks at a time, in submission order. */
function createPool(max: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0
  const waiting: Array<() => void> = []
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve))
    active += 1
    try {
      return await task()
    } finally {
      active -= 1
      waiting.shift()?.()
    }
  }
}
