import { PDFArray, PDFDocument, PDFRawStream, PDFStream, decodePDFRawStream } from '@cantoo/pdf-lib'

function streamBytes(item: unknown): Uint8Array {
  if (item instanceof PDFRawStream) {
    try {
      return decodePDFRawStream(item).decode()
    } catch {
      return item.getContents()
    }
  }
  if (item instanceof PDFStream) return item.getContents()
  return new Uint8Array()
}

export async function pageContentBytes(path: string, pageIndex: number): Promise<Uint8Array> {
  const { readFile } = await import('node:fs/promises')
  const doc = await PDFDocument.load(await readFile(path), { ignoreEncryption: true })
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
