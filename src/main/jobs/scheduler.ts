import {
  MAX_ATTEMPTS,
  RETRY_BASE_SECONDS,
  SCHEDULER_TICK_MS,
  STOP_GRACE_MS,
} from '../../shared/constants'
import { ERROR_CODES, UserError } from '../../shared/errors'
import type { DocumentLibrary } from '../library/library'
import type { DocumentManifest } from '../../shared/types'

export type PipelineFn = (id: string, signal: AbortSignal) => Promise<void>

export type SchedulerOptions = {
  concurrency: () => number
  now?: () => number
  delay?: (ms: number) => Promise<void>
  onChanged?: (manifest: DocumentManifest) => void
  onEvent?: (id: string, message: string) => Promise<void>
}

export class Scheduler {
  private readonly controllers = new Map<string, AbortController>()
  private readonly running = new Map<string, Promise<void>>()
  private timer: ReturnType<typeof setInterval> | undefined
  private stopped = false

  constructor(
    private readonly library: DocumentLibrary,
    private readonly pipeline: PipelineFn,
    private readonly options: SchedulerOptions,
  ) {}

  isRunning(id: string): boolean {
    return this.running.has(id)
  }

  runningIds(): Set<string> {
    return new Set(this.running.keys())
  }

  async start(): Promise<void> {
    this.stopped = false
    for (const item of this.library.index.recoverQueued()) {
      const saved = await this.library.update(item.id, {
        status: 'queued',
        nextAttemptAt: null,
      })
      await this.options.onEvent?.(item.id, '应用重新启动，从断点继续')
      this.options.onChanged?.(saved)
    }
    await this.tick()
    this.timer = setInterval(() => {
      void this.tick()
    }, SCHEDULER_TICK_MS)
  }

  async stop(graceMs = STOP_GRACE_MS): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    for (const controller of this.controllers.values()) controller.abort()
    await Promise.race([
      Promise.allSettled([...this.running.values()]),
      this.options.delay?.(graceMs) ?? new Promise((resolve) => setTimeout(resolve, graceMs)),
    ])
  }

  async tick(): Promise<void> {
    if (this.stopped) return
    const now = this.options.now?.() ?? Date.now()
    for (const item of this.library.index.list('all')) {
      if (item.status !== 'retrying' || !item.nextAttemptAt) continue
      if (new Date(item.nextAttemptAt).getTime() <= now) {
        const saved = await this.library.update(item.id, { status: 'queued', nextAttemptAt: null })
        this.options.onChanged?.(saved)
      }
    }
    const cap = Math.max(1, this.options.concurrency())
    const queued = this.library.index
      .list('all')
      .filter((item) => item.status === 'queued')
      .sort((a, b) => {
        const ta = a.nextAttemptAt ?? a.createdAt
        const tb = b.nextAttemptAt ?? b.createdAt
        return ta < tb ? -1 : ta > tb ? 1 : 0
      })
    for (const item of queued) {
      if (this.running.size >= cap) break
      this.launch(item.id)
    }
  }

  async cancel(id: string): Promise<DocumentManifest> {
    this.library.require(id)
    this.controllers.get(id)?.abort()
    const saved = await this.library.update(id, {
      status: 'cancelled',
      failure: { code: ERROR_CODES.cancelled, message: '已取消处理', permanent: true },
    })
    await this.options.onEvent?.(id, '已取消处理')
    this.options.onChanged?.(saved)
    const pending = this.running.get(id)
    if (pending) await pending.catch(() => undefined)
    return this.library.require(id) ?? saved
  }

  async retry(
    id: string,
    snapshot: DocumentManifest['settingsSnapshot'],
  ): Promise<DocumentManifest> {
    const current = this.library.require(id)
    if (current.status !== 'failed' && current.status !== 'cancelled') {
      throw new UserError(ERROR_CODES.not_found, '只有失败或已取消的文档可以重新处理。')
    }
    const saved = await this.library.update(id, {
      status: 'queued',
      attempts: 0,
      failure: null,
      settingsSnapshot: snapshot,
      nextAttemptAt: null,
      completedAt: null,
    })
    this.options.onChanged?.(saved)
    await this.tick()
    return saved
  }

  async remove(id: string): Promise<void> {
    if (this.running.has(id)) {
      await this.cancel(id)
      await Promise.race([
        this.running.get(id) ?? Promise.resolve(),
        this.options.delay?.(STOP_GRACE_MS) ?? new Promise((r) => setTimeout(r, STOP_GRACE_MS)),
      ])
    }
    await this.library.remove(id)
  }

  private launch(id: string): void {
    if (this.running.has(id)) return
    const controller = new AbortController()
    this.controllers.set(id, controller)
    const task = this.runOne(id, controller.signal).finally(() => {
      this.controllers.delete(id)
      this.running.delete(id)
      void this.tick()
    })
    this.running.set(id, task)
  }

  private async runOne(id: string, signal: AbortSignal): Promise<void> {
    const started = await this.library.update(id, {
      status: 'processing',
      startedAt: this.library.require(id).startedAt ?? new Date().toISOString(),
      failure: null,
    })
    this.options.onChanged?.(started)
    try {
      if (signal.aborted) throw new UserError(ERROR_CODES.cancelled)
      await this.pipeline(id, signal)
      if (signal.aborted) return
      const done = await this.library.update(id, {
        status: 'completed',
        stage: 'done',
        progress: 100,
        completedAt: new Date().toISOString(),
        failure: null,
      })
      this.options.onChanged?.(done)
    } catch (error) {
      if (signal.aborted || isCancelled(error)) {
        const saved = await this.library.update(id, {
          status: 'cancelled',
          failure: { code: ERROR_CODES.cancelled, message: '已取消处理', permanent: true },
        })
        await this.options.onEvent?.(id, '已取消处理')
        this.options.onChanged?.(saved)
        return
      }
      const current = this.library.require(id)
      const code =
        error && typeof error === 'object' && 'code' in error ? String(error.code) : 'internal'
      const message = error instanceof Error ? error.message : String(error)
      const permanent =
        error && typeof error === 'object' && 'permanent' in error ? Boolean(error.permanent) : true
      const attempts = current.attempts + 1
      if (!permanent && attempts < MAX_ATTEMPTS) {
        const wait = RETRY_BASE_SECONDS * attempts
        const next = new Date((this.options.now?.() ?? Date.now()) + wait * 1000).toISOString()
        const saved = await this.library.update(id, {
          status: 'retrying',
          attempts,
          failure: { code, message, permanent: false },
          nextAttemptAt: next,
        })
        await this.options.onEvent?.(id, `等待自动重试（第 ${attempts} 次）`)
        this.options.onChanged?.(saved)
        return
      }
      const saved = await this.library.update(id, {
        status: 'failed',
        attempts,
        failure: { code, message, permanent },
        nextAttemptAt: null,
        completedAt: new Date().toISOString(),
      })
      await this.options.onEvent?.(id, `处理失败：${message}`)
      this.options.onChanged?.(saved)
    }
  }
}

function isCancelled(error: unknown): boolean {
  return error instanceof UserError && error.code === ERROR_CODES.cancelled
}
