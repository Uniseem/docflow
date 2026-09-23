import { parentPort } from 'node:worker_threads'

// The request path picks the behaviour: 'never' never answers, 'internal' fails like an
// unexpected exception inside the worker, 'slow:<ms>' answers after <ms>, anything else
// answers at once. Requests are handled concurrently, like the real workers.
parentPort?.on('message', (message) => {
  const path = typeof message.path === 'string' ? message.path : ''
  if (path === 'never') return
  if (path === 'internal') {
    parentPort?.postMessage({
      id: message.id,
      ok: false,
      error: { code: 'internal', message: 'boom', stack: 'Error: boom\n    at scripted-worker' },
    })
    return
  }
  const delay = path.startsWith('slow:') ? Number(path.slice(5)) : 0
  setTimeout(() => parentPort?.postMessage({ id: message.id, ok: true, result: path }), delay)
})
