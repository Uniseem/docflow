import type { DocumentManifest, DocumentStatus } from '../../shared/types'

export type ListFilter = 'all' | 'active' | 'completed' | 'failed'

const ACTIVE: ReadonlySet<DocumentStatus> = new Set(['queued', 'processing', 'retrying'])
const FAILED: ReadonlySet<DocumentStatus> = new Set(['failed', 'cancelled'])

export function matchesFilter(status: DocumentStatus, filter: ListFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'active') return ACTIVE.has(status)
  if (filter === 'completed') return status === 'completed'
  return FAILED.has(status)
}

export function matchesQuery(manifest: DocumentManifest, query: string | undefined): boolean {
  const q = query?.trim()
  if (!q) return true
  const hay = `${manifest.title}\n${manifest.originalFilename}`.toLowerCase()
  return q
    .toLowerCase()
    .split(/\s+/)
    .every((word) => hay.includes(word))
}

export class DocumentIndex {
  private readonly map = new Map<string, DocumentManifest>()

  load(items: DocumentManifest[]): void {
    this.map.clear()
    for (const item of items) this.map.set(item.id, item)
  }

  set(manifest: DocumentManifest): void {
    this.map.set(manifest.id, manifest)
  }

  get(id: string): DocumentManifest | undefined {
    return this.map.get(id)
  }

  delete(id: string): void {
    this.map.delete(id)
  }

  list(filter: ListFilter, query?: string): DocumentManifest[] {
    return [...this.map.values()]
      .filter((item) => matchesFilter(item.status, filter) && matchesQuery(item, query))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
  }

  counts(query?: string): { all: number; active: number; completed: number; failed: number } {
    const items = [...this.map.values()].filter((item) => matchesQuery(item, query))
    return {
      all: items.length,
      active: items.filter((item) => ACTIVE.has(item.status)).length,
      completed: items.filter((item) => item.status === 'completed').length,
      failed: items.filter((item) => FAILED.has(item.status)).length,
    }
  }

  recoverQueued(): DocumentManifest[] {
    const recovered: DocumentManifest[] = []
    for (const item of this.map.values()) {
      if (item.status === 'processing' || item.status === 'retrying') {
        const next = { ...item, status: 'queued' as const, nextAttemptAt: null }
        this.map.set(item.id, next)
        recovered.push(next)
      }
    }
    return recovered
  }
}
