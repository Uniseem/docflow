import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { defaultTranslationRuntime } from '../../shared/types'
import { DocumentLibrary } from '../library/library'
import { Scheduler } from './scheduler'
import { UserError } from '../../shared/errors'

const translator = { providerId: 'p', model: 'm', label: 'P · m' }

async function queuedDoc(lib: DocumentLibrary) {
  const pdf = join(lib.dir, 'a.pdf')
  await writeFile(pdf, '%PDF-1.4\n')
  return lib.create({
    path: pdf,
    title: 'Doc',
    translator,
    settingsSnapshot: defaultTranslationRuntime(),
  })
}

describe('Scheduler', () => {
  test('caps in-flight work at concurrency', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'df-sched-'))
    const lib = new DocumentLibrary()
    await lib.open(dir)
    const a = await queuedDoc(lib)
    const b = await queuedDoc(lib)
    const started: string[] = []
    const release = new Map<string, () => void>()
    const scheduler = new Scheduler(
      lib,
      (id) =>
        new Promise((resolve) => {
          started.push(id)
          release.set(id, resolve)
        }),
      { concurrency: () => 1 },
    )
    await scheduler.tick()
    await expect.poll(() => started.length).toBe(1)
    expect(scheduler.isRunning(started[0]!)).toBe(true)
    release.get(started[0]!)?.()
    await expect.poll(() => started.length).toBe(2)
    void a
    void b
    await scheduler.stop(0)
  })

  test('retries retryable failures with backoff', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'df-sched-'))
    const lib = new DocumentLibrary()
    await lib.open(dir)
    const doc = await queuedDoc(lib)
    let now = Date.parse('2026-09-22T00:00:00Z')
    let calls = 0
    const scheduler = new Scheduler(
      lib,
      () => {
        calls += 1
        return Promise.reject(new UserError('verify_failed', 'x', false))
      },
      { concurrency: () => 1, now: () => now },
    )
    await scheduler.tick()
    await expect.poll(() => lib.require(doc.id).status).toBe('retrying')
    expect(calls).toBe(1)
    now += 60_000
    await scheduler.tick()
    await expect.poll(() => calls).toBe(2)
    await scheduler.stop(0)
  })

  test('cancel aborts a running job', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'df-sched-'))
    const lib = new DocumentLibrary()
    await lib.open(dir)
    const doc = await queuedDoc(lib)
    const scheduler = new Scheduler(
      lib,
      async (_id, signal) => {
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener('abort', () => reject(new UserError('cancelled')), { once: true })
        })
      },
      { concurrency: () => 1 },
    )
    await scheduler.tick()
    await expect.poll(() => scheduler.isRunning(doc.id)).toBe(true)
    await scheduler.cancel(doc.id)
    expect(lib.require(doc.id).status).toBe('cancelled')
    await scheduler.stop(0)
  })

  test('recover processing documents back to queued', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'df-sched-'))
    const lib = new DocumentLibrary()
    await lib.open(dir)
    const doc = await queuedDoc(lib)
    await lib.update(doc.id, { status: 'processing' })
    const scheduler = new Scheduler(lib, () => Promise.resolve(), { concurrency: () => 1 })
    await scheduler.start()
    expect(lib.require(doc.id).status === 'queued' || scheduler.isRunning(doc.id)).toBe(true)
    await scheduler.stop(0)
  })
})
