import { describe, expect, test } from 'vitest'
import type { DocumentStatus, ProcessingEvent, Stage } from '../../../shared/types'
import { STAGES } from '../../lib/labels'
import { elapsedMs, latestEvent, stageState } from './progress'

function states(status: DocumentStatus, stage: Stage) {
  return Object.fromEntries(STAGES.map((info) => [info.id, stageState({ status, stage }, info.id)]))
}

describe('stageState', () => {
  test('the manifest stage is the running one', () => {
    expect(states('processing', 'analyze')).toEqual({
      received: 'done',
      inspect: 'done',
      analyze: 'running',
      translate: 'waiting',
      compose: 'waiting',
      verify: 'waiting',
      archive: 'waiting',
    })
  })

  test('a queued document waits in the first stage', () => {
    expect(stageState({ status: 'queued', stage: 'received' }, 'received')).toBe('running')
    expect(stageState({ status: 'queued', stage: 'received' }, 'inspect')).toBe('waiting')
  })

  test('failure and cancellation mark the stage they stopped in', () => {
    // A key error fails in translate, not in the analyze stage that finished before it.
    expect(stageState({ status: 'failed', stage: 'translate' }, 'analyze')).toBe('done')
    expect(stageState({ status: 'failed', stage: 'translate' }, 'translate')).toBe('failed')
    expect(stageState({ status: 'failed', stage: 'translate' }, 'compose')).toBe('waiting')
    expect(stageState({ status: 'cancelled', stage: 'compose' }, 'compose')).toBe('cancelled')
  })

  test('retrying keeps the stage running and done covers everything', () => {
    expect(stageState({ status: 'retrying', stage: 'translate' }, 'translate')).toBe('running')
    expect(states('completed', 'done')).toEqual(
      Object.fromEntries(STAGES.map((info) => [info.id, 'done'])),
    )
  })
})

describe('elapsedMs', () => {
  const base = {
    createdAt: '2026-09-23T10:00:00.000Z',
    startedAt: '2026-09-23T10:01:00.000Z',
    completedAt: null,
    updatedAt: '2026-09-23T10:03:00.000Z',
  }
  const now = Date.parse('2026-09-23T10:10:00.000Z')

  test('active documents run up to now', () => {
    expect(elapsedMs({ ...base, status: 'processing' }, now)).toBe(9 * 60_000)
    expect(elapsedMs({ ...base, status: 'retrying' }, now)).toBe(9 * 60_000)
  })

  test('finished documents stop at completedAt, or their last update', () => {
    const completedAt = '2026-09-23T10:05:00.000Z'
    expect(elapsedMs({ ...base, status: 'failed', completedAt }, now)).toBe(4 * 60_000)
    expect(elapsedMs({ ...base, status: 'cancelled' }, now)).toBe(2 * 60_000)
    expect(elapsedMs({ ...base, status: 'completed', completedAt }, now)).toBe(4 * 60_000)
  })

  test('a document that never started has no processing time', () => {
    const waiting = { ...base, status: 'queued' as const, startedAt: null }
    expect(elapsedMs(waiting, now)).toBeNull()
    expect(elapsedMs(waiting, now, { fromCreated: true })).toBe(10 * 60_000)
  })
})

test('latestEvent picks the highest seq', () => {
  const event = (seq: number): ProcessingEvent => ({
    seq,
    at: '2026-09-23T10:00:00.000Z',
    stage: 'translate',
    level: 'info',
    message: `#${seq}`,
  })
  expect(latestEvent([event(3), event(7), event(5)])?.seq).toBe(7)
  expect(latestEvent([])).toBeUndefined()
})
