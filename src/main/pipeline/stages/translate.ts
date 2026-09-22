import { join } from 'node:path'
import type { AnalysisResult, TranslatedParagraph } from '../../../shared/pdf-types'
import type { DocumentManifest, ProviderConfig } from '../../../shared/types'
import { cacheFingerprint, TranslationCache } from '../../translate/cache'
import type { TranslationPools } from '../../translate/pool'
import { translateDocument } from '../../translate/translate-document'

export async function translateStage(input: {
  analysis: AnalysisResult
  manifest: DocumentManifest
  workDir: string
  provider: ProviderConfig
  pools: TranslationPools
  signal: AbortSignal
  onProgress: (done: number, total: number) => Promise<void>
  onEvent: (message: string) => Promise<void>
}): Promise<{
  translations: TranslatedParagraph[]
  usage: { input: number; output: number }
  kept: number
  translated: number
}> {
  const translatable = input.analysis.paragraphs.filter((para) => para.translatable)
  await input.onEvent(`开始翻译：${input.manifest.translator.label}，共 ${translatable.length} 段`)
  const cache = new TranslationCache(
    join(input.workDir, 'translation-cache.json'),
    cacheFingerprint(
      input.provider,
      input.manifest.translator.model,
      input.manifest.settingsSnapshot,
    ),
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
        if (event.message.startsWith('已翻译')) return
        void input.onEvent(event.message)
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
