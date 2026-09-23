import {
  ISOLATED_FRAGMENT_CHARS,
  MIN_FRAGMENT_CHARS,
  REJECTED_STREAK_LIMIT,
  REPAIR_PARALLELISM,
  RETRY_NOTICES,
  SPLIT_MIN_CHARS,
  SUBMIT_ATTEMPTS,
} from '../../shared/constants'
import { ERROR_CODES, UserError } from '../../shared/errors'
import type { ProviderConfig, TranslationRuntime } from '../../shared/types'
import {
  buildSystemPrompt,
  buildUserMessage,
  charCount,
  parseBatch,
  planBatches,
  smartSplit,
  type MarkerMode,
  type Segment,
} from './batch'
import type { TranslationCache } from './cache'
import { ProviderError, RetriesExhaustedError } from './errors'
import { protectTexts } from './protect'
import type { TranslationPools } from './pool'
import { checkReply, type ReplyCheck } from './validate'

export type EventInput = {
  stage: 'translate'
  level: 'info' | 'success' | 'warning' | 'error'
  message: string
  detail?: string
  progress?: number
  current?: number
  total?: number
}

export type TranslatedParagraph = { id: string; text: string; kept: boolean }

export type TranslateHooks = {
  /** Retry wait; resolves early (or never) when `signal` aborts — the caller races it. */
  delay?: (ms: number, signal?: AbortSignal) => Promise<void>
  jitterMs?: () => number
}

const HAS_LETTER = /\p{L}/u

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
 * Errors the retry ladder must pass up instead of keeping the original text: cancellation and
 * the rejected streak (`UserError`), a bad key or model, and a provider that stayed
 * unavailable through every `submit()` attempt.
 */
function endsDocument(error: unknown): boolean {
  if (error instanceof UserError || error instanceof RetriesExhaustedError) return true
  return error instanceof ProviderError && (error.kind === 'fatal' || error.kind === 'credential')
}

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
  const indexOf = new Map(input.segments.map((segment, index) => [segment.id, index + 1]))
  // The first error that ends the document also stops the batches still running.
  const stop = new AbortController()
  const ctx: TranslateContext = {
    ...input,
    signal: AbortSignal.any([input.signal, stop.signal]),
    usage,
    rejected: 0,
    notices: 0,
    indexOf,
    delay: input.hooks?.delay ?? defaultDelay,
    jitterMs: input.hooks?.jitterMs ?? defaultJitter,
  }
  const batches = planBatches(input.segments, input.runtime)
  const translated = new Map<string, TranslatedParagraph>()
  const limit = createLimit(input.runtime.perDocumentConcurrency)
  let done = 0
  let failure: { error: unknown } | undefined

  await Promise.all(
    batches.map((batch) =>
      limit(async () => {
        throwIfAborted(ctx.signal)
        const results = await translateBatch(batch, ctx)
        for (const result of results) {
          translated.set(result.id, result)
          done += 1
          input.onProgress(done, total)
          input.onEvent({
            stage: 'translate',
            level: 'info',
            message: `已翻译 ${done} / ${total} 段`,
            current: done,
            total,
          })
        }
      }).catch((error: unknown) => {
        failure ??= { error }
        stop.abort()
        throw error
      }),
    ),
  ).catch(() => {
    // The batches stopped by `stop` reject with a cancellation: report the error that ended
    // the document.
    throw failure?.error
  })

  const results: TranslatedParagraph[] = input.segments.map((segment) => {
    const parts = [...translated.entries()]
      .filter(([id]) => id === segment.id || id.startsWith(`${segment.id}#`))
      .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    if (parts.length === 0) return { id: segment.id, text: segment.text, kept: true }
    return {
      id: segment.id,
      text: parts.map(([, value]) => value.text).join(''),
      kept: parts.every(([, value]) => value.kept),
    }
  })
  const keptChars = results.reduce(
    (sum, result, index) => sum + (result.kept ? charCount(input.segments[index]?.text ?? '') : 0),
    0,
  )
  if (keptChars > 400 && keptChars * 5 > totalChars) {
    throw new UserError(ERROR_CODES.mostly_untranslated)
  }
  return { results, keptChars, totalChars, usage }
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
  indexOf: Map<string, number>
  delay: (ms: number, signal?: AbortSignal) => Promise<void>
  jitterMs: () => number
}

async function translateBatch(
  batch: Segment[],
  ctx: TranslateContext,
): Promise<TranslatedParagraph[]> {
  if (batch.length === 1 && batch[0] && batch[0].text.trim() === '') {
    return [{ id: batch[0].id, text: batch[0].text, kept: false }]
  }
  const cached: TranslatedParagraph[] = []
  const pending: Segment[] = []
  for (const member of batch) {
    const hit = ctx.cache.get(member.text)
    if (hit) cached.push({ id: member.id, text: hit, kept: false })
    else pending.push(member)
  }
  if (cached.length > 0) {
    ctx.onEvent({
      stage: 'translate',
      level: 'info',
      message: `缓存命中 ${cached.length} 段`,
    })
  }
  if (pending.length === 0) return cached
  try {
    const got = await requestMembers(pending, 'standard', ctx)
    const missing: Segment[] = []
    const done: TranslatedParagraph[] = [...cached]
    for (const member of pending) {
      const check = got.get(member.id)
      if (check?.ok) {
        done.push({ id: member.id, text: check.text, kept: false })
        ctx.cache.set(member.text, check.text)
      } else missing.push(member)
    }
    if (missing.length > 0) {
      if (pending.length > 1) {
        ctx.onEvent({
          stage: 'translate',
          level: 'warning',
          message: '批量请求未完成，改为逐段翻译',
        })
      }
      const limit = createLimit(REPAIR_PARALLELISM)
      const repaired = await Promise.all(
        missing.map((member) => limit(() => translateSegment(member, ctx))),
      )
      done.push(...repaired)
    }
    return done
  } catch (error) {
    if (endsDocument(error)) throw error
    const limit = createLimit(REPAIR_PARALLELISM)
    const repaired = await Promise.all(
      pending.map((member) => limit(() => translateSegment(member, ctx))),
    )
    return [...cached, ...repaired]
  }
}

async function requestMembers(
  members: Segment[],
  mode: MarkerMode,
  ctx: TranslateContext,
): Promise<Map<string, ReplyCheck>> {
  const protection = protectTexts(members.map((member) => member.text))
  const protectedMembers = members.map((member, index) => ({
    id: member.id,
    text: protection.texts[index] ?? member.text,
  }))
  const multi = protectedMembers.length > 1
  const reply = await submit(
    {
      model: ctx.model,
      system: buildSystemPrompt(ctx.runtime.systemPrompt, mode, multi),
      user: buildUserMessage(protectedMembers),
      ...(ctx.runtime.llm.maxOutputTokens > 0
        ? { maxTokens: ctx.runtime.llm.maxOutputTokens }
        : {}),
    },
    ctx,
  )
  const parsed = multi ? parseBatch(reply.text) : new Map([[members[0]?.id ?? '', reply.text]])
  const out = new Map<string, ReplyCheck>()
  for (const member of members) {
    const raw = parsed.get(member.id)
    if (raw === undefined) continue
    const tokens = tokenSubset(protection, member.text, members.indexOf(member))
    out.set(
      member.id,
      checkReply({
        text: raw,
        finish: reply.finish,
        source: member.text,
        tokens: tokens.tokens,
        originals: tokens.originals,
        mode,
      }),
    )
  }
  return out
}

function tokenSubset(
  protection: ReturnType<typeof protectTexts>,
  source: string,
  index: number,
): { tokens: string[]; originals: Map<string, string> } {
  const text = protection.texts[index] ?? source
  const tokens = protection.tokens.filter((token) => text.includes(token))
  const originals = new Map<string, string>()
  for (const token of tokens) {
    const original = protection.originals.get(token)
    if (original) originals.set(token, original)
  }
  return { tokens, originals }
}

async function translateSegment(
  segment: Segment,
  ctx: TranslateContext,
): Promise<TranslatedParagraph> {
  const cached = ctx.cache.get(segment.text)
  if (cached) return { id: segment.id, text: cached, kept: false }
  const n = ctx.indexOf.get(parentSegmentId(segment.id)) ?? 1
  let mode: MarkerMode = 'standard'
  for (let attempt = 0; attempt < 3; attempt += 1) {
    throwIfAborted(ctx.signal)
    try {
      const got = await requestMembers([segment], mode, ctx)
      const check = got.get(segment.id)
      if (check?.ok) {
        ctx.cache.set(segment.text, check.text)
        return { id: segment.id, text: check.text, kept: false }
      }
      if (check?.kind === 'invalid' && mode === 'standard') {
        mode = 'strict'
        continue
      }
      if (check?.kind === 'empty') continue
      break
    } catch (error) {
      if (endsDocument(error)) throw error
      break
    }
  }
  if (charCount(segment.text) > SPLIT_MIN_CHARS) {
    const parts = smartSplit(segment.text, Math.ceil(charCount(segment.text) / 2))
    if (parts.length > 1) {
      ctx.onEvent({
        stage: 'translate',
        level: 'warning',
        message: `第 ${n} 段拆成 ${parts.length} 部分重译`,
      })
      const pieces = await Promise.all(
        parts.map((text, index) =>
          translateSegment({ id: `${segment.id}#${index + 1}`, text }, ctx),
        ),
      )
      return {
        id: segment.id,
        text: pieces.map((piece) => piece.text).join(''),
        kept: pieces.every((piece) => piece.kept),
      }
    }
  }
  return isolateAndTranslate(segment, n, ctx)
}

async function isolateAndTranslate(
  segment: Segment,
  n: number,
  ctx: TranslateContext,
): Promise<TranslatedParagraph> {
  const protection = protectTexts([segment.text])
  const protectedText = protection.texts[0] ?? segment.text
  const pieces = splitIsolated(protectedText, protection.tokens)
  const limit = createLimit(REPAIR_PARALLELISM)
  let textTotal = 0
  let textFailed = 0
  const out: string[] = []
  await Promise.all(
    pieces.map((piece, index) =>
      limit(async () => {
        if (piece.kind === 'token') {
          out[index] = protection.originals.get(piece.value) ?? piece.value
          return
        }
        if (!HAS_LETTER.test(piece.value)) {
          out[index] = piece.value
          return
        }
        textTotal += 1
        const translated = await translateIsolatedText(piece.value, ctx)
        if (translated === undefined) {
          textFailed += 1
          out[index] = piece.value
          ctx.onEvent({
            stage: 'translate',
            level: 'warning',
            message: `第 ${n} 段有一个片段无法翻译，已保留原文`,
          })
        } else {
          out[index] = translated
        }
      }),
    ),
  )
  const text = restoreIsolated(out.join(''), protection.originals)
  return { id: segment.id, text, kept: textTotal > 0 && textFailed === textTotal }
}

function restoreIsolated(text: string, originals: Map<string, string>): string {
  let out = text
  for (const [token, original] of originals) out = out.split(token).join(original)
  return out
}

async function translateIsolatedText(
  text: string,
  ctx: TranslateContext,
): Promise<string | undefined> {
  const chunks =
    charCount(text) > ISOLATED_FRAGMENT_CHARS ? smartSplit(text, ISOLATED_FRAGMENT_CHARS) : [text]
  const parts: string[] = []
  for (const chunk of chunks) {
    const translated = await translateIsolatedChunk(chunk, ctx)
    if (translated === undefined) return undefined
    parts.push(translated)
  }
  return parts.join('')
}

async function translateIsolatedChunk(
  text: string,
  ctx: TranslateContext,
): Promise<string | undefined> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    throwIfAborted(ctx.signal)
    try {
      const protection = protectTexts([text])
      const reply = await submit(
        {
          model: ctx.model,
          system: buildSystemPrompt(ctx.runtime.systemPrompt, 'isolated', false),
          user: protection.texts[0] ?? text,
        },
        ctx,
      )
      const check = checkReply({
        text: reply.text,
        finish: reply.finish,
        source: text,
        tokens: protection.tokens,
        originals: protection.originals,
        mode: 'isolated',
      })
      if (check.ok) return check.text
    } catch (error) {
      if (endsDocument(error)) throw error
    }
    if (charCount(text) > MIN_FRAGMENT_CHARS) {
      const halves = smartSplit(text, Math.ceil(charCount(text) / 2))
      if (halves.length > 1) {
        const nested: string[] = []
        for (const half of halves) {
          const part = await translateIsolatedChunk(half, ctx)
          if (part === undefined) return undefined
          nested.push(part)
        }
        return nested.join('')
      }
    }
  }
  return undefined
}

function splitIsolated(
  text: string,
  tokens: string[],
): Array<{ kind: 'text' | 'token'; value: string }> {
  if (tokens.length === 0) return [{ kind: 'text', value: text }]
  const pieces: Array<{ kind: 'text' | 'token'; value: string }> = []
  let cursor = 0
  for (const token of tokens) {
    const at = text.indexOf(token, cursor)
    if (at < 0) continue
    if (at > cursor) pieces.push({ kind: 'text', value: text.slice(cursor, at) })
    pieces.push({ kind: 'token', value: token })
    cursor = at + token.length
  }
  if (cursor < text.length) pieces.push({ kind: 'text', value: text.slice(cursor) })
  return pieces
}

function parentSegmentId(id: string): string {
  const hash = id.lastIndexOf('#')
  if (hash <= 0) return id
  return /^\d+$/.test(id.slice(hash + 1)) ? id.slice(0, hash) : id
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
      // oversized / refused / output will not change on a resend: the caller's ladder
      // (split, isolate) handles them without waiting.
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
