import { REJECTED_STREAK_LIMIT, RETRY_NOTICES, SUBMIT_ATTEMPTS } from '../../shared/constants'
import { ERROR_CODES, UserError } from '../../shared/errors'
import type { AnalysisResult, TranslatedParagraph } from '../../shared/pdf-types'
import type { ProviderConfig, TranslationRuntime } from '../../shared/types'
import { FontMapper, type PrimaryFontFamily } from '../pdf/babeldoc/fontmap'
import type { Glossary } from './babeldoc/glossary'
import { buildParagraphs } from './babeldoc/paragraphs'
import { extractTerms, glossariesForTranslation } from './babeldoc/terms'
import { cleanLlmReply, pyLen } from './babeldoc/text'
import { translateParagraphs } from './babeldoc/translator'
import type { TranslationCache } from './cache'
import { ProviderError, RetriesExhaustedError } from './errors'
import type { TranslationPools } from './pool'

export type EventInput = {
  stage: 'translate'
  level: 'info' | 'success' | 'warning' | 'error'
  message: string
  detail?: string
  progress?: number
  current?: number
  total?: number
}

export type TranslateHooks = {
  /** Retry wait; resolves early (or never) when `signal` aborts — the caller races it. */
  delay?: (ms: number, signal?: AbortSignal) => Promise<void>
  jitterMs?: () => number
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new UserError(ERROR_CODES.cancelled)
}

/**
 * Errors that end the document instead of keeping one paragraph's original text:
 * cancellation and the rejected streak (`UserError`), a bad key or model, and a provider that
 * stayed unavailable through every `submit()` attempt.
 */
export function endsDocument(error: unknown): boolean {
  if (error instanceof UserError || error instanceof RetriesExhaustedError) return true
  return error instanceof ProviderError && (error.kind === 'fatal' || error.kind === 'credential')
}

export type TranslateOptions = {
  minTextLength: number
  disableRichText: boolean
  fontFamily: PrimaryFontFamily
  /** User glossaries of the document (loaded from their CSV files). */
  userGlossaries: readonly Glossary[]
  autoExtractGlossary: boolean
  /** The glossary extracted by an earlier run of this document; undefined to extract it. */
  savedAutoGlossary?: Glossary | null
}

export type TranslateOutcome = {
  results: TranslatedParagraph[]
  keptChars: number
  totalChars: number
  usage: { input: number; output: number }
  autoGlossary: Glossary | null
}

/**
 * BabelDOC's translation stages over the analysed document (ADR-0018): automatic term
 * extraction, then ILTranslatorLLMOnly (batched JSON requests with per-paragraph fallback).
 * Requests go through DocFlow's pools, retries and cache (keyed by the whole prompt).
 */
export async function translateDocument(input: {
  analysis: AnalysisResult
  provider: ProviderConfig
  model: string
  runtime: TranslationRuntime
  options: TranslateOptions
  pools: TranslationPools
  cache: TranslationCache
  signal: AbortSignal
  onProgress(done: number, total: number): void
  onEvent(event: EventInput): void
  /** Called once the automatic glossary is known, before translation starts (checkpoint). */
  onAutoGlossary?(glossary: Glossary | null): Promise<void>
  hooks?: TranslateHooks
}): Promise<TranslateOutcome> {
  const usage = { input: 0, output: 0 }
  // The first error that ends the document also stops the requests still running.
  const stop = new AbortController()
  const ctx: TranslateContext = {
    ...input,
    signal: AbortSignal.any([input.signal, stop.signal]),
    usage,
    rejected: 0,
    notices: 0,
    delay: input.hooks?.delay ?? defaultDelay,
    jitterMs: input.hooks?.jitterMs ?? defaultJitter,
  }
  let cacheHits = 0
  const llm = async (prompt: string): Promise<string> => {
    throwIfAborted(ctx.signal)
    const hit = ctx.cache.get(prompt)
    if (hit !== undefined) {
      cacheHits += 1
      return hit
    }
    const maxTokens = ctx.runtime.llm.maxOutputTokens
    const reply = await submit(
      { model: ctx.model, system: '', user: prompt, ...(maxTokens > 0 ? { maxTokens } : {}) },
      ctx,
    )
    // A content-filter stop leaves no message content.
    if (reply.finish === 'refused') throw new ProviderError('refused', '服务商拒绝翻译这一段')
    const text = cleanLlmReply(reply.text)
    ctx.cache.set(prompt, text)
    return text
  }
  const onFatal = () => stop.abort()
  const paragraphs = buildParagraphs(input.analysis)
  const concurrency = input.runtime.perDocumentConcurrency

  // AutomaticTermExtractor
  let autoGlossary: Glossary | null = null
  if (input.options.autoExtractGlossary) {
    if (input.options.savedAutoGlossary !== undefined) {
      autoGlossary = input.options.savedAutoGlossary
    } else {
      input.onEvent({ stage: 'translate', level: 'info', message: '抽取术语…' })
      let failures = 0
      let done = 0
      const total = paragraphs.length
      const extracted = await extractTerms(paragraphs, input.options.userGlossaries, concurrency, {
        llm,
        isFatal: endsDocument,
        onFatal,
        onBatchDone: (n) => {
          done += n
          input.onProgress(Math.min(done, total), total * 2)
        },
        onError: () => {
          failures += 1
        },
      }).catch((error: unknown) => {
        stop.abort()
        throw error
      })
      autoGlossary = extracted.glossary
      input.onEvent({
        stage: 'translate',
        level: 'info',
        message: autoGlossary
          ? `抽取术语：${autoGlossary.entries.length} 条`
          : '抽取术语：没有得到术语',
        ...(failures > 0 ? { detail: `${failures} 批术语抽取失败，不影响翻译` } : {}),
      })
    }
    await input.onAutoGlossary?.(autoGlossary)
  }
  const glossaries = glossariesForTranslation(
    input.options.userGlossaries,
    autoGlossary,
    input.options.autoExtractGlossary,
  )

  // ILTranslatorLLMOnly
  let planned = 0
  let done = 0
  let fallbacks = 0
  const kept = new Set<string>()
  // With term extraction, the first half of the stage's progress was the extraction.
  const offset = input.options.autoExtractGlossary ? 1 : 0
  const results = await translateParagraphs(
    paragraphs,
    {
      minTextLength: input.options.minTextLength,
      disableRichText: input.options.disableRichText,
      customPrompt: input.runtime.systemPrompt,
      mapper: new FontMapper(input.options.fontFamily, () => true),
      glossaries,
      concurrency,
    },
    {
      llm,
      isFatal: endsDocument,
      onFatal,
      onPlanned: (count, batches) => {
        planned = count
        input.onEvent({
          stage: 'translate',
          level: 'info',
          message: `开始翻译：${count} 段，合并为 ${batches} 个请求`,
        })
      },
      onParagraphDone: () => {
        done += 1
        input.onProgress(offset * planned + done, (offset + 1) * planned)
        input.onEvent({
          stage: 'translate',
          level: 'info',
          message: `已翻译 ${done} / ${planned} 段`,
          current: done,
          total: planned,
        })
      },
      onFallback: () => {
        fallbacks += 1
      },
      onKept: (p, error) => {
        kept.add(p.id)
        input.onEvent({
          stage: 'translate',
          level: 'warning',
          message: `第 ${p.page + 1} 页有一段翻译失败，已保留原文`,
          detail: error instanceof Error ? error.message : String(error),
        })
      },
    },
  ).catch((error: unknown) => {
    stop.abort()
    throw error
  })
  if (cacheHits > 0) {
    input.onEvent({ stage: 'translate', level: 'info', message: `缓存命中 ${cacheHits} 个请求` })
  }
  if (fallbacks > 0) {
    input.onEvent({
      stage: 'translate',
      level: 'info',
      message: `${fallbacks} 段的批量译文未通过检查，已逐段重译`,
    })
  }

  const byId = new Map(paragraphs.map((p) => [p.id, p]))
  const rows: TranslatedParagraph[] = []
  let totalChars = 0
  let keptChars = 0
  for (const result of results.values()) {
    rows.push({ id: result.id, text: result.text, kept: false, comps: result.comps })
    totalChars += pyLen(byId.get(result.id)?.unicode ?? '')
  }
  for (const id of kept) {
    const p = byId.get(id)
    if (!p || results.has(id)) continue
    rows.push({ id, text: p.unicode, kept: true })
    const chars = pyLen(p.unicode)
    totalChars += chars
    keptChars += chars
  }
  if (keptChars > 400 && keptChars * 5 > totalChars) {
    throw new UserError(ERROR_CODES.mostly_untranslated)
  }
  return { results: rows, keptChars, totalChars, usage, autoGlossary }
}

type TranslateContext = {
  provider: ProviderConfig
  model: string
  runtime: TranslationRuntime
  pools: TranslationPools
  cache: TranslationCache
  signal: AbortSignal
  onEvent(event: EventInput): void
  usage: { input: number; output: number }
  rejected: number
  notices: number
  delay: (ms: number, signal?: AbortSignal) => Promise<void>
  jitterMs: () => number
}

async function submit(
  request: { model: string; system: string; user: string; maxTokens?: number },
  ctx: TranslateContext,
): Promise<{ text: string; finish: 'complete' | 'truncated' | 'refused' }> {
  let lastError: ProviderError | undefined
  for (let attempt = 1; attempt <= SUBMIT_ATTEMPTS; attempt += 1) {
    throwIfAborted(ctx.signal)
    try {
      // Looked up per attempt: a key or provider change invalidates the pool mid-document.
      const reply = await ctx.pools.execute(ctx.provider, request, ctx.signal)
      if (reply.usage) {
        ctx.usage.input += reply.usage.input
        ctx.usage.output += reply.usage.output
      }
      ctx.rejected = 0
      return reply
    } catch (error) {
      if (error instanceof UserError) throw error
      const providerError =
        error instanceof ProviderError ? error : new ProviderError('transient', String(error))
      lastError = providerError
      if (providerError.kind === 'fatal' || providerError.kind === 'credential') throw providerError
      if (providerError.kind === 'rejected') {
        ctx.rejected += 1
        if (ctx.rejected >= REJECTED_STREAK_LIMIT) {
          throw new UserError(ERROR_CODES.internal, '翻译服务连续拒绝了 6 个请求，已停止处理', true)
        }
        throw providerError
      }
      // oversized / refused: the same request will not succeed on a resend.
      if (!providerError.retryable) throw providerError
      if (attempt === SUBMIT_ATTEMPTS) break
      const backoff = Math.min(2 ** (attempt - 1), 32) * 1000
      const wait = Math.max(providerError.retryAfterMs ?? backoff, backoff / 2) + ctx.jitterMs()
      ctx.notices += 1
      if (ctx.notices <= RETRY_NOTICES || attempt >= 3) {
        ctx.onEvent({
          stage: 'translate',
          level: 'warning',
          message: `翻译请求失败（${providerError.message}），${Math.ceil(wait / 1000)} 秒后重试`,
          ...(providerError.snippet ? { detail: providerError.snippet } : {}),
        })
      }
      await abortable(ctx.delay(wait, ctx.signal), ctx.signal)
    }
  }
  throw new RetriesExhaustedError(lastError)
}

/** Settles with `promise`, or rejects with a cancellation as soon as `signal` aborts. */
function abortable(promise: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new UserError(ERROR_CODES.cancelled))
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(new UserError(ERROR_CODES.cancelled))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      () => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

async function defaultDelay(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}

function defaultJitter(): number {
  return Math.floor(Math.random() * 2041)
}
