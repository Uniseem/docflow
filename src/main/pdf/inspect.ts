import { readFile } from 'node:fs/promises'
import { PDF } from '../../shared/pdf-constants'
import { ERROR_CODES, PermanentError } from '../../shared/errors'
import { PdfInspection } from '../../shared/pdf-types'
import { extractPageGraphics, visibleGlyphCount } from './analyze/glyphs'
import { InvalidPDFException, PasswordException, openPdfDocument } from './pdfjs'

function samplePageIndices(pages: number): number[] {
  if (pages <= PDF.SAMPLE_PAGES) return Array.from({ length: pages }, (_, i) => i)
  const picked = new Set<number>()
  for (let i = 0; i < Math.min(3, pages); i += 1) picked.add(i)
  const need = PDF.SAMPLE_PAGES - picked.size
  for (let i = 1; i <= need; i += 1) {
    picked.add(Math.min(pages - 1, Math.round((i * (pages - 1)) / (need + 1))))
  }
  return [...picked].sort((a, b) => a - b)
}

function isPasswordError(error: unknown): boolean {
  return (
    error instanceof PasswordException ||
    (error instanceof Error && error.name === 'PasswordException')
  )
}

function isInvalidError(error: unknown): boolean {
  return (
    error instanceof InvalidPDFException ||
    (error instanceof Error && error.name === 'InvalidPDFException')
  )
}

function looksLikeTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const title = value.trim()
  if (title.length < 3 || title.length > 300) return undefined
  if (/\.pdf$/i.test(title) || /^\d+$/.test(title)) return undefined
  return title
}

export async function inspectPdf(path: string): Promise<PdfInspection> {
  const bytes = await readFile(path)
  if (bytes.length < 5 || bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new PermanentError(ERROR_CODES.pdf_invalid)
  }

  let doc
  try {
    doc = await openPdfDocument(bytes)
  } catch (error) {
    if (isPasswordError(error)) throw new PermanentError(ERROR_CODES.pdf_encrypted)
    if (isInvalidError(error)) throw new PermanentError(ERROR_CODES.pdf_invalid)
    throw new PermanentError(ERROR_CODES.pdf_open)
  }

  try {
    if (doc.numPages === 0) throw new PermanentError(ERROR_CODES.pdf_empty)
    if (doc.numPages > PDF.MAX_PAGES) throw new PermanentError(ERROR_CODES.pdf_too_long)

    const pageSizes: Array<[number, number]> = []
    const rotations: number[] = []
    for (let i = 1; i <= doc.numPages; i += 1) {
      const page = await doc.getPage(i)
      const viewport = page.getViewport({ scale: 1, rotation: 0 })
      if (
        viewport.width < 50 ||
        viewport.height < 50 ||
        viewport.width > 14400 ||
        viewport.height > 14400
      ) {
        throw new PermanentError(ERROR_CODES.page_geometry)
      }
      pageSizes.push([viewport.width, viewport.height])
      rotations.push(page.rotate)
      page.cleanup()
    }

    const samples = samplePageIndices(doc.numPages)
    let textChars = 0
    let visibleTextChars = 0
    for (const index of samples) {
      const page = await doc.getPage(index + 1)
      const graphics = await extractPageGraphics(page, index)
      textChars += graphics.glyphs.length
      visibleTextChars += visibleGlyphCount(graphics.glyphs)
      page.cleanup()
    }

    const avgVisible = visibleTextChars / Math.max(1, samples.length)
    if (visibleTextChars < PDF.MIN_TEXT_CHARS_SAMPLE && avgVisible < 25) {
      throw new PermanentError(ERROR_CODES.scanned_pdf)
    }

    let title: string | undefined
    try {
      const metadata = await doc.getMetadata()
      title = looksLikeTitle((metadata.info as { Title?: unknown }).Title)
    } catch {
      title = undefined
    }

    return PdfInspection.parse({
      pages: doc.numPages,
      pageSizes,
      rotations,
      textChars,
      visibleTextChars,
      hasTextLayer: visibleTextChars > 0,
      ...(title ? { title } : {}),
    })
  } finally {
    await doc.cleanup()
  }
}
