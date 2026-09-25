import type { AnalysisResult, PageLayout, ScanResult } from '../../../shared/pdf-types'
import { TIMEOUT, type PdfWorkerHost } from '../../pdf/worker-host'

export async function analyzeStage(
  host: PdfWorkerHost,
  path: string,
  layouts: PageLayout[],
  pages: number,
  selected: number[] | null,
  ocrWorkaround: boolean,
  signal: AbortSignal,
): Promise<AnalysisResult> {
  return host.request<AnalysisResult>(
    { kind: 'analyze', path, layouts, pages: selected, ocrWorkaround },
    TIMEOUT.analyze(pages),
    signal,
  )
}

/** DetectScannedFile over the pages to translate (scanned.ts). */
export async function scanStage(
  host: PdfWorkerHost,
  path: string,
  pages: number,
  selected: number[] | null,
  signal: AbortSignal,
): Promise<ScanResult> {
  return host.request<ScanResult>(
    { kind: 'scan', path, pages: selected },
    TIMEOUT.scan(selected ? selected.length : pages),
    signal,
  )
}
