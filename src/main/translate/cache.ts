import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { CACHE_FLUSH_EVERY, CACHE_FLUSH_MS } from '../../shared/constants'
import type { ProviderConfig, TranslationRuntime } from '../../shared/types'
import { writeJsonAtomic } from '../settings/atomic-write'

export type CacheEntry = { text: string; at: string }

type CacheFile = {
  version: 1
  fingerprint: string
  entries: Record<string, CacheEntry>
}

export function translatorId(provider: ProviderConfig, model: string): string {
  return `llm:${provider.type}:${provider.baseUrl}:${model}`
}

export function cacheFingerprint(
  provider: ProviderConfig,
  model: string,
  runtime: TranslationRuntime,
): string {
  return sha256(
    JSON.stringify({
      version: 1,
      translator: translatorId(provider, model),
      chunkChars: runtime.llm.chunkChars,
      maxSegmentsPerRequest: runtime.llm.maxSegmentsPerRequest,
      maxRequestChars: runtime.llm.maxRequestChars,
      systemPrompt: runtime.systemPrompt,
    }),
  )
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export class TranslationCache {
  #fingerprint: string
  #entries = new Map<string, CacheEntry>()
  #dirty = 0
  #timer: ReturnType<typeof setInterval> | undefined
  #path: string
  #onWarning: (message: string) => void

  constructor(
    path: string,
    fingerprint: string,
    onWarning: (message: string) => void = () => undefined,
  ) {
    this.#path = path
    this.#fingerprint = fingerprint
    this.#onWarning = onWarning
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.#path, 'utf8')) as CacheFile
      if (parsed.version !== 1 || parsed.fingerprint !== this.#fingerprint) return
      for (const [key, value] of Object.entries(parsed.entries ?? {})) {
        if (value?.text) this.#entries.set(key, value)
      }
    } catch {
      // missing or unreadable cache is a miss
    }
  }

  start(): void {
    this.#timer = setInterval(() => {
      void this.flush()
    }, CACHE_FLUSH_MS)
    this.#timer.unref?.()
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = undefined
  }

  /** pdf2zh TranslationCache.get: whatever was stored for this source text. */
  get(segmentText: string): string | undefined {
    return this.#entries.get(sha256(segmentText))?.text
  }

  set(segmentText: string, text: string): void {
    this.#entries.set(sha256(segmentText), { text, at: new Date().toISOString() })
    this.#dirty += 1
    if (this.#dirty >= CACHE_FLUSH_EVERY) void this.flush()
  }

  async flush(): Promise<void> {
    if (this.#dirty === 0) return
    const payload: CacheFile = {
      version: 1,
      fingerprint: this.#fingerprint,
      entries: Object.fromEntries(this.#entries),
    }
    try {
      await writeJsonAtomic(this.#path, payload)
      this.#dirty = 0
    } catch (error) {
      this.#onWarning(
        `翻译缓存写入失败（不影响翻译结果）：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}
