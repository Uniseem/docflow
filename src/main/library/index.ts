import type { DocumentManifest } from '../../shared/types'
import {
  isActiveStatus,
  isFailedStatus,
  matchesFilter,
  matchesQuery,
  type LibraryFilter,
} from '../../shared/library-filter'

export { matchesFilter, matchesQuery }
export type ListFilter = LibraryFilter

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
      active: items.filter((item) => isActiveStatus(item.status)).length,
      completed: items.filter((item) => item.status === 'completed').length,
      failed: items.filter((item) => isFailedStatus(item.status)).length,
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
