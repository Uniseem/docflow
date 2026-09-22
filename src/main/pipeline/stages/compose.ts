import type { ComposeRequest, ComposeResult } from '../../../shared/pdf-types'
import { TIMEOUT, type PdfWorkerHost } from '../../pdf/worker-host'

export async function composeStage(
  host: PdfWorkerHost,
  request: ComposeRequest,
  pages: number,
  signal: AbortSignal,
): Promise<ComposeResult> {
  return host.request<ComposeResult>({ kind: 'compose', request }, TIMEOUT.compose(pages), signal)
}
