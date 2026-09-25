import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AnalysisResult, TranslatedParagraph } from '../../../shared/pdf-types'
import type {
  DocumentManifest,
  GlossaryInfo,
  PdfSettings,
  ProviderConfig,
} from '../../../shared/types'
import { writeFileAtomic, writeJsonAtomic } from '../../settings/atomic-write'
import { isStalePrompt } from '../../settings/settings'
import { Glossary, glossaryFromCsv, type GlossaryEntry } from '../../translate/babeldoc/glossary'
import { LANG_OUT } from '../../translate/babeldoc/prompts'
import { cacheFingerprint, TranslationCache } from '../../translate/cache'
import type { TranslationPools } from '../../translate/pool'
import { translateDocument, type EventInput } from '../../translate/translate-document'

export type TranslateStageEvent = Pick<EventInput, 'level' | 'message' | 'detail'>

/** The automatic glossary of a document: work/glossary.csv, moved to output/ when done. */
export const GLOSSARY_FILE = 'glossary.csv'
const AUTO_GLOSSARY_CHECKPOINT = 'auto-glossary.json'

export function glossaryPath(libraryDir: string, id: string): string {
  return join(libraryDir, 'glossaries', `${id}.csv`)
}

/** The user glossaries a document was added with; missing files are skipped. */
export async function loadUserGlossaries(
  libraryDir: string,
  ids: readonly string[],
  known: readonly GlossaryInfo[],
): Promise<Glossary[]> {
  const out: Glossary[] = []
  for (const id of ids) {
    const info = known.find((item) => item.id === id)
    try {
      const bytes = await readFile(glossaryPath(libraryDir, id))
      out.push(glossaryFromCsv(info?.name ?? id, bytes, LANG_OUT))
    } catch {
      // Deleted after the document was added: translate without it.
    }
  }
  return out
}

async function readAutoGlossary(
  workDir: string,
  fingerprint: string,
): Promise<Glossary | null | undefined> {
  try {
    const raw = JSON.parse(await readFile(join(workDir, AUTO_GLOSSARY_CHECKPOINT), 'utf8')) as {
      fingerprint?: string
      name?: string
      entries?: GlossaryEntry[] | null
    }
    if (raw.fingerprint !== fingerprint) return undefined
    if (!raw.entries || !raw.name) return null
    return new Glossary(raw.name, raw.entries)
  } catch {
    return undefined
  }
}

export async function translateStage(input: {
  analysis: AnalysisResult
  manifest: DocumentManifest
  workDir: string
  libraryDir: string
  provider: ProviderConfig
  pools: TranslationPools
  pdf: PdfSettings
  glossaries: readonly GlossaryInfo[]
  signal: AbortSignal
  onProgress: (done: number, total: number) => Promise<void>
  onEvent: (event: TranslateStageEvent) => Promise<void>
}): Promise<{
  translations: TranslatedParagraph[]
  usage: { input: number; output: number }
  kept: number
  translated: number
  glossaryEntries: number | null
}> {
  const runtime = input.manifest.settingsSnapshot
  // Documents queued by 4.0.x carry pdf2zh's prompt template in their snapshot.
  const effective = isStalePrompt(runtime.systemPrompt) ? { ...runtime, systemPrompt: '' } : runtime
  const fingerprint = cacheFingerprint(input.provider, input.manifest.translator.model, effective)
  // A cache that cannot be written only costs a re-translation after a retry: log it once
  // (the flush timer would repeat it every few seconds) and keep translating.
  let cacheWarned = false
  const cache = new TranslationCache(
    join(input.workDir, 'translation-cache.json'),
    fingerprint,
    (message) => {
      if (cacheWarned) return
      cacheWarned = true
      void input.onEvent({ level: 'warning', message }).catch(() => undefined)
    },
  )
  await cache.load()
  cache.start()
  const userGlossaries = await loadUserGlossaries(
    input.libraryDir,
    input.manifest.options?.glossaryIds ?? [],
    input.glossaries,
  )
  const saved = runtime.autoExtractGlossary
    ? await readAutoGlossary(input.workDir, fingerprint)
    : undefined
  try {
    const outcome = await translateDocument({
      analysis: input.analysis,
      provider: input.provider,
      model: input.manifest.translator.model,
      runtime: effective,
      options: {
        minTextLength: runtime.minTextLength,
        disableRichText: !runtime.richText || input.analysis.ocrWorkaround,
        fontFamily: input.pdf.fontFamily,
        userGlossaries,
        autoExtractGlossary: runtime.autoExtractGlossary,
        ...(saved !== undefined ? { savedAutoGlossary: saved } : {}),
      },
      pools: input.pools,
      cache,
      signal: input.signal,
      onProgress: (done, total) => {
        void input.onProgress(done, total)
      },
      onEvent: (event) => {
        // Progress rows come from onProgress (with the manifest update).
        if (event.current !== undefined) return
        void input.onEvent({
          level: event.level,
          message: event.message,
          ...(event.detail ? { detail: event.detail } : {}),
        })
      },
      onAutoGlossary: async (glossary) => {
        await writeJsonAtomic(join(input.workDir, AUTO_GLOSSARY_CHECKPOINT), {
          fingerprint,
          name: glossary?.name ?? null,
          entries: glossary?.entries ?? null,
        })
      },
    })
    let glossaryEntries: number | null = null
    if (outcome.autoGlossary) {
      // save_auto_extracted_glossary: written with a BOM (encoding="utf-8-sig").
      const csv = `\ufeff${outcome.autoGlossary.toCsv()}`
      await writeFileAtomic(join(input.workDir, GLOSSARY_FILE), Buffer.from(csv, 'utf8'))
      glossaryEntries = outcome.autoGlossary.entries.length
    }
    return {
      translations: outcome.results,
      usage: outcome.usage,
      kept: outcome.results.filter((row) => row.kept).length,
      translated: outcome.results.filter((row) => !row.kept).length,
      glossaryEntries,
    }
  } finally {
    cache.stop()
    await cache.flush()
  }
}
