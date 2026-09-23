import {
  PDFArray,
  type PDFDocument,
  PDFFlateStream,
  PDFRawStream,
  PDFStream,
  decodePDFRawStream,
} from '@cantoo/pdf-lib'
import { loadPdfLib } from '../load-pdf-lib'

/** Decoded bytes of a content or form stream. */
export function streamBytes(item: unknown): Uint8Array {
  if (item instanceof PDFRawStream) {
    try {
      return decodePDFRawStream(item).decode()
    } catch {
      return item.getContents()
    }
  }
  // Streams pdf-lib builds itself, such as the q/Q wrappers normalize() adds around the page
  // contents, are flate-encoded by getContents(); the content lexer needs the operators.
  if (item instanceof PDFFlateStream) return item.getUnencodedContents()
  if (item instanceof PDFStream) return item.getContents()
  return new Uint8Array()
}

export async function pageContentBytes(path: string, pageIndex: number): Promise<Uint8Array> {
  const { readFile } = await import('node:fs/promises')
  const doc = await loadPdfLib(await readFile(path))
  return contentBytesOf(doc.getPages()[pageIndex]!)
}

export function contentBytesOf(page: ReturnType<PDFDocument['getPages']>[number]): Uint8Array {
  page.node.normalize()
  const contents = page.node.normalizedEntries().Contents
  if (!contents) return new Uint8Array()
  if (contents instanceof PDFArray) {
    const parts: Uint8Array[] = []
    for (let i = 0; i < contents.size(); i += 1) parts.push(streamBytes(contents.lookup(i)))
    const nl = new Uint8Array([10])
    const total = parts.reduce((n, p) => n + p.length, 0) + Math.max(0, parts.length - 1)
    const out = new Uint8Array(total)
    let o = 0
    parts.forEach((part, idx) => {
      if (idx > 0) {
        out.set(nl, o)
        o += 1
      }
      out.set(part, o)
      o += part.length
    })
    return out
  }
  return streamBytes(contents)
}
