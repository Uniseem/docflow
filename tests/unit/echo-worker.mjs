import { parentPort } from 'node:worker_threads'

parentPort?.on('message', (message) => {
  parentPort?.postMessage({ id: message.id, ok: true, result: message.kind })
})
