import { parentPort } from 'node:worker_threads'

parentPort?.on('message', (msg: { id: number }) => {
  parentPort?.postMessage({
    id: msg.id,
    ok: false,
    error: { code: 'internal', message: 'compose worker is not implemented yet' },
  })
})
