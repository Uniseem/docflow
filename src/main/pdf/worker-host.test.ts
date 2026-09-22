import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { PdfWorkerHost } from './worker-host'
import { ERROR_CODES } from '../../shared/errors'

const hang = join(process.cwd(), 'tests/unit/hang-worker.mjs')

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
})
