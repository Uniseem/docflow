import { REJECTED_STREAK_LIMIT, RETRY_NOTICES, SUBMIT_ATTEMPTS } from '../../shared/constants'
import { ERROR_CODES, UserError } from '../../shared/errors'
import type { ProviderConfig, TranslationRuntime } from '../../shared/types'
import type { TranslationCache } from './cache'
import { ProviderError, RetriesExhaustedError } from './errors'
import { cleanReply, pdf2zhPrompt } from './pdf2zh-prompt'
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

export type Segment = { id: string; text: string }

export type TranslatedParagraph = { id: string; text: string; kept: boolean }

export type TranslateHooks = {
  /** Retry wait; resolves early (or never) when `signal` aborts — the caller races it. */
  delay?: (ms: number, signal?: AbortSignal) => Promise<void>
  jitterMs?: () => number
}

export function createLimit(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0
  const waiting: Array<() => void> = []
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= max) {
      await new Promise<void>((resolve) => {
        waiting.push(resolve)
      })
    }
    active += 1
    try {
      return await fn()
    } finally {
      active -= 1
      waiting.shift()?.()
    }
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new UserError(ERROR_CODES.cancelled)
}

/**
 * Errors that end the document instead of keeping one paragraph's original text:
 * cancellation and the rejected streak (`UserError`), a bad key or model, and a provider that
 * stayed unavailable through every `submit()` attempt.
 */
function endsDocument(error: unknown): boolean {
  if (error instanceof UserError || error instanceof RetriesExhaustedError) return true
  return error instanceof ProviderError && (error.kind === 'fatal' || error.kind === 'credential')
}

function charCount(text: string): number {
  return [...text].length
}

/**
 * pdf2zh converter part "B. 段落翻译": every paragraph string goes to the translator on its
 * own, with pdf2zh's prompt as the only (user) message; the reply is used as it is.
 */
export async function translateDocument(input: {
  segments: Segment[]
  provider: ProviderConfig
  model: string
  runtime: TranslationRuntime
  pools: TranslationPools
  cache: TranslationCache
  signal: AbortSignal
  onProgress(done: number, total: number): void
  onEvent(event: EventInput): void
  hooks?: TranslateHooks
}): Promise<{
  results: TranslatedParagraph[]
  keptChars: number
  totalChars: number
  usage: { input: number; output: number }
}> {
  const total = input.segments.length
  const totalChars = input.segments.reduce((sum, segment) => sum + charCount(segment.text), 0)
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
  const limit = createLimit(input.runtime.perDocumentConcurrency)
  const results = new Map<string, TranslatedParagraph>()
  let done = 0
  let cacheHits = 0
  let failure: { error: unknown } | undefined

  await Promise.all(
    input.segments.map((segment, index) =>
      limit(async () => {
        throwIfAborted(ctx.signal)
        const hit = ctx.cache.get(segment.text)
        let result: TranslatedParagraph
        if (hit !== undefined) {
          cacheHits += 1
          result = { id: segment.id, text: hit, kept: false }
        } else {
          result = await translateSegment(segment, index + 1, ctx)
        }
        results.set(segment.id, result)
        done += 1
        input.onProgress(done, total)
        input.onEvent({
          stage: 'translate',
          level: 'info',
          message: `已翻译 ${done} / ${total} 段`,
          current: done,
          total,
        })
      }).catch((error: unknown) => {
        failure ??= { error }
        stop.abort()
        throw error
      }),
    ),
  ).catch(() => {
    // Requests stopped by `stop` reject with a cancellation: report the error that ended the
    // document.
    throw failure?.error
  })
  if (cacheHits > 0) {
    input.onEvent({ stage: 'translate', level: 'info', message: `缓存命中 ${cacheHits} 段` })
  }

  const ordered = input.segments.map(
    (segment) => results.get(segment.id) ?? { id: segment.id, text: segment.text, kept: true },
  )
  const keptChars = ordered.reduce(
    (sum, result, index) => sum + (result.kept ? charCount(input.segments[index]?.text ?? '') : 0),
    0,
  )
  if (keptChars > 400 && keptChars * 5 > totalChars) {
    throw new UserError(ERROR_CODES.mostly_untranslated)
  }
  return { results: ordered, keptChars, totalChars, usage }
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

async function translateSegment(
  segment: Segment,
  n: number,
  ctx: TranslateContext,
): Promise<TranslatedParagraph> {
  try {
    const reply = await submit(
      {
        model: ctx.model,
        system: '',
        user: pdf2zhPrompt(segment.text, ctx.runtime.systemPrompt),
        ...(ctx.runtime.llm.maxOutputTokens > 0
          ? { maxTokens: ctx.runtime.llm.maxOutputTokens }
          : {}),
      },
      ctx,
    )
    // A content-filter stop leaves no message content (pdf2zh's `.strip()` would raise).
    if (reply.finish === 'refused') throw new ProviderError('refused', '服务商拒绝翻译这一段')
    const text = cleanReply(reply.text)
    ctx.cache.set(segment.text, text)
    return { id: segment.id, text, kept: false }
  } catch (error) {
    if (endsDocument(error)) throw error
    const message = error instanceof Error ? error.message : String(error)
    ctx.onEvent({
      stage: 'translate',
      level: 'warning',
      message: `第 ${n} 段翻译失败，已保留原文`,
      detail: message,
    })
    return { id: segment.id, text: segment.text, kept: true }
  }
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
