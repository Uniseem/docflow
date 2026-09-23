import { isActiveStatus } from '../../../shared/library-filter'
import type { DocumentSummary, ProcessingEvent, Stage } from '../../../shared/types'
import { STAGES } from '../../lib/labels'

export type StageState = 'done' | 'running' | 'failed' | 'cancelled' | 'waiting'

/**
 * State of one pipeline stage in the processing panel. Main writes the manifest `stage` when a
 * stage starts, so it names the stage that is running: earlier stages are done, later ones are
 * waiting, and a failed or cancelled document marks the stage it stopped in.
 */
export function stageState(
  item: Pick<DocumentSummary, 'status' | 'stage'>,
  stage: Stage,
): StageState {
  if (item.status === 'completed' || item.stage === 'done') return 'done'
  const current = STAGES.findIndex((info) => info.id === item.stage)
  const index = STAGES.findIndex((info) => info.id === stage)
  if (current < 0 || index > current) return 'waiting'
  if (index < current) return 'done'
  if (item.status === 'failed') return 'failed'
  if (item.status === 'cancelled') return 'cancelled'
  return 'running'
}

/**
 * Processing time in ms, or null when the document never started. Only queued/processing/retrying
 * documents run up to `now`; finished ones stop at completedAt (older records: their last update).
 * `fromCreated` counts a document that is still waiting in the queue from when it was added.
 */
export function elapsedMs(
  item: Pick<DocumentSummary, 'status' | 'createdAt' | 'startedAt' | 'completedAt' | 'updatedAt'>,
  now: number,
  options: { fromCreated?: boolean } = {},
): number | null {
  const start = item.startedAt ?? (options.fromCreated ? item.createdAt : null)
  if (!start) return null
  const end = isActiveStatus(item.status) ? now : Date.parse(item.completedAt ?? item.updatedAt)
  return Math.max(0, end - Date.parse(start))
}

/** The newest event by seq (the list may arrive out of order around a history load). */
export function latestEvent(events: readonly ProcessingEvent[]): ProcessingEvent | undefined {
  let latest: ProcessingEvent | undefined
  for (const event of events) if (!latest || event.seq > latest.seq) latest = event
  return latest
}
