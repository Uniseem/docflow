import type { DocumentStatus } from './types'

export type LibraryFilter = 'all' | 'active' | 'completed' | 'failed'

export type StatusBucket = 'active' | 'completed' | 'failed'

const ACTIVE: ReadonlySet<DocumentStatus> = new Set(['queued', 'processing', 'retrying'])
const FAILED: ReadonlySet<DocumentStatus> = new Set(['failed', 'cancelled'])

export function isActiveStatus(status: DocumentStatus): boolean {
  return ACTIVE.has(status)
}

export function isFailedStatus(status: DocumentStatus): boolean {
  return FAILED.has(status)
}

export function statusBucket(status: DocumentStatus): StatusBucket {
  if (status === 'completed') return 'completed'
  if (FAILED.has(status)) return 'failed'
  return 'active'
}

export function matchesFilter(status: DocumentStatus, filter: LibraryFilter): boolean {
  if (filter === 'all') return true
  return statusBucket(status) === filter
}

export function matchesQuery(
  item: { title: string; originalFilename: string },
  query: string | undefined,
): boolean {
  const q = query?.trim()
  if (!q) return true
  const hay = `${item.title}\n${item.originalFilename}`.toLowerCase()
  return q
    .toLowerCase()
    .split(/\s+/)
    .every((word) => hay.includes(word))
}
