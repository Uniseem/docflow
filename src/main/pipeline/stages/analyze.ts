import type { AnalysisResult, PageLayout } from '../../../shared/pdf-types'
import { TIMEOUT, type PdfWorkerHost } from '../../pdf/worker-host'

export async function analyzeStage(
  host: PdfWorkerHost,
  path: string,
  layouts: PageLayout[],
  pages: number,
  signal: AbortSignal,
): Promise<AnalysisResult> {
  return host.request<AnalysisResult>(
    { kind: 'analyze', path, layouts },
    TIMEOUT.analyze(pages),
    signal,
  )
}
