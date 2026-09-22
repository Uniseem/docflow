import { PDFDocument } from '@cantoo/pdf-lib'
import { PDF } from '../../../shared/pdf-constants'

export async function buildDualPdf(
  sourceBytes: Uint8Array,
  monoBytes: Uint8Array,
  title?: string,
): Promise<Uint8Array> {
  const dual = await PDFDocument.create()
  const orig = await PDFDocument.load(sourceBytes, { ignoreEncryption: true })
  const mono = await PDFDocument.load(monoBytes, { ignoreEncryption: true })
  const pages = orig.getPageCount()
  const batch = pages > PDF.MAX_PAGES_SINGLE_PASS ? 50 : pages
  for (let start = 0; start < pages; start += batch) {
    const end = Math.min(pages, start + batch)
    const indexes = Array.from({ length: end - start }, (_, i) => start + i)
    const origPages = await dual.copyPages(orig, indexes)
    const monoPages = await dual.copyPages(mono, indexes)
    for (let i = 0; i < origPages.length; i += 1) {
      dual.addPage(origPages[i])
      dual.addPage(monoPages[i])
    }
  }
  const base = title?.trim() || orig.getTitle() || ''
  dual.setTitle(base ? `${base}（双语）` : '（双语）')
  return dual.save({ useObjectStreams: true })
}
