import {
  PDFArray,
  PDFDocument,
  PDFDict,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFStream,
  decodePDFRawStream,
} from '@cantoo/pdf-lib'

export type FormRefStat = {
  page: number
  formPath: string
  ref: string
  shared: boolean
  glyphs: number
}

function asDict(obj: unknown): PDFDict | undefined {
  return obj instanceof PDFDict ? obj : undefined
}

function subtypeOf(dict: PDFDict): string {
  const value = dict.get(PDFName.of('Subtype'))
  return value instanceof PDFName ? value.decodeText() : ''
}

function lookupDict(doc: PDFDocument, value: unknown): PDFDict | undefined {
  if (value instanceof PDFDict) return value
  const obj = value instanceof PDFRef ? doc.context.lookup(value) : value
  if (obj instanceof PDFDict) return obj
  if (obj instanceof PDFStream) return obj.dict
  return asDict(obj)
}

function isForm(doc: PDFDocument, value: unknown): boolean {
  const dict = lookupDict(doc, value)
  return dict ? subtypeOf(dict) === 'Form' : false
}

function decodeStream(stream: PDFRawStream): string {
  try {
    const decoded = decodePDFRawStream(stream)
    return Buffer.from(decoded.decode()).toString('latin1')
  } catch {
    return ''
  }
}

function contentsText(item: unknown): string {
  if (item instanceof PDFRawStream) return decodeStream(item)
  if (item instanceof PDFStream) {
    try {
      return item.getContentsString()
    } catch {
      return ''
    }
  }
  return ''
}

function doNames(content: string): string[] {
  const names: string[] = []
  const re = /\/([A-Za-z0-9._-]+)\s+Do/g
  let match: RegExpExecArray | null
  while ((match = re.exec(content))) {
    if (match[1]) names.push(match[1])
  }
  return names
}

function pageContent(page: ReturnType<PDFDocument['getPages']>[number]): string {
  page.node.normalize()
  const contents = page.node.normalizedEntries().Contents
  if (!contents) return ''
  if (contents instanceof PDFArray) {
    const chunks: string[] = []
    for (let i = 0; i < contents.size(); i += 1) chunks.push(contentsText(contents.lookup(i)))
    return chunks.join('\n')
  }
  return contentsText(contents)
}

export async function scanFormRefs(bytes: Uint8Array): Promise<{
  stats: FormRefStat[]
  sharedPaths: Map<number, Set<string>>
}> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true })
  const pageHits = new Map<string, Set<number>>()
  const pagePaths: Array<{ page: number; formPath: string; ref: string }> = []

  doc.getPages().forEach((page, pageIndex) => {
    page.node.normalize()
    const xo = page.node.normalizedEntries().XObject
    const formByName = new Map<string, PDFRef>()
    for (const [name, value] of xo.entries()) {
      if (!isForm(doc, value)) continue
      const ref = value instanceof PDFRef ? value : page.doc.context.getObjectRef(value)
      if (ref) formByName.set(name.decodeText(), ref)
    }
    const drawn = doNames(pageContent(page)).filter((name) => formByName.has(name))
    const names = drawn.length > 0 ? drawn : [...formByName.keys()]
    let seq = 0
    for (const name of names) {
      const ref = formByName.get(name)
      if (!ref) continue
      seq += 1
      const key = `${ref.objectNumber} ${ref.generationNumber}`
      const pages = pageHits.get(key) ?? new Set()
      pages.add(pageIndex)
      pageHits.set(key, pages)
      pagePaths.push({ page: pageIndex, formPath: String(seq), ref: key })
    }
  })

  const sharedRefs = new Set<string>()
  for (const [ref, pages] of pageHits) {
    if (pages.size >= 2) sharedRefs.add(ref)
  }
  const sharedPaths = new Map<number, Set<string>>()
  const stats: FormRefStat[] = pagePaths.map((row) => {
    const shared = sharedRefs.has(row.ref)
    if (shared) {
      const set = sharedPaths.get(row.page) ?? new Set()
      set.add(row.formPath)
      sharedPaths.set(row.page, set)
    }
    return { ...row, shared, glyphs: 0 }
  })
  return { stats, sharedPaths }
}
