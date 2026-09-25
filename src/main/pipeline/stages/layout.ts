import { access } from 'node:fs/promises'
import { ERROR_CODES, PermanentError } from '../../../shared/errors'
import type { PageLayout } from '../../../shared/pdf-types'
import { TIMEOUT, type PdfWorkerHost } from '../../pdf/worker-host'

/**
 * pdf2zh translate_patch, first half: every page rendered by MuPDF at 72 dpi and run through
 * DocLayout-YOLO, one worker request per page.
 */
export async function layoutStage(input: {
  host: PdfWorkerHost
  modelPath: string
  path: string
  pages: number
  /** Pages to detect (BabelDOC only lays out the pages it translates); null for all. */
  selected: number[] | null
  signal: AbortSignal
  onPage: (done: number, total: number) => Promise<void>
}): Promise<PageLayout[]> {
  try {
    await access(input.modelPath)
  } catch {
    throw new PermanentError(ERROR_CODES.layout_model_missing)
  }
  const wanted = input.selected ? new Set(input.selected) : null
  const total = wanted ? wanted.size : input.pages
  const layouts: PageLayout[] = []
  let done = 0
  for (let index = 0; index < input.pages; index += 1) {
    if (wanted && !wanted.has(index)) {
      layouts.push({ width: 0, height: 0, boxes: [] })
      continue
    }
    layouts.push(
      await input.host.request<PageLayout>(
        { kind: 'detect', path: input.path, index, modelPath: input.modelPath },
        TIMEOUT.detect,
        input.signal,
      ),
    )
    done += 1
    await input.onPage(done, total)
  }
  return layouts
}
