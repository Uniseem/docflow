import { Worker } from 'node:worker_threads'
import { pathToFileURL } from 'node:url'
import { PDF } from '../../shared/pdf-constants'
import { ERROR_CODES, UserError } from '../../shared/errors'
import type {
  AnalysisResult,
  ComposeRequest,
  PdfInspection,
  VerifyResult,
} from '../../shared/pdf-types'

export type WorkerJob =
  | { kind: 'inspect'; path: string }
  | { kind: 'analyze'; path: string; inspection?: PdfInspection }
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

export class PdfWorkerHost {
  private nextId = 1
  private worker: Worker | undefined
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void; timer: NodeJS.Timeout }
  >()

  constructor(
    private readonly workerPath: string,
    private readonly kind: PdfWorkerKind,
  ) {}

  async request<T>(message: WorkerJob, timeoutMs: number, signal?: AbortSignal): Promise<T> {
    const worker = this.ensureWorker()
    const id = this.nextId++
    const payload: WorkerRequest = { ...message, id }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.kill()
        const code = `${this.kind === 'compose' && message.kind === 'compose' ? 'compose' : message.kind}_timeout`
        reject(new UserError(code, undefined, false))
      }, timeoutMs)
      const onAbort = () => {
        this.pending.delete(id)
        clearTimeout(timer)
        this.kill()
        reject(new UserError(ERROR_CODES.cancelled))
      }
      if (signal?.aborted) {
        onAbort()
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener('abort', onAbort)
          clearTimeout(timer)
          resolve(value as T)
        },
        reject: (error: unknown) => {
          signal?.removeEventListener('abort', onAbort)
          clearTimeout(timer)
          reject(error instanceof Error ? error : new Error(String(error)))
        },
        timer,
      })
      worker.postMessage(payload)
    })
  }

  kill(): void {
    const worker = this.worker
    this.worker = undefined
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new UserError(ERROR_CODES.worker_crashed, undefined, false))
      this.pending.delete(id)
    }
    void worker?.terminate()
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    const worker = new Worker(pathToFileURL(this.workerPath))
    worker.on('message', (msg: WorkerResponse) => this.onMessage(msg))
    worker.on('error', (error) => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(error)
      }
      this.pending.clear()
      this.worker = undefined
    })
    worker.on('exit', () => {
      if (this.pending.size === 0) return
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(new UserError(ERROR_CODES.worker_crashed, undefined, false))
      }
      this.pending.clear()
      this.worker = undefined
    })
    this.worker = worker
    return worker
  }

  private onMessage(msg: WorkerResponse): void {
    if ('progress' in msg) return
    const pending = this.pending.get(msg.id)
    if (!pending) return
    this.pending.delete(msg.id)
    if (msg.ok) pending.resolve(msg.result)
    else pending.reject(new UserError(msg.error.code, msg.error.message))
  }
}

export const TIMEOUT = {
  inspect: PDF.TIMEOUT_INSPECT_MS,
  analyze: (pages: number) =>
    Math.max(PDF.TIMEOUT_ANALYZE_BASE_MS, pages * PDF.TIMEOUT_ANALYZE_PER_PAGE_MS),
  compose: (pages: number) =>
    Math.max(PDF.TIMEOUT_COMPOSE_BASE_MS, pages * PDF.TIMEOUT_COMPOSE_PER_PAGE_MS),
  verify: PDF.TIMEOUT_VERIFY_MS,
}

export type { AnalysisResult, VerifyResult }
