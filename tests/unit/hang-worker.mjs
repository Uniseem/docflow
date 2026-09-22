import { parentPort } from 'node:worker_threads'

parentPort?.on('message', () => {
  while (true) {
    // hang until terminated
  }
})
