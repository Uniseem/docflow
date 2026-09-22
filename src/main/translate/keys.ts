import { KEY_BENCH_MS } from '../../shared/constants'
import { maskKey, splitKeys } from '../../shared/text'
import { ProviderError } from './errors'

export { maskKey as mask, splitKeys }

export type Clock = {
  now: () => number
}

export const systemClock: Clock = {
  now: () => Date.now(),
}

export class FakeClock implements Clock {
  constructor(private ms = 0) {}

  now(): number {
    return this.ms
  }

  advance(ms: number): void {
    this.ms += ms
  }
}

export class KeyRing {
  #keys: string[] = []
  #next = 0
  #benchedUntil = new Map<string, number>()
  #lastError = ''

  constructor(
    raw: string,
    private readonly clock: Clock = systemClock,
  ) {
    this.reset(raw)
  }

  reset(raw: string): void {
    this.#keys = splitKeys(raw)
    this.#next = 0
    this.#benchedUntil.clear()
    this.#lastError = ''
  }

  get size(): number {
    return this.#keys.length
  }

  usable(): string[] {
    const now = this.clock.now()
    return this.#keys.filter((key) => (this.#benchedUntil.get(key) ?? 0) <= now)
  }

  pick(): string | undefined {
    const usable = this.usable()
    if (usable.length === 0) return undefined
    const index = this.#next % usable.length
    this.#next = index + 1
    return usable[index]
  }

  noteCredential(key: string, message: string): 'retry' | 'fail' {
    this.#lastError = message
    if (this.#keys.length <= 1) return 'fail'
    this.#benchedUntil.set(key, this.clock.now() + KEY_BENCH_MS)
    return this.usable().length > 0 ? 'retry' : 'fail'
  }

  allFailedMessage(): string {
    const count = this.#keys.length
    const detail = this.#lastError || '未知错误'
    return `全部 ${count} 个 API Key 都无法使用：${detail}`
  }

  missingKeyError(): ProviderError {
    return new ProviderError('credential', '未配置 API Key。')
  }

  allFailedError(): ProviderError {
    return new ProviderError('credential', this.allFailedMessage())
  }
}

export function degradeCredential(error: ProviderError): ProviderError {
  return new ProviderError('transient', error.message, {
    snippet: error.snippet,
    ...(error.status === undefined ? {} : { status: error.status }),
  })
}
