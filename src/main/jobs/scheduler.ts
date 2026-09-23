import { setMaxListeners } from 'node:events'
import {
  MAX_ATTEMPTS,
  RETRY_BASE_SECONDS,
  SCHEDULER_TICK_MS,
  STOP_GRACE_MS,
} from '../../shared/constants'
import { ERROR_CODES, UserError } from '../../shared/errors'
import type { DocumentLibrary } from '../library/library'
import type { DocumentManifest, DocumentStatus } from '../../shared/types'
import { ProviderError, userFacingProviderError } from '../translate/errors'

export type PipelineFn = (id: string, signal: AbortSignal) => Promise<void>

export type SchedulerEvent = {
  level: 'info' | 'warning' | 'error'
  message: string
  detail?: string
}

export type SchedulerOptions = {
  concurrency: () => number
  now?: () => number
  delay?: (ms: number) => Promise<void>
  onChanged?: (manifest: DocumentManifest) => void
  onEvent?: (id: string, event: SchedulerEvent) => Promise<void>
  /** An error that is not a user or provider error: log it with its stack. */
  onInternalError?: (id: string, error: unknown) => void
}

/** Abort reasons: shutting down leaves the document for `recoverQueued()`, cancel ends it. */
export const SHUTDOWN_REASON = 'docflow:shutdown'
export const CANCEL_REASON = 'docflow:cancel'

const CANCELLABLE: ReadonlySet<DocumentStatus> = new Set(['queued', 'processing', 'retrying'])

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
      await this.options.onEvent?.(item.id, {
        level: 'info',
        message: '应用重新启动，从断点继续',
      })
      this.options.onChanged?.(saved)
    }
    await this.tick()
    this.timer = setInterval(() => {
      void this.tick()
    }, SCHEDULER_TICK_MS)
  }

  /**
   * Stops for an app quit or a library change. Running documents are interrupted but stay
   * `processing` (not cancelled): the next `start()` on that library resumes them from
   * their checkpoints.
   */
  async stop(graceMs = STOP_GRACE_MS): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    for (const controller of this.controllers.values()) controller.abort(SHUTDOWN_REASON)
    await Promise.race([Promise.allSettled([...this.running.values()]), this.wait(graceMs)])
  }

  async tick(): Promise<void> {
    if (this.stopped) return
    const now = this.now()
    for (const item of this.library.index.list('all')) {
      if (item.status !== 'retrying' || !item.nextAttemptAt) continue
      if (new Date(item.nextAttemptAt).getTime() <= now) {
        const saved = await this.library.update(item.id, { status: 'queued', nextAttemptAt: null })
        this.options.onChanged?.(saved)
      }
    }
    if (this.stopped) return
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

  /**
   * Cancels a queued, processing or retrying document; any other status is left as is.
   * Waits at most STOP_GRACE_MS for the running task to wind down.
   */
  async cancel(id: string): Promise<DocumentManifest> {
    const current = this.library.require(id)
    if (!isCancellable(current)) return current
    this.controllers.get(id)?.abort(CANCEL_REASON)
    const saved = await this.library.updateWhen(id, isCancellable, {
      status: 'cancelled',
      failure: { code: ERROR_CODES.cancelled, message: '已取消处理', permanent: true },
      nextAttemptAt: null,
      completedAt: new Date(this.now()).toISOString(),
    })
    // Finished, failed or cancelled meanwhile: nothing to cancel, and no second event.
    if (!saved) return this.library.index.get(id) ?? current
    await this.options.onEvent?.(id, { level: 'warning', message: '已取消处理' })
    this.options.onChanged?.(saved)
    await this.settle(id)
    return this.library.index.get(id) ?? saved
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
      startedAt: null,
      completedAt: null,
    })
    this.options.onChanged?.(saved)
    await this.tick()
    return saved
  }

  /** Cancels (waiting at most STOP_GRACE_MS) and deletes the document folder. */
  async remove(id: string): Promise<void> {
    this.library.require(id)
    if (this.running.has(id)) {
      this.controllers.get(id)?.abort(CANCEL_REASON)
      await this.settle(id)
    }
    await this.library.remove(id)
  }

  private async settle(id: string): Promise<void> {
    const pending = this.running.get(id)
    if (!pending) return
    await Promise.race([pending, this.wait(STOP_GRACE_MS)])
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private wait(ms: number): Promise<void> {
    if (this.options.delay) return this.options.delay(ms)
    return new Promise((resolve) => {
      setTimeout(resolve, ms).unref?.()
    })
  }

  private launch(id: string): void {
    if (this.running.has(id)) return
    const controller = new AbortController()
    // Every in-flight request of the document listens on this signal.
    setMaxListeners(0, controller.signal)
    this.controllers.set(id, controller)
    const task = this.runOne(id, controller.signal)
      .catch((error: unknown) => {
        this.options.onInternalError?.(id, error)
      })
      .finally(() => {
        this.controllers.delete(id)
        this.running.delete(id)
        void this.tick()
      })
    this.running.set(id, task)
  }

  private async runOne(id: string, signal: AbortSignal): Promise<void> {
    // Cancelled or deleted between tick() and now: nothing to run.
    if (this.library.index.get(id)?.status !== 'queued') return
    const started = await this.library.updateWhen(
      id,
      (current) => current.status === 'queued',
      (current) => ({
        status: 'processing',
        startedAt: current.startedAt ?? new Date(this.now()).toISOString(),
        failure: null,
      }),
    )
    if (!started) return
    this.options.onChanged?.(started)
    try {
      if (signal.aborted) throw new UserError(ERROR_CODES.cancelled)
      await this.pipeline(id, signal)
    } catch (error) {
      await this.onPipelineError(id, signal, error)
      return
    }
    // The pipeline returned, so the outputs are in place: the document is completed even if
    // a shutdown arrived while it was archiving.
    const done = await this.library
      .updateWhen(
        id,
        (current) => current.status === 'processing' || current.status === 'cancelled',
        {
          status: 'completed',
          stage: 'done',
          progress: 100,
          completedAt: new Date(this.now()).toISOString(),
          failure: null,
        },
      )
      .catch(ignoreNotFound)
    if (done) this.options.onChanged?.(done)
  }

  private async onPipelineError(id: string, signal: AbortSignal, error: unknown): Promise<void> {
    // cancel() already recorded a user cancel; a shutdown leaves the document `processing`
    // for recoverQueued(). Either way the aborted task must not overwrite newer state.
    if (signal.aborted) return
    const processing = (current: DocumentManifest) => current.status === 'processing'
    if (isCancelled(error)) {
      const saved = await this.library
        .updateWhen(id, processing, {
          status: 'cancelled',
          failure: { code: ERROR_CODES.cancelled, message: '已取消处理', permanent: true },
          completedAt: new Date(this.now()).toISOString(),
        })
        .catch(ignoreNotFound)
      if (!saved) return
      await this.options.onEvent?.(id, { level: 'warning', message: '已取消处理' })
      this.options.onChanged?.(saved)
      return
    }
    const mapped = mapFailure(error)
    if (mapped.internal) this.options.onInternalError?.(id, error)
    const detail = mapped.detail ? { detail: mapped.detail } : {}
    const retrying = await this.library
      .updateWhen(
        id,
        (current) =>
          processing(current) && !mapped.permanent && current.attempts + 1 < MAX_ATTEMPTS,
        (current) => ({
          status: 'retrying',
          attempts: current.attempts + 1,
          failure: { code: mapped.code, message: mapped.message, permanent: false },
          nextAttemptAt: new Date(
            this.now() + RETRY_BASE_SECONDS * (current.attempts + 1) * 1000,
          ).toISOString(),
        }),
      )
      .catch(ignoreNotFound)
    if (retrying) {
      await this.options.onEvent?.(id, {
        level: 'warning',
        message: `等待自动重试（第 ${retrying.attempts} 次）`,
        detail: mapped.detail ?? mapped.message,
      })
      this.options.onChanged?.(retrying)
      return
    }
    const saved = await this.library
      .updateWhen(id, processing, (current) => ({
        status: 'failed',
        attempts: current.attempts + 1,
        failure: { code: mapped.code, message: mapped.message, permanent: mapped.permanent },
        nextAttemptAt: null,
        completedAt: new Date(this.now()).toISOString(),
      }))
      .catch(ignoreNotFound)
    if (!saved) return
    await this.options.onEvent?.(id, {
      level: 'error',
      message: `处理失败：${mapped.message}`,
      ...detail,
    })
    this.options.onChanged?.(saved)
  }
}

function isCancellable(current: DocumentManifest): boolean {
  // `archive` moves the outputs over work/: past that point cancelling would only throw
  // the finished result away.
  if (current.status === 'processing' && current.stage === 'archive') return false
  return CANCELLABLE.has(current.status)
}

/** The document was deleted while its task wound down. */
function ignoreNotFound(error: unknown): undefined {
  if (error instanceof UserError && error.code === ERROR_CODES.not_found) return undefined
  throw error
}

function isCancelled(error: unknown): boolean {
  return error instanceof UserError && error.code === ERROR_CODES.cancelled
}

export type MappedFailure = {
  code: string
  message: string
  permanent: boolean
  /** Technical text for the event detail (never the primary message). */
  detail?: string
  /** Not a user or provider error: worth a stack trace in the log. */
  internal: boolean
}

export function mapFailure(error: unknown): MappedFailure {
  if (error instanceof UserError) {
    return { code: error.code, message: error.message, permanent: error.permanent, internal: false }
  }
  if (error instanceof ProviderError) {
    const permanent =
      error.kind === 'credential' || error.kind === 'fatal' || error.kind === 'refused'
    return {
      code: error.kind,
      message: userFacingProviderError(error),
      permanent,
      internal: false,
    }
  }
  const raw = error instanceof Error ? error.message : String(error)
  const errno =
    error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined
  if (errno === 'ENOSPC') {
    return {
      code: 'disk_full',
      message: '磁盘空间不足，请清理磁盘后重新处理。',
      permanent: true,
      detail: raw,
      internal: false,
    }
  }
  return {
    code: ERROR_CODES.internal,
    message: '处理时发生内部错误，详情见日志。',
    permanent: true,
    detail: raw,
    internal: true,
  }
}
