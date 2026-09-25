// BabelDOC 0.6.4 midend/automatic_term_extractor.py: before translation, the model lists the
// key terms of each batch of paragraphs with their translations; the most frequent translation
// of every term becomes the automatic glossary (SharedContextCrossSplitPart).
import { Glossary, type GlossaryEntry } from './glossary'
import {
  isCidParagraph,
  isPlaceholderOnlyParagraph,
  isPureNumericParagraph,
  type BdParagraph,
} from './paragraphs'
import { termsPrompt } from './prompts'
import { cleanJsonOutput, countTokens } from './text'

export type TermHooks = {
  llm(prompt: string): Promise<string>
  isFatal(error: unknown): boolean
  onFatal(error: unknown): void
  onBatchDone(paragraphs: number): void
  onError(error: unknown): void
}

/** SharedContextCrossSplitPart._generate_unique_auto_glossary_name */
export function autoGlossaryName(userGlossaries: readonly Glossary[]): string {
  const base = 'auto_extracted_glossary'
  const names = new Set(userGlossaries.map((g) => g.name))
  let name = base
  for (let suffix = 1; names.has(name); suffix += 1) name = `${base}#${suffix}`
  return name
}

/** AutomaticTermExtractor.procress; resolves with the automatic glossary, or null. */
export async function extractTerms(
  paragraphs: readonly BdParagraph[],
  userGlossaries: readonly Glossary[],
  concurrency: number,
  hooks: TermHooks,
): Promise<{ glossary: Glossary | null; pairs: Array<[string, string]> }> {
  const batches: Array<{ paragraphs: BdParagraph[]; tokens: number; seq: number }> = []
  const pages: BdParagraph[][] = []
  for (const p of paragraphs) (pages[p.page] ??= []).push(p)
  let seq = 0
  for (const page of pages) {
    if (!page) continue
    let list: BdParagraph[] = []
    let tokens = 0
    for (const p of page) {
      // An empty paragraph still joins the batch (unicode is "" rather than None); it is only
      // left out of the prompt's inputs.
      if (isCidParagraph(p) || isPureNumericParagraph(p) || isPlaceholderOnlyParagraph(p)) {
        hooks.onBatchDone(1)
        continue
      }
      tokens += countTokens(p.unicode)
      list.push(p)
      if (tokens > 600 || list.length > 12) {
        batches.push({ paragraphs: list, tokens, seq: seq++ })
        list = []
        tokens = 0
      }
    }
    if (list.length > 0) batches.push({ paragraphs: list, tokens, seq: seq++ })
  }

  const pairs: Array<[string, string]> = []
  let fatal: { error: unknown } | undefined
  const run = async (batch: (typeof batches)[number]) => {
    if (fatal) return
    try {
      const inputs = batch.paragraphs.map((p) => p.unicode).filter(Boolean)
      if (inputs.length === 0) return
      const output = await hooks.llm(termsPrompt(inputs, userGlossaries))
      let response: unknown = JSON.parse(cleanJsonOutput(output))
      if (!Array.isArray(response)) response = [response]
      for (const term of response as unknown[]) {
        if (typeof term !== 'object' || term === null || Array.isArray(term)) continue
        const rec = term as Record<string, unknown>
        if (!('src' in rec) || !('tgt' in rec)) continue
        const src = pyStr(rec.src).trim()
        const tgt = pyStr(rec.tgt).trim()
        if (src === tgt && [...src].length < 3) continue
        if (src && tgt && [...src].length < 100) pairs.push([src, tgt])
      }
    } catch (error) {
      if (hooks.isFatal(error)) {
        fatal ??= { error }
        hooks.onFatal(error)
        return
      }
      hooks.onError(error)
    } finally {
      hooks.onBatchDone(batch.paragraphs.length)
    }
  }

  const ordered = [...batches].sort((a, b) => b.tokens - a.tokens || a.seq - b.seq)
  let next = 0
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, ordered.length)) },
    async () => {
      while (next < ordered.length) {
        const batch = ordered[next]!
        next += 1
        await run(batch)
      }
    },
  )
  await Promise.all(workers)
  if (fatal) throw fatal.error
  return { glossary: finalizeGlossary(pairs, autoGlossaryName(userGlossaries)), pairs }
}

/** SharedContextCrossSplitPart.finalize_auto_extracted_glossary */
export function finalizeGlossary(
  pairs: ReadonlyArray<[string, string]>,
  name: string,
): Glossary | null {
  if (pairs.length === 0) return null
  const bySource = new Map<string, string[]>()
  for (const [src, tgt] of pairs) {
    const list = bySource.get(src)
    if (list) list.push(tgt)
    else bySource.set(src, [tgt])
  }
  const entries: GlossaryEntry[] = []
  for (const [src, targets] of bySource) {
    // Counter(tgts).most_common(1): the most frequent, the first seen on a tie.
    const counts = new Map<string, number>()
    for (const t of targets) counts.set(t, (counts.get(t) ?? 0) + 1)
    let best = targets[0]!
    let bestCount = 0
    for (const [t, n] of counts) {
      if (n > bestCount) {
        best = t
        bestCount = n
      }
    }
    entries.push({ source: src, target: best })
  }
  return entries.length > 0 ? new Glossary(name, entries) : null
}

/** SharedContextCrossSplitPart.get_glossaries_for_translation */
export function glossariesForTranslation(
  user: readonly Glossary[],
  auto: Glossary | null,
  autoExtract: boolean,
): Glossary[] {
  if (autoExtract && auto) return [auto]
  return auto ? [...user, auto] : [...user]
}

/** Python str() of a JSON value. */
function pyStr(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null) return 'None'
  if (value === true) return 'True'
  if (value === false) return 'False'
  if (typeof value === 'number') return String(value)
  return JSON.stringify(value)
}
