import type { VerifyResult } from '../../../shared/pdf-types'
import { TIMEOUT, type PdfWorkerHost } from '../../pdf/worker-host'

export async function verifyStage(
  host: PdfWorkerHost,
  input: {
    monoPath: string
    dualPath: string | null
    pages: number
    writtenPages: number[]
    dualMode: 'side-by-side' | 'alternating'
  },
  signal: AbortSignal,
): Promise<VerifyResult> {
  return host.request<VerifyResult>({ kind: 'verify', ...input }, TIMEOUT.verify, signal)
}
