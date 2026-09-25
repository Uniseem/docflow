import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { PdfWorkerHost } from './worker-host'
import { ERROR_CODES, UserError } from '../../shared/errors'
import type { Logger } from '../log/logger'
import { mapFailure } from '../jobs/scheduler'

const hang = join(process.cwd(), 'tests/unit/hang-worker.mjs')
const echo = join(process.cwd(), 'tests/unit/echo-worker.mjs')
const scripted = join(process.cwd(), 'tests/unit/scripted-worker.mjs')

function memoryLogger(): Logger & { lines: string[] } {
  const lines: string[] = []
  const push = (level: string) => (message: string) => {
    lines.push(`${level} ${message}`)
  }
  return {
    lines,
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
  }
}

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

  test("cancelling one document's request re-runs the others on a fresh worker", async () => {
    const host = new PdfWorkerHost(scripted, 'analyze', 15_000, memoryLogger())
    const ac = new AbortController()
    const cancelled = host.request(
      { kind: 'analyze', path: 'never', layouts: [], pages: null, ocrWorkaround: false },
      5_000,
      ac.signal,
    )
    const other = host.request(
      { kind: 'analyze', path: 'slow:150', layouts: [], pages: null, ocrWorkaround: false },
      5_000,
    )
    await new Promise((resolve) => setTimeout(resolve, 30))
    ac.abort()
    await expect(cancelled).rejects.toMatchObject({ code: ERROR_CODES.cancelled })
    await expect(other).resolves.toBe('slow:150')
    host.kill()
  })

  test("one document's timeout does not fail the others", async () => {
    const host = new PdfWorkerHost(scripted, 'analyze', 15_000, memoryLogger())
    const timedOut = host.request({ kind: 'inspect', path: 'never' }, 100)
    const other = host.request({ kind: 'inspect', path: 'slow:250' }, 5_000)
    await expect(timedOut).rejects.toMatchObject({ code: 'inspect_timeout' })
    await expect(other).resolves.toBe('slow:250')
    host.kill()
  })

  test('an unexpected worker exception is logged with its stack and is a permanent internal error', async () => {
    const logger = memoryLogger()
    const host = new PdfWorkerHost(scripted, 'analyze', 15_000, logger)
    const error = await host
      .request(
        { kind: 'analyze', path: 'internal', layouts: [], pages: null, ocrWorkaround: false },
        5_000,
      )
      .then(
        () => undefined,
        (reason: unknown) => reason,
      )
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(UserError)
    expect(
      logger.lines.some((line) => line.startsWith('error') && line.includes('at scripted-worker')),
    ).toBe(true)
    const mapped = mapFailure(error)
    expect(mapped).toMatchObject({
      code: ERROR_CODES.internal,
      message: '处理时发生内部错误，详情见日志。',
      permanent: true,
      internal: true,
      detail: 'boom',
    })
    host.kill()
  })
})
