import {
  POOL_QUEUE_CAPACITY,
  RATE_LIMIT_COOLDOWN_MS,
  REQUEST_TIMEOUT_MS,
} from '../../shared/constants'
import { ERROR_CODES, UserError } from '../../shared/errors'
import type { ProviderConfig } from '../../shared/types'
import { keyOptional, withMockProviderUrl } from '../../shared/presets'
import { ProviderError } from './errors'
import type { FetchFn } from './http'
import { type Clock, KeyRing, degradeCredential, systemClock } from './keys'
import { postChat } from './providers'
import type { ChatReply } from './response'

export type ChatRequest = {
  model: string
  system: string
  user: string
  maxTokens?: number
}

export type PoolStats = {
  configured: number
  current: number
  inFlight: number
  waiting: number
}

/**
 * Concurrency, adaptive back-off and key rotation for one provider id. The pool keeps no
 * endpoint config: each request carries the caller's provider snapshot, so two documents
 * that started with different settings never switch each other's base URL or model list.
 */
export class ProviderPool {
  #configured: number
  #current: number
  #inFlight = 0
  #waiters: Array<() => void> = []
  #queueGate: Array<() => void> = []
  #successes = 0
  #lastReduceAt = Number.NEGATIVE_INFINITY
  #appVersion: string
  #clock: Clock
  readonly #initial: ProviderConfig

  constructor(
    provider: ProviderConfig,
    private keys: KeyRing,
    private fetchFn: FetchFn,
    options: { clock?: Clock; appVersion?: string } = {},
  ) {
    this.#initial = provider
    this.#configured = provider.concurrency
    this.#current = provider.concurrency
    this.#clock = options.clock ?? systemClock
    this.#appVersion = options.appVersion ?? '4.0.0'
  }

  stats(): PoolStats {
    return {
      configured: this.#configured,
      current: this.#current,
      inFlight: this.#inFlight,
      waiting: this.#waiters.length,
    }
  }

  setConfigured(n: number): void {
    const atCap = this.#current === this.#configured
    this.#configured = n
    if (this.#current > n) this.#current = n
    else if (atCap) this.#current = n
    this.#wake()
  }

  async execute(
    request: ChatRequest,
    signal: AbortSignal,
    provider: ProviderConfig = this.#initial,
  ): Promise<ChatReply> {
    await this.#acquire(signal)
    try {
      return await this.#dispatch(provider, request, signal)
    } finally {
      this.#release()
    }
  }

  async #dispatch(
    provider: ProviderConfig,
    request: ChatRequest,
    signal: AbortSignal,
  ): Promise<ChatReply> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    const combined = AbortSignal.any([signal, timeout])
    const tried = new Set<string>()
    // Local servers (Ollama, LM Studio, any localhost endpoint) take requests without a key.
    const keyless = this.keys.size === 0 && keyOptional(provider)

    while (!combined.aborted) {
      const key = keyless ? undefined : this.keys.pick()
      if (!keyless) {
        if (!key) {
          throw this.keys.size === 0 ? this.keys.missingKeyError() : this.keys.allFailedError()
        }
        if (tried.has(key)) {
          throw degradeCredential(this.keys.allFailedError())
        }
        tried.add(key)
      }

      try {
        const reply = await postChat(
          provider,
          request.model,
          request.system,
          request.user,
          request.maxTokens,
          key,
          this.fetchFn,
          combined,
          this.#appVersion,
        )
        this.#noteSuccess()
        return reply
      } catch (error) {
        // The caller gave up (document cancelled or app shutting down): not a provider failure.
        if (signal.aborted) throw cancelledError()
        if (!(error instanceof ProviderError)) throw error
        if (error.kind === 'rateLimited') {
          this.#noteRateLimited()
          throw error
        }
        if (error.kind === 'credential' && key) {
          const next = this.keys.noteCredential(key, error.message)
          if (next === 'retry') continue
          throw this.keys.size <= 1 ? error : this.keys.allFailedError()
        }
        throw error
      }
    }

    if (signal.aborted) throw cancelledError()
    throw new ProviderError('transient', '翻译请求超时')
  }

  #noteRateLimited(): void {
    const now = this.#clock.now()
    if (now - this.#lastReduceAt < RATE_LIMIT_COOLDOWN_MS) return
    this.#lastReduceAt = now
    this.#current = Math.max(1, Math.floor(this.#current / 2))
    this.#successes = 0
  }

  #noteSuccess(): void {
    if (this.#current >= this.#configured) {
      this.#successes = 0
      return
    }
    this.#successes += 1
    const need = Math.max(this.#current, 4)
    if (this.#successes < need) return
    this.#successes = 0
    this.#current = Math.min(
      this.#configured,
      this.#current + Math.max(1, Math.floor(this.#current / 4)),
    )
    this.#wake()
  }

  async #acquire(signal: AbortSignal): Promise<void> {
    while (this.#waiters.length >= POOL_QUEUE_CAPACITY) {
      await this.#park(this.#queueGate, signal)
    }
    if (signal.aborted) throw cancelledError()
    if (this.#inFlight < this.#current && this.#waiters.length === 0) {
      this.#inFlight += 1
      return
    }
    // #wake() counts the slot as taken before it resolves a waiter.
    await this.#park(this.#waiters, signal)
    this.#flushQueueGate()
  }

  /** Waits in `queue` until woken; leaves the queue at once when `signal` aborts. */
  #park(queue: Array<() => void>, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(cancelledError())
    return new Promise<void>((resolve, reject) => {
      const wake = () => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }
      const onAbort = () => {
        const index = queue.indexOf(wake)
        if (index >= 0) queue.splice(index, 1)
        this.#flushQueueGate()
        reject(cancelledError())
      }
      signal.addEventListener('abort', onAbort, { once: true })
      queue.push(wake)
    })
  }

  #release(): void {
    this.#inFlight -= 1
    this.#wake()
  }

  #wake(): void {
    while (this.#waiters.length > 0 && this.#inFlight < this.#current) {
      this.#inFlight += 1
      const next = this.#waiters.shift()
      next?.()
    }
    this.#flushQueueGate()
  }

  #flushQueueGate(): void {
    while (this.#queueGate.length > 0 && this.#waiters.length < POOL_QUEUE_CAPACITY) {
      const next = this.#queueGate.shift()
      next?.()
    }
  }
}

function cancelledError(): UserError {
  return new UserError(ERROR_CODES.cancelled)
}

export class TranslationPools {
  #pools = new Map<string, ProviderPool>()
  #rings = new Map<string, KeyRing>()

  constructor(
    private readonly fetchFn: FetchFn,
    private readonly readRawKey: (providerId: string) => string | undefined,
    private readonly clock: Clock = systemClock,
    private readonly appVersion = '4.0.0',
  ) {}

  /** The pool for `provider.id`, created with the provider's concurrency and saved keys. */
  get(provider: ProviderConfig): ProviderPool {
    const existing = this.#pools.get(provider.id)
    if (existing) return existing
    const resolved = withMockProviderUrl(provider, process.env.DOCFLOW_MOCK_PROVIDER_URL)
    const ring = new KeyRing(this.readRawKey(resolved.id) ?? '', this.clock)
    const pool = new ProviderPool(resolved, ring, this.fetchFn, {
      clock: this.clock,
      appVersion: this.appVersion,
    })
    this.#rings.set(resolved.id, ring)
    this.#pools.set(resolved.id, pool)
    return pool
  }

  /** Sends one request with the caller's provider snapshot through that provider's pool. */
  execute(provider: ProviderConfig, request: ChatRequest, signal: AbortSignal): Promise<ChatReply> {
    const resolved = withMockProviderUrl(provider, process.env.DOCFLOW_MOCK_PROVIDER_URL)
    return this.get(resolved).execute(request, signal, resolved)
  }

  configure(providers: ProviderConfig[]): void {
    for (const provider of providers) {
      this.get(provider).setConfigured(provider.concurrency)
    }
  }

  resetKeys(providerId: string): void {
    this.#rings.get(providerId)?.reset(this.readRawKey(providerId) ?? '')
  }

  /**
   * Drops the pool and key ring of one provider (all when no id is given) so the next
   * request re-reads its keys and concurrency. Requests already running finish on the old
   * pool.
   */
  invalidate(providerId?: string): void {
    if (providerId === undefined) {
      this.#pools.clear()
      this.#rings.clear()
      return
    }
    this.#pools.delete(providerId)
    this.#rings.delete(providerId)
  }
}
