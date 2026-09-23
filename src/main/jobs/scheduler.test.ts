import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { defaultTranslationRuntime } from '../../shared/types'
import { DocumentLibrary } from '../library/library'
import { Scheduler, type SchedulerEvent } from './scheduler'
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

  test('stop interrupts without cancelling: the document stays processing and resumes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'df-sched-'))
    const lib = new DocumentLibrary()
    await lib.open(dir)
    const doc = await queuedDoc(lib)
    const events: SchedulerEvent[] = []
    const scheduler = new Scheduler(lib, abortablePipeline, {
      concurrency: () => 1,
      onEvent: (_id, event) => {
        events.push(event)
        return Promise.resolve()
      },
    })
    await scheduler.tick()
    await expect.poll(() => scheduler.isRunning(doc.id)).toBe(true)
    await scheduler.stop()
    expect(lib.require(doc.id).status).toBe('processing')
    expect(events.map((event) => event.message)).not.toContain('已取消处理')

    const reopened = new DocumentLibrary()
    await reopened.open(dir)
    const next = new Scheduler(reopened, () => Promise.resolve(), { concurrency: () => 1 })
    await next.start()
    await expect.poll(() => reopened.require(doc.id).status).toBe('completed')
    await next.stop(0)
  })

  test('cancel leaves finished documents alone and records one event', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'df-sched-'))
    const lib = new DocumentLibrary()
    await lib.open(dir)
    const doc = await queuedDoc(lib)
    const events: string[] = []
    const scheduler = new Scheduler(lib, abortablePipeline, {
      concurrency: () => 1,
      onEvent: (_id, event) => {
        events.push(event.message)
        return Promise.resolve()
      },
    })
    await scheduler.tick()
    await expect.poll(() => scheduler.isRunning(doc.id)).toBe(true)
    await Promise.all([scheduler.cancel(doc.id), scheduler.cancel(doc.id)])
    expect(lib.require(doc.id).status).toBe('cancelled')
    expect(lib.require(doc.id).completedAt).not.toBeNull()
    expect(events.filter((message) => message === '已取消处理')).toHaveLength(1)

    await lib.update(doc.id, { status: 'completed', stage: 'done' })
    const after = await scheduler.cancel(doc.id)
    expect(after.status).toBe('completed')
    expect(events.filter((message) => message === '已取消处理')).toHaveLength(1)
    await scheduler.stop(0)
  })

  test('cancel and remove wait at most the grace period for a stuck task', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'df-sched-'))
    const lib = new DocumentLibrary()
    await lib.open(dir)
    const a = await queuedDoc(lib)
    const b = await queuedDoc(lib)
    const waits: number[] = []
    const stuck = new Set<string>()
    // Ignores the abort signal, like a stage that does not check it.
    const scheduler = new Scheduler(
      lib,
      (id) => {
        stuck.add(id)
        return new Promise<void>(() => undefined)
      },
      {
        concurrency: () => 2,
        delay: (ms) => {
          waits.push(ms)
          return Promise.resolve()
        },
      },
    )
    await scheduler.tick()
    await expect.poll(() => stuck.size).toBe(2)
    await scheduler.cancel(a.id)
    expect(lib.require(a.id).status).toBe('cancelled')
    await scheduler.remove(b.id)
    expect(lib.index.get(b.id)).toBeUndefined()
    expect(waits).toEqual([5_000, 5_000])
    await scheduler.stop(0)
  })

  test('retry clears the timing of the previous run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'df-sched-'))
    const lib = new DocumentLibrary()
    await lib.open(dir)
    const doc = await queuedDoc(lib)
    await lib.update(doc.id, {
      status: 'failed',
      startedAt: '2026-09-22T00:00:00.000Z',
      completedAt: '2026-09-22T00:10:00.000Z',
    })
    const scheduler = new Scheduler(lib, () => new Promise<void>(() => undefined), {
      concurrency: () => 0,
    })
    const saved = await scheduler.retry(doc.id, defaultTranslationRuntime())
    expect(saved.completedAt).toBeNull()
    expect(saved.startedAt).toBeNull()
    await scheduler.stop(0)
  })

  test('unexpected errors fail with a generic message; the original goes to detail and log', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'df-sched-'))
    const lib = new DocumentLibrary()
    await lib.open(dir)
    const doc = await queuedDoc(lib)
    const events: SchedulerEvent[] = []
    const logged: unknown[] = []
    const scheduler = new Scheduler(
      lib,
      () => Promise.reject(new TypeError("Cannot read properties of undefined (reading 'x')")),
      {
        concurrency: () => 1,
        onEvent: (_id, event) => {
          events.push(event)
          return Promise.resolve()
        },
        onInternalError: (_id, error) => {
          logged.push(error)
        },
      },
    )
    await scheduler.tick()
    await expect.poll(() => lib.require(doc.id).status).toBe('failed')
    expect(lib.require(doc.id).failure?.message).toBe('处理时发生内部错误，详情见日志。')
    const failed = events.find((event) => event.level === 'error')
    expect(failed?.message).toBe('处理失败：处理时发生内部错误，详情见日志。')
    expect(failed?.detail).toContain('Cannot read properties')
    expect(logged).toHaveLength(1)
    await scheduler.stop(0)
  })
})

function abortablePipeline(_id: string, signal: AbortSignal): Promise<void> {
  return new Promise<void>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new UserError('cancelled')), { once: true })
  })
}
