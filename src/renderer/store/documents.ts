import { create } from 'zustand'
import type { DocumentStatus, DocumentSummary, ProcessingEvent } from '../../shared/types'
import { SEARCH_DEBOUNCE_MS } from '../../shared/constants'
import { invoke, listen } from '../api/invoke'
import { useSettingsStore } from './settings'
import { useUiStore } from './ui'

export type LibraryFilter = 'all' | 'active' | 'completed' | 'failed'

type Counts = { all: number; active: number; completed: number; failed: number }

type DocumentsState = {
  items: Map<string, DocumentSummary>
  counts: Counts
  filter: LibraryFilter
  query: string
  selectedId: string | null
  events: Map<string, ProcessingEvent[]>
  eventCursors: Map<string, number>
  setFilter: (filter: LibraryFilter) => void
  setQuery: (query: string) => void
  select: (id: string | null) => void
  list: () => Promise<void>
  upsert: (item: DocumentSummary) => void
  remove: (id: string) => void
  loadEvents: (id: string) => Promise<void>
  appendEvent: (id: string, event: ProcessingEvent) => void
}

const emptyCounts: Counts = { all: 0, active: 0, completed: 0, failed: 0 }

let queryTimer: ReturnType<typeof setTimeout> | undefined

export const useDocumentsStore = create<DocumentsState>((set, get) => ({
  items: new Map(),
  counts: emptyCounts,
  filter: 'all',
  query: '',
  selectedId: null,
  events: new Map(),
  eventCursors: new Map(),
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
    if (selectedId) void get().loadEvents(selectedId)
  },
  list: async () => {
    const { filter, query } = get()
    const payload = query.trim() ? { filter, query: query.trim() } : { filter }
    const result = await invoke('documents:list', payload)
    const items = new Map<string, DocumentSummary>()
    for (const item of result.items) items.set(item.id, item)
    const selectedId = get().selectedId
    const still = selectedId ? items.has(selectedId) : false
    set({
      items,
      counts: result.counts,
      selectedId: still ? selectedId : (result.items[0]?.id ?? null),
    })
  },
  upsert: (item) => {
    const previousSelected = get().selectedId
    set((state) => {
      const items = new Map(state.items)
      const previous = items.get(item.id)
      const existed = Boolean(previous)
      if (existed || visibleInFilter(item.status, state.filter)) items.set(item.id, item)
      else items.delete(item.id)
      const counts =
        state.filter === 'all' && !state.query
          ? recount(items)
          : adjustCounts(state.counts, item, existed, previous)
      return {
        items,
        counts,
        selectedId: state.selectedId ?? item.id,
      }
    })
    const selectedId = get().selectedId
    if (!previousSelected && selectedId) void get().loadEvents(selectedId)
  },
  remove: (id) => {
    set((state) => {
      const items = new Map(state.items)
      items.delete(id)
      const events = new Map(state.events)
      events.delete(id)
      const eventCursors = new Map(state.eventCursors)
      eventCursors.delete(id)
      const selectedId =
        state.selectedId === id ? (items.keys().next().value ?? null) : state.selectedId
      return {
        items,
        events,
        eventCursors,
        selectedId,
        counts:
          state.filter === 'all' && !state.query
            ? recount(items)
            : decrementCount(state.counts, state.items.get(id)),
      }
    })
  },
  loadEvents: async (id) => {
    const afterSeq = get().eventCursors.get(id) ?? 0
    const result = await invoke(
      'documents:events',
      afterSeq > 0 ? { id, afterSeq, limit: 500 } : { id, limit: 500 },
    )
    set((state) => {
      const events = new Map(state.events)
      const prev = events.get(id) ?? []
      const merged = afterSeq > 0 ? [...prev, ...result.items] : result.items
      events.set(id, merged)
      const eventCursors = new Map(state.eventCursors)
      eventCursors.set(id, result.lastSeq)
      return { events, eventCursors }
    })
  },
  appendEvent: (id, event) => {
    set((state) => {
      const events = new Map(state.events)
      const prev = events.get(id) ?? []
      if (prev.some((item) => item.seq === event.seq)) return state
      events.set(id, [...prev, event])
      const eventCursors = new Map(state.eventCursors)
      eventCursors.set(id, Math.max(eventCursors.get(id) ?? 0, event.seq))
      return { events, eventCursors }
    })
  },
}))

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
    useDocumentsStore.setState({ selectedId: null })
    const info = useUiStore.getState().appInfo
    if (info) useUiStore.getState().setAppInfo({ ...info, libraryDir })
    void useDocumentsStore.getState().list()
    void useSettingsStore.getState().load()
  })
  return () => {
    offChanged()
    offRemoved()
    offEvent()
    offLibrary()
  }
}

function isActive(status: DocumentStatus): boolean {
  return status === 'queued' || status === 'processing' || status === 'retrying'
}

function isFailed(status: DocumentStatus): boolean {
  return status === 'failed' || status === 'cancelled'
}

function visibleInFilter(status: DocumentStatus, filter: LibraryFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'active') return isActive(status)
  if (filter === 'completed') return status === 'completed'
  return isFailed(status)
}

function bucket(status: DocumentStatus): 'active' | 'completed' | 'failed' {
  if (status === 'completed') return 'completed'
  if (isFailed(status)) return 'failed'
  return 'active'
}

function recount(items: Map<string, DocumentSummary>): Counts {
  const counts: Counts = { all: items.size, active: 0, completed: 0, failed: 0 }
  for (const item of items.values()) counts[bucket(item.status)] += 1
  return counts
}

function adjustCounts(
  counts: Counts,
  item: DocumentSummary,
  existed: boolean,
  previous: DocumentSummary | undefined,
): Counts {
  if (!existed) {
    const key = bucket(item.status)
    return { ...counts, all: counts.all + 1, [key]: counts[key] + 1 }
  }
  if (!previous || previous.status === item.status) return counts
  const from = bucket(previous.status)
  const to = bucket(item.status)
  if (from === to) return counts
  return { ...counts, [from]: Math.max(0, counts[from] - 1), [to]: counts[to] + 1 }
}

function decrementCount(counts: Counts, item: DocumentSummary | undefined): Counts {
  if (!item) return counts
  const key = bucket(item.status)
  return {
    all: Math.max(0, counts.all - 1),
    active: key === 'active' ? Math.max(0, counts.active - 1) : counts.active,
    completed: key === 'completed' ? Math.max(0, counts.completed - 1) : counts.completed,
    failed: key === 'failed' ? Math.max(0, counts.failed - 1) : counts.failed,
  }
}

export function visibleDocuments(): DocumentSummary[] {
  return [...useDocumentsStore.getState().items.values()]
}
