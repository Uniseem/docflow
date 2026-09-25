import { parentPort } from 'node:worker_threads'
import { inspectPdf } from '../pdf/inspect'
import { analyzePdf } from '../pdf/analyze'
import { verifyPdf } from '../pdf/verify'
import { detectPage } from '../pdf/pdf2zh/detect'
import { isUserError } from '../../shared/errors'
import type { WorkerRequest, WorkerResponse } from '../pdf/worker-host'

parentPort?.on('message', (msg: WorkerRequest) => {
  void handle(msg)
})

async function handle(msg: WorkerRequest): Promise<void> {
  try {
    let result: unknown
    switch (msg.kind) {
      case 'inspect':
        result = await inspectPdf(msg.path)
        break
      case 'analyze':
        result = await analyzePdf(msg.path, msg.layouts)
        break
      case 'detect':
        result = await detectPage(msg.path, msg.index, msg.modelPath)
        break
      case 'verify':
        result = await verifyPdf(msg)
        break
      case 'compose':
        throw new Error('compose belongs to the compose worker')
    }
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
