import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { DocumentSummary, ProcessingEvent } from '../../shared/types'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))
vi.mock('../api/invoke', () => ({
  invoke: invokeMock,
  listen: () => () => undefined,
  hasApi: () => true,
}))

const {
  RELIST_THROTTLE_MS,
  adjacentDocumentId,
  mergeEvents,
  resetForLibraryChange,
  sortDocuments,
  useDocumentsStore,
} = await import('./documents')

function doc(id: string, patch: Partial<DocumentSummary> = {}): DocumentSummary {
  return {
    version: 1,
    id,
    title: `Paper ${id}`,
    titleCustom: false,
    originalFilename: `${id}.pdf`,
    sourceSize: 1000,
    sourceSha256: 'a'.repeat(64),
    pages: 3,
    translator: { providerId: 'p', model: 'm', label: 'P · m' },
    status: 'queued',
    stage: 'received',
    progress: 2,
    failure: null,
    attempts: 0,
    nextAttemptAt: null,
    stats: null,
    outputs: { mono: null, dual: null },
    createdAt: '2026-09-23T10:00:00.000Z',
    updatedAt: '2026-09-23T10:00:00.000Z',
    startedAt: null,
    completedAt: null,
    files: {},
    suggestedNames: { mono: 'm.pdf', dual: 'd.pdf', bundle: 'b.zip', source: 's.pdf' },
    running: false,
    ...patch,
  }
}

function event(seq: number): ProcessingEvent {
  return {
    seq,
    at: '2026-09-23T10:00:00.000Z',
    stage: 'translate',
    level: 'info',
    message: `e${seq}`,
  }
}

function seqs(id: string): number[] {
  return (useDocumentsStore.getState().events.get(id) ?? []).map((item) => item.seq)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function seed(
  items: DocumentSummary[],
  state: Partial<ReturnType<typeof useDocumentsStore.getState>> = {},
) {
  useDocumentsStore.setState({
    items: new Map(items.map((item) => [item.id, item])),
    ...state,
  })
}

beforeEach(() => {
  invokeMock.mockReset()
  resetForLibraryChange()
  useDocumentsStore.setState({
    items: new Map(),
    counts: { all: 0, active: 0, completed: 0, failed: 0 },
    filter: 'all',
    query: '',
    selectedId: null,
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('sortDocuments', () => {
  test('orders by createdAt then id, newest first, ignoring updatedAt', () => {
    const a = doc('20260923T100000-aaaaaa', {
      createdAt: '2026-09-23T10:00:00.000Z',
      updatedAt: '2026-09-23T12:00:00.000Z',
    })
    const b = doc('20260923T110000-bbbbbb', { createdAt: '2026-09-23T11:00:00.000Z' })
    const c = doc('20260923T110000-cccccc', { createdAt: '2026-09-23T11:00:00.000Z' })
    expect(sortDocuments([a, b, c]).map((item) => item.id)).toEqual([c.id, b.id, a.id])
  })

  test('adjacentDocumentId walks the same order and clamps at the ends', () => {
    const a = doc('a', { createdAt: '2026-09-23T10:00:00.000Z' })
    const b = doc('b', { createdAt: '2026-09-23T11:00:00.000Z' })
    const c = doc('c', { createdAt: '2026-09-23T12:00:00.000Z' })
    seed([a, b, c])
    expect(adjacentDocumentId(null, 1)).toBe('c')
    expect(adjacentDocumentId('c', 1)).toBe('b')
    expect(adjacentDocumentId('a', 1)).toBe('a')
    expect(adjacentDocumentId('b', -1)).toBe('c')
    expect(adjacentDocumentId('b', 'last')).toBe('a')
  })
})

describe('mergeEvents', () => {
  test('appends newer records', () => {
    expect(mergeEvents([event(1), event(2)], [event(3)]).map((item) => item.seq)).toEqual([1, 2, 3])
  })

  test('drops duplicates and sorts records that overlap or arrive out of order', () => {
    const merged = mergeEvents([event(2), event(5)], [event(4), event(2), event(3)])
    expect(merged.map((item) => item.seq)).toEqual([2, 3, 4, 5])
  })

  test('keeps the newest records when over the cap', () => {
    const merged = mergeEvents([event(1), event(2)], [event(3), event(4)], 3)
    expect(merged.map((item) => item.seq)).toEqual([2, 3, 4])
  })

  test('returns the same array when nothing arrives', () => {
    const prev = [event(1)]
    expect(mergeEvents(prev, [])).toBe(prev)
  })
})

describe('processing records', () => {
  test('ensureEvents loads once and keeps pushes that arrive during the request', async () => {
    const response = deferred<{ items: ProcessingEvent[]; lastSeq: number }>()
    invokeMock.mockImplementation((channel: string) => {
      if (channel === 'documents:events') return response.promise
      throw new Error(`unexpected ${channel}`)
    })
    const store = useDocumentsStore.getState()
    store.appendEvent('a', event(5))
    const first = store.ensureEvents('a')
    const second = store.ensureEvents('a')
    store.appendEvent('a', event(6))
    response.resolve({ items: [event(3), event(4), event(5)], lastSeq: 5 })
    await Promise.all([first, second])

    expect(invokeMock).toHaveBeenCalledTimes(1)
    expect(invokeMock).toHaveBeenCalledWith('documents:events', { id: 'a', limit: 500 })
    expect(seqs('a')).toEqual([3, 4, 5, 6])
    expect(useDocumentsStore.getState().eventCursors.get('a')).toBe(6)

    await useDocumentsStore.getState().ensureEvents('a')
    expect(invokeMock).toHaveBeenCalledTimes(1)
  })

  test('a pushed record is never added twice', () => {
    const store = useDocumentsStore.getState()
    store.appendEvent('a', event(1))
    store.appendEvent('a', event(2))
    const before = useDocumentsStore.getState().events.get('a')
    store.appendEvent('a', event(1))
    expect(useDocumentsStore.getState().events.get('a')).toBe(before)
    expect(seqs('a')).toEqual([1, 2])
  })

  test('the cursor never moves backwards', async () => {
    invokeMock.mockResolvedValue({ items: [event(1), event(2)], lastSeq: 2 })
    useDocumentsStore.getState().appendEvent('a', event(9))
    await useDocumentsStore.getState().loadEvents('a')
    expect(useDocumentsStore.getState().eventCursors.get('a')).toBe(9)
    expect(seqs('a')).toEqual([1, 2, 9])
  })

  test('a failed load can be retried', async () => {
    invokeMock.mockRejectedValueOnce(Object.assign(new Error('找不到'), { user: true }))
    await useDocumentsStore.getState().ensureEvents('a')
    expect(useDocumentsStore.getState().eventsLoaded.has('a')).toBe(false)
    invokeMock.mockResolvedValueOnce({ items: [event(1)], lastSeq: 1 })
    await useDocumentsStore.getState().ensureEvents('a')
    expect(seqs('a')).toEqual([1])
  })

  test('a response for the previous library is dropped', async () => {
    const response = deferred<{ items: ProcessingEvent[]; lastSeq: number }>()
    invokeMock.mockReturnValue(response.promise)
    const pending = useDocumentsStore.getState().ensureEvents('a')
    resetForLibraryChange()
    response.resolve({ items: [event(1)], lastSeq: 1 })
    await pending
    expect(useDocumentsStore.getState().events.has('a')).toBe(false)
    expect(useDocumentsStore.getState().eventsLoaded.has('a')).toBe(false)
  })
})

describe('upsert', () => {
  test('without a filter the counts follow the list', () => {
    const store = useDocumentsStore.getState()
    store.upsert(doc('a', { status: 'processing' }))
    store.upsert(doc('b', { status: 'completed' }))
    store.upsert(doc('a', { status: 'processing', progress: 50 }))
    expect(useDocumentsStore.getState().counts).toEqual({
      all: 2,
      active: 1,
      completed: 1,
      failed: 0,
    })
    expect(invokeMock).not.toHaveBeenCalled()
  })

  test('a document that does not match the search stays out of the list and the counts', () => {
    useDocumentsStore.setState({ query: 'attention' })
    const store = useDocumentsStore.getState()
    store.upsert(doc('a', { title: 'Attention Is All You Need' }))
    store.upsert(doc('b', { title: 'Chain of Thought' }))
    store.upsert(doc('b', { title: 'Chain of Thought', progress: 40 }))
    const state = useDocumentsStore.getState()
    expect([...state.items.keys()]).toEqual(['a'])
    expect(state.counts.all).toBe(1)
  })

  test('with a filter, progress updates stay local and group changes refresh from main', async () => {
    vi.useFakeTimers()
    invokeMock.mockResolvedValue({
      items: [],
      counts: { all: 2, active: 0, completed: 2, failed: 0 },
    })
    seed([doc('a', { status: 'processing', progress: 40 })], {
      filter: 'active',
      counts: { all: 2, active: 1, completed: 1, failed: 0 },
    })
    const store = useDocumentsStore.getState()

    store.upsert(doc('a', { status: 'processing', progress: 60 }))
    expect(useDocumentsStore.getState().items.get('a')?.progress).toBe(60)
    await vi.advanceTimersByTimeAsync(RELIST_THROTTLE_MS)
    expect(invokeMock).not.toHaveBeenCalled()

    store.upsert(doc('a', { status: 'completed', progress: 100 }))
    store.upsert(doc('b', { status: 'queued' }))
    // Leaves the filtered list right away; counts are not guessed locally.
    expect(useDocumentsStore.getState().items.has('a')).toBe(false)
    expect(useDocumentsStore.getState().counts.completed).toBe(1)
    await vi.advanceTimersByTimeAsync(RELIST_THROTTLE_MS)
    expect(invokeMock).toHaveBeenCalledTimes(1)
    expect(invokeMock).toHaveBeenCalledWith('documents:list', { filter: 'active' })
    expect(useDocumentsStore.getState().counts).toEqual({
      all: 2,
      active: 0,
      completed: 2,
      failed: 0,
    })
  })
})

describe('remove', () => {
  test('selects the row below the removed one and recounts', () => {
    const a = doc('a', { createdAt: '2026-09-23T12:00:00.000Z' })
    const b = doc('b', { createdAt: '2026-09-23T11:00:00.000Z' })
    const c = doc('c', { createdAt: '2026-09-23T10:00:00.000Z' })
    seed([a, b, c], { selectedId: 'b' })
    useDocumentsStore.getState().appendEvent('b', event(1))
    useDocumentsStore.getState().remove('b')
    const state = useDocumentsStore.getState()
    expect(state.selectedId).toBe('c')
    expect(state.counts.all).toBe(2)
    expect(state.events.has('b')).toBe(false)
  })

  test('selects the row above when the last row is removed', () => {
    const a = doc('a', { createdAt: '2026-09-23T12:00:00.000Z' })
    const b = doc('b', { createdAt: '2026-09-23T11:00:00.000Z' })
    seed([a, b], { selectedId: 'b' })
    useDocumentsStore.getState().remove('b')
    expect(useDocumentsStore.getState().selectedId).toBe('a')
  })
})

describe('list', () => {
  test('only the newest response is applied', async () => {
    const slow = deferred<unknown>()
    const fast = deferred<unknown>()
    invokeMock.mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise)
    const first = useDocumentsStore.getState().list()
    useDocumentsStore.setState({ filter: 'completed' })
    const second = useDocumentsStore.getState().list()
    fast.resolve({
      items: [doc('done', { status: 'completed' })],
      counts: { all: 2, active: 1, completed: 1, failed: 0 },
    })
    await second
    slow.resolve({
      items: [doc('old')],
      counts: { all: 9, active: 9, completed: 0, failed: 0 },
    })
    await first
    const state = useDocumentsStore.getState()
    expect([...state.items.keys()]).toEqual(['done'])
    expect(state.counts.all).toBe(2)
    expect(state.selectedId).toBe('done')
  })
})
