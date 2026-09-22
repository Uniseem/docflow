import type { PdfInspection } from '../../../shared/pdf-types'
import { TIMEOUT, type PdfWorkerHost } from '../../pdf/worker-host'

export async function inspectStage(
  host: PdfWorkerHost,
  path: string,
  signal: AbortSignal,
): Promise<PdfInspection> {
  return host.request<PdfInspection>({ kind: 'inspect', path }, TIMEOUT.inspect, signal)
}
