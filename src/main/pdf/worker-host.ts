import { Worker } from 'node:worker_threads'
import { pathToFileURL } from 'node:url'
import { PDF } from '../../shared/pdf-constants'
import { ERROR_CODES, UserError } from '../../shared/errors'
import type {
  AnalysisResult,
  ComposeRequest,
  PageLayout,
  VerifyResult,
} from '../../shared/pdf-types'
import { createLogger, type Logger } from '../log/logger'

export type WorkerJob =
  | { kind: 'inspect'; path: string }
  | { kind: 'analyze'; path: string; layouts: PageLayout[] }
  | { kind: 'detect'; path: string; index: number; modelPath: string }
  | {
      kind: 'verify'
      monoPath: string
      dualPath: string | null
      pages: number
      writtenPages: number[]
    }
  | { kind: 'compose'; request: ComposeRequest }

export type WorkerRequest = WorkerJob & { id: number }

export type WorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { code: string; message: string; stack?: string } }
  | { id: number; progress: { current: number; total: number } }

export type PdfWorkerKind = 'analyze' | 'compose'

/** A worker with nothing to do exits after this long, giving its heap back to the OS. */
export const WORKER_IDLE_MS = 15_000

type Pending = {
  payload: WorkerRequest
  /** Starts (or restarts) the request's timeout clock. */
  arm: () => NodeJS.Timeout
  timer: NodeJS.Timeout
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

export class PdfWorkerHost {
  private nextId = 1
  private worker: Worker | undefined
  private idleTimer: NodeJS.Timeout | undefined
  private readonly pending = new Map<number, Pending>()

  constructor(
    private readonly workerPath: string,
    private readonly kind: PdfWorkerKind,
    private readonly idleMs = WORKER_IDLE_MS,
    private readonly logger: Logger = createLogger('pdf-worker'),
  ) {}

  async request<T>(message: WorkerJob, timeoutMs: number, signal?: AbortSignal): Promise<T> {
    // Already cancelled: never touch the shared thread, other documents may be using it.
    if (signal?.aborted) throw new UserError(ERROR_CODES.cancelled)
    this.cancelIdle()
    const worker = this.ensureWorker()
    const id = this.nextId++
    const payload: WorkerRequest = { ...message, id }
    return new Promise<T>((resolve, reject) => {
      const cleanup = () => {
        signal?.removeEventListener('abort', onAbort)
        const entry = this.pending.get(id)
        if (entry) clearTimeout(entry.timer)
        this.pending.delete(id)
      }
      const onTimeout = () => {
        cleanup()
        this.abandon()
        const code = `${this.kind === 'compose' && message.kind === 'compose' ? 'compose' : message.kind}_timeout`
        reject(new UserError(code, undefined, false))
      }
      const onAbort = () => {
        cleanup()
        this.abandon()
        reject(new UserError(ERROR_CODES.cancelled))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      const arm = () => setTimeout(onTimeout, timeoutMs)
      this.pending.set(id, {
        payload,
        arm,
        timer: arm(),
        resolve: (value) => {
          cleanup()
          this.scheduleIdle()
          resolve(value as T)
        },
        reject: (error: unknown) => {
          cleanup()
          this.scheduleIdle()
          reject(error instanceof Error ? error : new Error(String(error)))
        },
      })
      worker.postMessage(payload)
    })
  }

  /** Whether a worker thread is alive (tests). */
  get running(): boolean {
    return this.worker !== undefined
  }

  kill(): void {
    this.cancelIdle()
    const worker = this.worker
    this.worker = undefined
    this.failAll(new UserError(ERROR_CODES.worker_crashed, undefined, false))
    void worker?.terminate()
  }

  /**
   * A request was cancelled or timed out: the only way to stop it is to terminate the
   * thread. The other requests on that thread were not cancelled, so they run again from
   * scratch (with a fresh timeout) on a new thread instead of failing.
   */
  private abandon(): void {
    const worker = this.worker
    this.worker = undefined
    void worker?.terminate()
    if (this.pending.size === 0) {
      this.cancelIdle()
      return
    }
    const fresh = this.ensureWorker()
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.timer = entry.arm()
      fresh.postMessage(entry.payload)
    }
  }

  private failAll(error: Error): void {
    for (const entry of [...this.pending.values()]) entry.reject(error)
  }

  // pdf.js caches and the parsed CJK font stay in a worker's heap; between documents the
  // worker exits instead of holding hundreds of MB. Back-to-back stages reuse it.
  private scheduleIdle(): void {
    if (this.pending.size > 0 || !this.worker) return
    this.cancelIdle()
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined
      if (this.pending.size === 0) this.kill()
    }, this.idleMs)
    this.idleTimer.unref()
  }

  private cancelIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = undefined
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    const worker = new Worker(pathToFileURL(this.workerPath))
    worker.on('message', (msg: WorkerResponse) => this.onMessage(msg))
    // A terminated thread still emits `exit` later; by then its requests were moved to a
    // new thread, so only the current thread may fail them.
    worker.on('error', (thrown: unknown) => {
      if (this.worker !== worker) return
      this.worker = undefined
      const error = thrown instanceof Error ? thrown : new Error(String(thrown))
      this.logger.error(`${this.kind} worker threw: ${error.stack ?? error.message}`)
      this.failAll(error)
    })
    worker.on('exit', (exitCode) => {
      if (this.worker !== worker) return
      this.worker = undefined
      if (this.pending.size === 0) return
      this.logger.error(`${this.kind} worker exited unexpectedly (code ${exitCode})`)
      this.failAll(new UserError(ERROR_CODES.worker_crashed, undefined, false))
    })
    this.worker = worker
    return worker
  }

  private onMessage(msg: WorkerResponse): void {
    if ('progress' in msg) return
    const pending = this.pending.get(msg.id)
    if (!pending) return
    if (msg.ok) {
      pending.resolve(msg.result)
      return
    }
    const { code, message, stack } = msg.error
    const job = pending.payload.kind
    this.logger[code === ERROR_CODES.internal ? 'error' : 'warn'](
      `${job} failed [${code}]: ${stack ?? message}`,
    )
    if (code === ERROR_CODES.internal) {
      // Not a UserError inside the worker: a bug, not something the user can act on.
      // Rejecting with a plain Error makes the scheduler show the generic internal-error
      // text, keep the raw message as detail, log the stack and not retry.
      const error = new Error(message)
      if (stack) error.stack = stack
      pending.reject(error)
      return
    }
    pending.reject(new UserError(code, message))
  }
}

export const TIMEOUT = {
  inspect: PDF.TIMEOUT_INSPECT_MS,
  analyze: (pages: number) =>
    Math.max(PDF.TIMEOUT_ANALYZE_BASE_MS, pages * PDF.TIMEOUT_ANALYZE_PER_PAGE_MS),
  compose: (pages: number) =>
    Math.max(PDF.TIMEOUT_COMPOSE_BASE_MS, pages * PDF.TIMEOUT_COMPOSE_PER_PAGE_MS),
  verify: PDF.TIMEOUT_VERIFY_MS,
  detect: PDF.TIMEOUT_DETECT_PAGE_MS,
}

export type { AnalysisResult, VerifyResult }
