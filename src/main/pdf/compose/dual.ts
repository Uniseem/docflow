// BabelDOC 0.6.4 PDFCreater.create_side_by_side_dual_pdf / create_alternating_pages_dual_pdf,
// migrate_toc and only_include_translated_page, with pdf-lib (ADR-0018).
import {
  PDFDocument,
  PDFName,
  type PDFPage,
  concatTransformationMatrix,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
} from '@cantoo/pdf-lib'
import type { Matrix } from '../../../shared/pdf-types'
import { PDF } from '../../../shared/pdf-constants'
import { loadPdfLib } from '../load-pdf-lib'
import { multMatrix, pageCtm } from '../pdf2zh/interp'
import { readOutline, writeOutline, type PageTarget } from './outline'

export type DualOptions = {
  title?: string | undefined
  mode: 'side-by-side' | 'alternating'
  /** dual_translate_first */
  translateFirst: boolean
  /** only_include_translated_page: source pages that stay (mono already holds only these). */
  keep: readonly number[] | null
}

export async function buildDualPdf(
  sourceBytes: Uint8Array,
  monoBytes: Uint8Array,
  options: DualOptions,
): Promise<Uint8Array> {
  const orig = await loadPdfLib(sourceBytes)
  const mono = await loadPdfLib(monoBytes)
  const outline = readOutline(orig)
  if (options.keep) keepPages(orig, options.keep)
  const dual = await PDFDocument.create()
  const count = Math.min(orig.getPageCount(), mono.getPageCount())
  const targets: PageTarget[] = []
  if (options.mode === 'alternating') {
    await alternating(dual, orig, mono, count, options.translateFirst, targets)
  } else {
    await sideBySide(dual, orig, mono, count, options.translateFirst, targets)
  }
  // Outline entries point at source pages; with pages dropped they are renumbered.
  const index = options.keep ? new Map(options.keep.map((page, i) => [page, i])) : null
  writeOutline(dual, outline, (page) => targets[index ? (index.get(page) ?? -1) : page])
  const base = options.title?.trim() || orig.getTitle() || ''
  dual.setTitle(base ? `${base}（双语）` : '（双语）')
  return dual.save({ useObjectStreams: true })
}

/** create_alternating_pages_dual_pdf: original then translation (or the other way round). */
async function alternating(
  dual: PDFDocument,
  orig: PDFDocument,
  mono: PDFDocument,
  count: number,
  translateFirst: boolean,
  targets: PageTarget[],
): Promise<void> {
  const batch = count > PDF.MAX_PAGES_SINGLE_PASS ? 50 : Math.max(1, count)
  for (let start = 0; start < count; start += batch) {
    const indexes = Array.from({ length: Math.min(batch, count - start) }, (_, i) => start + i)
    const origPages = await dual.copyPages(orig, indexes)
    const monoPages = await dual.copyPages(mono, indexes)
    for (let i = 0; i < origPages.length; i += 1) {
      const first = translateFirst ? monoPages[i]! : origPages[i]!
      const second = translateFirst ? origPages[i]! : monoPages[i]!
      dual.addPage(first)
      dual.addPage(second)
      // BabelDOC keeps the original document's TOC, which points at the original pages.
      targets.push({ ref: origPages[i]!.ref, dx: 0, dy: 0, keepCoordinates: true })
    }
  }
}

type Shown = { width: number; height: number; toDisplay: Matrix }

/** The page as displayed: crop box through /Rotate, like pymupdf's page.rect. */
function displayed(page: PDFPage): Shown {
  const crop = page.getCropBox()
  const rotate = ((page.getRotation().angle % 360) + 360) % 360
  const box: [number, number, number, number] = [
    crop.x,
    crop.y,
    crop.x + crop.width,
    crop.y + crop.height,
  ]
  const upright = rotate === 90 || rotate === 270
  return {
    width: upright ? crop.height : crop.width,
    height: upright ? crop.width : crop.height,
    toDisplay: pageCtm(box, rotate),
  }
}

/**
 * create_side_by_side_dual_pdf: one page as wide as both and as tall as the taller; the
 * original on the left (right with dual_translate_first), each side shown at its displayed
 * orientation by show_pdf_page(keep_proportion=True).
 */
async function sideBySide(
  dual: PDFDocument,
  orig: PDFDocument,
  mono: PDFDocument,
  count: number,
  translateFirst: boolean,
  targets: PageTarget[],
): Promise<void> {
  const origPages = orig.getPages()
  const monoPages = mono.getPages()
  for (let i = 0; i < count; i += 1) {
    const o = origPages[i]!
    const t = monoPages[i]!
    const os = displayed(o)
    const ts = displayed(t)
    const height = Math.max(os.height, ts.height)
    const page = dual.addPage([os.width + ts.width, height])
    const placed = await show(dual, page, o, os, translateFirst ? ts.width : 0, height, 'O')
    await show(dual, page, t, ts, translateFirst ? 0 : os.width, height, 'T')
    targets.push({ ref: page.ref, dx: placed.dx, dy: placed.dy, keepCoordinates: placed.upright })
  }
}

/**
 * show_pdf_page(rect, src, keep_proportion=True) with rect = (left, 0, left + width, height):
 * calc_matrix scales to fit and centres, here after the page's own display transform.
 */
async function show(
  dual: PDFDocument,
  page: PDFPage,
  src: PDFPage,
  shown: Shown,
  left: number,
  height: number,
  prefix: string,
): Promise<{ dx: number; dy: number; upright: boolean }> {
  const crop = src.getCropBox()
  const embedded = await dual.embedPage(
    src,
    { left: crop.x, bottom: crop.y, right: crop.x + crop.width, top: crop.y + crop.height },
    [1, 0, 0, 1, 0, 0],
  )
  const scale = Math.min(1, height / shown.height)
  const offsetX = left + (shown.width - shown.width * scale) / 2
  const offsetY = (height - shown.height * scale) / 2
  const m = multMatrix(shown.toDisplay, [scale, 0, 0, scale, offsetX, offsetY])
  const name = page.node.newXObject(prefix, embedded.ref)
  page.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(m[0], m[1], m[2], m[3], m[4], m[5]),
    drawObject(name),
    popGraphicsState(),
  )
  const rotate = ((src.getRotation().angle % 360) + 360) % 360
  // Destinations keep their coordinates only when the page is shown as it is.
  return { dx: offsetX - crop.x, dy: offsetY - crop.y, upright: rotate === 0 && scale === 1 }
}

/** Keeps the given pages (sorted), deleting the rest; the outline loses what pointed there. */
export function keepPages(doc: PDFDocument, keep: readonly number[]): void {
  const outline = readOutline(doc)
  const pages = doc.getPages()
  const wanted = new Set(keep)
  const refs = new Map<number, PageTarget>()
  pages.forEach((page, i) => {
    if (wanted.has(i)) refs.set(i, { ref: page.ref, dx: 0, dy: 0, keepCoordinates: true })
  })
  for (let i = pages.length - 1; i >= 0; i -= 1) if (!wanted.has(i)) doc.removePage(i)
  if (doc.catalog.get(PDFName.of('Outlines'))) writeOutline(doc, outline, (page) => refs.get(page))
}
