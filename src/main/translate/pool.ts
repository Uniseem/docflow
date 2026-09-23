import {
  POOL_QUEUE_CAPACITY,
  RATE_LIMIT_COOLDOWN_MS,
  REQUEST_TIMEOUT_MS,
} from '../../shared/constants'
import type { ProviderConfig } from '../../shared/types'
import { withMockProviderUrl } from '../../shared/presets'
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

  constructor(
    private provider: ProviderConfig,
    private keys: KeyRing,
    private fetchFn: FetchFn,
    options: { clock?: Clock; appVersion?: string } = {},
  ) {
    this.#configured = provider.concurrency
    this.#current = provider.concurrency
    this.#clock = options.clock ?? systemClock
    this.#appVersion = options.appVersion ?? '4.0.0'
  }

  useProvider(provider: ProviderConfig): void {
    this.provider = provider
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

  async execute(request: ChatRequest, signal: AbortSignal): Promise<ChatReply> {
    await this.#acquire()
    try {
      return await this.#dispatch(request, signal)
    } finally {
      this.#release()
    }
  }

  async #dispatch(request: ChatRequest, signal: AbortSignal): Promise<ChatReply> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    const combined = AbortSignal.any([signal, timeout])
    const tried = new Set<string>()

    while (!combined.aborted) {
      const key = this.keys.pick()
      if (!key) {
        throw this.keys.size === 0 ? this.keys.missingKeyError() : this.keys.allFailedError()
      }
      if (tried.has(key)) {
        throw degradeCredential(this.keys.allFailedError())
      }
      tried.add(key)

      try {
        const reply = await postChat(
          this.provider,
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
        if (!(error instanceof ProviderError)) throw error
        if (error.kind === 'rateLimited') {
          this.#noteRateLimited()
          throw error
        }
        if (error.kind === 'credential') {
          const next = this.keys.noteCredential(key, error.message)
          if (next === 'retry') continue
          throw this.keys.size <= 1 ? error : this.keys.allFailedError()
        }
        throw error
      }
    }

    throw new ProviderError('transient', '翻译请求已取消')
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

  async #acquire(): Promise<void> {
    while (this.#waiters.length >= POOL_QUEUE_CAPACITY) {
      await new Promise<void>((resolve) => {
        this.#queueGate.push(resolve)
      })
    }
    if (this.#inFlight < this.#current && this.#waiters.length === 0) {
      this.#inFlight += 1
      return
    }
    await new Promise<void>((resolve) => {
      this.#waiters.push(resolve)
    })
    this.#flushQueueGate()
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

export class TranslationPools {
  #pools = new Map<string, ProviderPool>()
  #rings = new Map<string, KeyRing>()

  constructor(
    private readonly fetchFn: FetchFn,
    private readonly readRawKey: (providerId: string) => string | undefined,
    private readonly clock: Clock = systemClock,
    private readonly appVersion = '4.0.0',
  ) {}

  get(provider: ProviderConfig): ProviderPool {
    const resolved = withMockProviderUrl(provider, process.env.DOCFLOW_MOCK_PROVIDER_URL)
    const existing = this.#pools.get(resolved.id)
    if (existing) {
      existing.useProvider(resolved)
      return existing
    }
    const ring = new KeyRing(this.readRawKey(resolved.id) ?? '', this.clock)
    const pool = new ProviderPool(resolved, ring, this.fetchFn, {
      clock: this.clock,
      appVersion: this.appVersion,
    })
    this.#rings.set(resolved.id, ring)
    this.#pools.set(resolved.id, pool)
    return pool
  }

  configure(providers: ProviderConfig[]): void {
    for (const provider of providers) {
      this.get(provider).setConfigured(provider.concurrency)
    }
  }

  resetKeys(providerId: string): void {
    this.#rings.get(providerId)?.reset(this.readRawKey(providerId) ?? '')
  }
}
