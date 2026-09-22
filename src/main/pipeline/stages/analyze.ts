import type { AnalysisResult } from '../../../shared/pdf-types'
import { TIMEOUT, type PdfWorkerHost } from '../../pdf/worker-host'

export async function analyzeStage(
  host: PdfWorkerHost,
  path: string,
  pages: number,
  signal: AbortSignal,
): Promise<AnalysisResult> {
  return host.request<AnalysisResult>({ kind: 'analyze', path }, TIMEOUT.analyze(pages), signal)
}
