import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { PdfWorkerHost } from './worker-host'
import { ERROR_CODES } from '../../shared/errors'

const hang = join(process.cwd(), 'tests/unit/hang-worker.mjs')
const echo = join(process.cwd(), 'tests/unit/echo-worker.mjs')

describe('PdfWorkerHost', () => {
  test('terminates a hanging worker on timeout', async () => {
    const host = new PdfWorkerHost(hang, 'analyze')
    const started = Date.now()
    await expect(host.request({ kind: 'inspect', path: 'x' }, 200)).rejects.toMatchObject({
      code: 'inspect_timeout',
    })
    expect(Date.now() - started).toBeLessThan(2_000)
    host.kill()
  })

  test('cancel terminates the worker', async () => {
    const host = new PdfWorkerHost(hang, 'analyze')
    const ac = new AbortController()
    const pending = host.request({ kind: 'inspect', path: 'x' }, 5_000, ac.signal)
    ac.abort()
    await expect(pending).rejects.toMatchObject({ code: ERROR_CODES.cancelled })
    host.kill()
  })

  test('an idle worker exits and the next request starts a new one', async () => {
    const host = new PdfWorkerHost(echo, 'analyze', 50)
    await expect(host.request({ kind: 'inspect', path: 'x' }, 5_000)).resolves.toBe('inspect')
    expect(host.running).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(host.running).toBe(false)
    await expect(host.request({ kind: 'inspect', path: 'y' }, 5_000)).resolves.toBe('inspect')
    host.kill()
  })

  test('back-to-back requests reuse the worker', async () => {
    const host = new PdfWorkerHost(echo, 'analyze', 200)
    await host.request({ kind: 'inspect', path: 'x' }, 5_000)
    await new Promise((resolve) => setTimeout(resolve, 50))
    const pending = host.request({ kind: 'inspect', path: 'y' }, 5_000)
    await new Promise((resolve) => setTimeout(resolve, 180))
    expect(host.running).toBe(true)
    await pending
    host.kill()
  })
})
