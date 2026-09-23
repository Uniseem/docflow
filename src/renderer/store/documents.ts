import { create } from 'zustand'
import type { ChannelResponse } from '../../shared/ipc'
import type { DocumentSummary, ProcessingEvent } from '../../shared/types'
import { MAX_EVENTS, SEARCH_DEBOUNCE_MS } from '../../shared/constants'
import {
  matchesFilter,
  matchesQuery,
  statusBucket,
  type LibraryFilter,
} from '../../shared/library-filter'
import { invoke, listen } from '../api/invoke'
import { notifyError } from '../lib/notify'
import { useSettingsStore } from './settings'
import { useUiStore } from './ui'

export type { LibraryFilter }

export type Counts = { all: number; active: number; completed: number; failed: number }

type DocumentsState = {
  items: Map<string, DocumentSummary>
  counts: Counts
  filter: LibraryFilter
  query: string
  selectedId: string | null
  /** Processing records per document, ascending by seq, without duplicates. */
  events: Map<string, ProcessingEvent[]>
  /** Highest seq seen per document; only ever increases. */
  eventCursors: Map<string, number>
  /** Documents whose history (latest 500 records) has been fetched. */
  eventsLoaded: Set<string>
  setFilter: (filter: LibraryFilter) => void
  setQuery: (query: string) => void
  select: (id: string | null) => void
  list: () => Promise<void>
  upsert: (item: DocumentSummary) => void
  remove: (id: string) => void
  /** Fetches the latest 500 records and merges them with what is already known. */
  loadEvents: (id: string) => Promise<void>
  /** Loads a document's processing records once (latest 500), merged with pushed events by seq. */
  ensureEvents: (id: string) => Promise<void>
  appendEvent: (id: string, event: ProcessingEvent) => void
}

export const EVENTS_FIRST_LOAD = 500
/** With a filter or search active the counts come from the main process; refresh at most this often. */
export const RELIST_THROTTLE_MS = 400

const emptyCounts: Counts = { all: 0, active: 0, completed: 0, failed: 0 }
const NO_EVENTS: ProcessingEvent[] = []

let queryTimer: ReturnType<typeof setTimeout> | undefined
let relistTimer: ReturnType<typeof setTimeout> | undefined
// Only the newest documents:list response is applied.
let listSeq = 0
// Bumped on library change so that responses for the previous library are dropped.
let libraryEpoch = 0
const eventLoads = new Map<string, Promise<void>>()

/** Library order (05 §5.4): newest first by createdAt, then id; progress never moves a row. */
export function compareDocuments(a: DocumentSummary, b: DocumentSummary): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1
  if (a.id !== b.id) return a.id < b.id ? 1 : -1
  return 0
}

export function sortDocuments(items: Iterable<DocumentSummary>): DocumentSummary[] {
  return [...items].sort(compareDocuments)
}

/** Merges records by seq (ascending, later copies win) and keeps the newest `cap`. */
export function mergeEvents(
  prev: ProcessingEvent[],
  incoming: readonly ProcessingEvent[],
  cap = MAX_EVENTS,
): ProcessingEvent[] {
  if (incoming.length === 0) return prev
  let merged: ProcessingEvent[]
  const last = prev.at(-1)?.seq ?? 0
  const appendOnly =
    (incoming[0]?.seq ?? 0) > last &&
    incoming.every((event, index) => index === 0 || event.seq > (incoming[index - 1]?.seq ?? 0))
  if (appendOnly) {
    merged = [...prev, ...incoming]
  } else {
    const bySeq = new Map<number, ProcessingEvent>()
    for (const event of prev) bySeq.set(event.seq, event)
    for (const event of incoming) bySeq.set(event.seq, event)
    merged = [...bySeq.values()].sort((a, b) => a.seq - b.seq)
  }
  return merged.length > cap ? merged.slice(-cap) : merged
}

function recount(items: Map<string, DocumentSummary>): Counts {
  const counts: Counts = { all: items.size, active: 0, completed: 0, failed: 0 }
  for (const item of items.values()) counts[statusBucket(item.status)] += 1
  return counts
}

function decrementCount(counts: Counts, item: DocumentSummary): Counts {
  const key = statusBucket(item.status)
  return { ...counts, all: Math.max(0, counts.all - 1), [key]: Math.max(0, counts[key] - 1) }
}

/** The row that takes the removed row's place: the next one down, else the one above. */
function neighborOf(items: Map<string, DocumentSummary>, id: string): string | null {
  const sorted = sortDocuments(items.values())
  const index = sorted.findIndex((item) => item.id === id)
  if (index < 0) return sorted[0]?.id ?? null
  return sorted[index + 1]?.id ?? sorted[index - 1]?.id ?? null
}

function scheduleRelist(): void {
  if (relistTimer) return
  relistTimer = setTimeout(() => {
    relistTimer = undefined
    void useDocumentsStore.getState().list()
  }, RELIST_THROTTLE_MS)
}

export const useDocumentsStore = create<DocumentsState>((set, get) => ({
  items: new Map(),
  counts: emptyCounts,
  filter: 'all',
  query: '',
  selectedId: null,
  events: new Map(),
  eventCursors: new Map(),
  eventsLoaded: new Set(),
  setFilter: (filter) => {
    set({ filter })
    void get().list()
  },
  setQuery: (query) => {
    set({ query })
    if (queryTimer) clearTimeout(queryTimer)
    queryTimer = setTimeout(() => {
      void get().list()
    }, SEARCH_DEBOUNCE_MS)
  },
  select: (selectedId) => {
    set({ selectedId })
  },
  list: async () => {
    if (relistTimer) {
      clearTimeout(relistTimer)
      relistTimer = undefined
    }
    const seq = (listSeq += 1)
    const { filter, query } = get()
    const q = query.trim()
    let result: ChannelResponse<'documents:list'>
    try {
      result = await invoke('documents:list', q ? { filter, query: q } : { filter })
    } catch (error) {
      if (seq === listSeq) notifyError(error)
      return
    }
    if (seq !== listSeq) return
    const items = new Map<string, DocumentSummary>()
    for (const item of result.items) items.set(item.id, item)
    const selectedId = get().selectedId
    const keep = selectedId !== null && items.has(selectedId)
    set({
      items,
      counts: result.counts,
      selectedId: keep ? selectedId : (sortDocuments(result.items)[0]?.id ?? null),
    })
  },
  upsert: (item) => {
    const state = get()
    const previous = state.items.get(item.id)
    const visible = matchesFilter(item.status, state.filter) && matchesQuery(item, state.query)
    const items = new Map(state.items)
    if (visible) items.set(item.id, item)
    else items.delete(item.id)
    const selectedId = state.selectedId ?? (visible ? item.id : null)
    if (state.filter === 'all') {
      // The list holds every document matching the search, so the counts follow from it.
      set({ items, counts: recount(items), selectedId })
      return
    }
    // A filtered list cannot recount the other groups: show the change now and let a
    // throttled list() bring counts and membership up to date. Progress updates of a row
    // that stays in the same group need neither.
    set({ items, selectedId })
    const sameGroup =
      previous !== undefined &&
      visible &&
      statusBucket(previous.status) === statusBucket(item.status)
    if (!sameGroup) scheduleRelist()
  },
  remove: (id) => {
    const state = get()
    const removed = state.items.get(id)
    const items = new Map(state.items)
    items.delete(id)
    const events = new Map(state.events)
    events.delete(id)
    const eventCursors = new Map(state.eventCursors)
    eventCursors.delete(id)
    const eventsLoaded = new Set(state.eventsLoaded)
    eventsLoaded.delete(id)
    let counts = state.counts
    if (state.filter === 'all') counts = recount(items)
    else if (removed) counts = decrementCount(state.counts, removed)
    else scheduleRelist()
    set({
      items,
      events,
      eventCursors,
      eventsLoaded,
      counts,
      selectedId: state.selectedId === id ? neighborOf(state.items, id) : state.selectedId,
    })
  },
  loadEvents: async (id) => {
    const epoch = libraryEpoch
    const result = await invoke('documents:events', { id, limit: EVENTS_FIRST_LOAD })
    if (epoch !== libraryEpoch) return
    set((state) => {
      // Records pushed while the request was in flight are kept: merge, never replace.
      const merged = mergeEvents(state.events.get(id) ?? NO_EVENTS, result.items)
      const events = new Map(state.events)
      events.set(id, merged)
      const eventCursors = new Map(state.eventCursors)
      eventCursors.set(
        id,
        Math.max(state.eventCursors.get(id) ?? 0, result.lastSeq, merged.at(-1)?.seq ?? 0),
      )
      const eventsLoaded = new Set(state.eventsLoaded)
      eventsLoaded.add(id)
      return { events, eventCursors, eventsLoaded }
    })
  },
  ensureEvents: async (id) => {
    if (get().eventsLoaded.has(id)) return
    const key = `${libraryEpoch}:${id}`
    let pending = eventLoads.get(key)
    if (!pending) {
      pending = get()
        .loadEvents(id)
        // invoke() already reported internal errors; a document deleted meanwhile is not news.
        .catch(() => undefined)
        .finally(() => eventLoads.delete(key))
      eventLoads.set(key, pending)
    }
    await pending
  },
  appendEvent: (id, event) => {
    set((state) => {
      const prev = state.events.get(id) ?? NO_EVENTS
      const last = prev.at(-1)?.seq ?? 0
      if (event.seq <= last && prev.some((item) => item.seq === event.seq)) return state
      const events = new Map(state.events)
      events.set(id, mergeEvents(prev, [event]))
      const eventCursors = new Map(state.eventCursors)
      eventCursors.set(id, Math.max(state.eventCursors.get(id) ?? 0, event.seq))
      return { events, eventCursors }
    })
  },
}))

/** Drops everything tied to the previous library (records, selection, pending loads). */
export function resetForLibraryChange(): void {
  libraryEpoch += 1
  eventLoads.clear()
  useDocumentsStore.setState({
    selectedId: null,
    events: new Map(),
    eventCursors: new Map(),
    eventsLoaded: new Set(),
  })
}

export function subscribeDocuments(): () => void {
  const offChanged = listen('document:changed', (item) => {
    useDocumentsStore.getState().upsert(item)
  })
  const offRemoved = listen('document:removed', ({ id }) => {
    useDocumentsStore.getState().remove(id)
  })
  const offEvent = listen('document:event', (payload) => {
    const { documentId, ...event } = payload
    useDocumentsStore.getState().appendEvent(documentId, event)
  })
  const offLibrary = listen('library:changed', ({ libraryDir }) => {
    resetForLibraryChange()
    const info = useUiStore.getState().appInfo
    if (info) useUiStore.getState().setAppInfo({ ...info, libraryDir })
    void useDocumentsStore.getState().list()
    void useSettingsStore.getState().load()
  })
  // Whatever changes the selection (click, arrow keys, list(), remove, library change), the
  // selected document gets its processing records.
  const offSelection = useDocumentsStore.subscribe((state, prev) => {
    if (state.selectedId && state.selectedId !== prev.selectedId) {
      void state.ensureEvents(state.selectedId)
    }
  })
  const selected = useDocumentsStore.getState().selectedId
  if (selected) void useDocumentsStore.getState().ensureEvents(selected)
  return () => {
    offChanged()
    offRemoved()
    offEvent()
    offLibrary()
    offSelection()
  }
}

/** Visible documents in list order (LibraryView and keyboard navigation share it). */
export function visibleDocuments(): DocumentSummary[] {
  return sortDocuments(useDocumentsStore.getState().items.values())
}

/** The document `step` rows away from `currentId` in list order, clamped to the ends. */
export function adjacentDocumentId(
  currentId: string | null,
  step: number | 'first' | 'last',
): string | null {
  const docs = visibleDocuments()
  if (docs.length === 0) return null
  if (step === 'first') return docs[0]?.id ?? null
  if (step === 'last') return docs.at(-1)?.id ?? null
  const index = docs.findIndex((item) => item.id === currentId)
  if (index < 0) return docs[0]?.id ?? null
  const next = Math.min(docs.length - 1, Math.max(0, index + step))
  return docs[next]?.id ?? null
}
