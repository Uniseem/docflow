import { join } from 'node:path'
import type { AnalysisResult, TranslatedParagraph } from '../../../shared/pdf-types'
import type { DocumentManifest, ProviderConfig } from '../../../shared/types'
import { cacheFingerprint, TranslationCache } from '../../translate/cache'
import type { TranslationPools } from '../../translate/pool'
import { translateDocument, type EventInput } from '../../translate/translate-document'

export type TranslateStageEvent = Pick<EventInput, 'level' | 'message' | 'detail'>

export async function translateStage(input: {
  analysis: AnalysisResult
  manifest: DocumentManifest
  workDir: string
  provider: ProviderConfig
  pools: TranslationPools
  signal: AbortSignal
  onProgress: (done: number, total: number) => Promise<void>
  onEvent: (event: TranslateStageEvent) => Promise<void>
}): Promise<{
  translations: TranslatedParagraph[]
  usage: { input: number; output: number }
  kept: number
  translated: number
}> {
  const translatable = input.analysis.paragraphs.filter((para) => para.translatable)
  await input.onEvent({
    level: 'info',
    message: `开始翻译：${input.manifest.translator.label}，共 ${translatable.length} 段`,
  })
  // A cache that cannot be written only costs a re-translation after a retry: log it once
  // (the flush timer would repeat it every few seconds) and keep translating.
  let cacheWarned = false
  const cache = new TranslationCache(
    join(input.workDir, 'translation-cache.json'),
    cacheFingerprint(
      input.provider,
      input.manifest.translator.model,
      input.manifest.settingsSnapshot,
    ),
    (message) => {
      if (cacheWarned) return
      cacheWarned = true
      void input.onEvent({ level: 'warning', message }).catch(() => undefined)
    },
  )
  await cache.load()
  cache.start()
  try {
    const { results, usage } = await translateDocument({
      segments: translatable.map((para) => ({ id: para.id, text: para.text })),
      provider: input.provider,
      model: input.manifest.translator.model,
      runtime: input.manifest.settingsSnapshot,
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
    })
    const byId = new Map(results.map((row) => [row.id, row]))
    const translations = input.analysis.paragraphs.map((para) => {
      if (!para.translatable) return { id: para.id, text: para.text, kept: true }
      const hit = byId.get(para.id)
      return { id: para.id, text: hit?.text ?? para.text, kept: hit?.kept ?? true }
    })
    const translated = translations.filter(
      (row) => paraTranslatable(input.analysis, row.id) && !row.kept,
    ).length
    const kept = translations.filter(
      (row) => paraTranslatable(input.analysis, row.id) && row.kept,
    ).length
    return {
      translations,
      usage,
      kept,
      translated,
    }
  } finally {
    cache.stop()
    await cache.flush()
  }
}

function paraTranslatable(analysis: AnalysisResult, id: string): boolean {
  return Boolean(analysis.paragraphs.find((para) => para.id === id)?.translatable)
}
