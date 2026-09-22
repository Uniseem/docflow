import { parentPort } from 'node:worker_threads'
import { composePdf } from '../pdf/compose'
import { isUserError } from '../../shared/errors'
import type { WorkerRequest, WorkerResponse } from '../pdf/worker-host'

parentPort?.on('message', (msg: WorkerRequest) => {
  void handle(msg)
})

async function handle(msg: WorkerRequest): Promise<void> {
  try {
    if (msg.kind !== 'compose') throw new Error(`compose worker got ${msg.kind}`)
    const result = await composePdf(msg.request)
    post({ id: msg.id, ok: true, result })
  } catch (error) {
    const code = isUserError(error) ? error.code : 'internal'
    const message = error instanceof Error ? error.message : String(error)
    const stack = error instanceof Error ? error.stack : undefined
    post({
      id: msg.id,
      ok: false,
      error: stack ? { code, message, stack } : { code, message },
    })
  }
}

function post(msg: WorkerResponse): void {
  parentPort?.postMessage(msg)
}
