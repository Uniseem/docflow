import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  getDocument,
  GlobalWorkerOptions,
  InvalidPDFException,
  PasswordException,
  OPS,
  VerbosityLevel,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from 'pdfjs-dist/legacy/build/pdf.mjs'

const require = createRequire(import.meta.url)
const pdfjsRoot = dirname(require.resolve('pdfjs-dist/package.json'))

function dirUrl(subdir: string): string {
  const href = pathToFileURL(join(pdfjsRoot, subdir)).href
  return href.endsWith('/') ? href : `${href}/`
}

GlobalWorkerOptions.workerSrc = pathToFileURL(join(pdfjsRoot, 'legacy/build/pdf.worker.mjs')).href

export { OPS, InvalidPDFException, PasswordException }
export type { PDFDocumentProxy, PDFPageProxy }

export function pdfjsLoadOptions(data: Uint8Array) {
  return {
    data,
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: VerbosityLevel.ERRORS,
    standardFontDataUrl: dirUrl('standard_fonts'),
    cMapUrl: dirUrl('cmaps'),
    cMapPacked: true,
    fontExtraProperties: true,
  }
}

export async function openPdfDocument(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  const data = new Uint8Array(bytes)
  const task = getDocument(pdfjsLoadOptions(data))
  return task.promise
}
