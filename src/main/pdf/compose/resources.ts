import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFStream,
  type PDFDocument,
  type PDFPage,
} from '@cantoo/pdf-lib'
import type { Matrix } from '../../../shared/pdf-types'
import type { FormXObject } from './content-walker'
import { contentBytesOf, streamBytes } from './streams'

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

export type FontRes = {
  name: string
  ref: PDFRef
  baseFont: string
  formPath: string
}

export type FormRecord = {
  content: Uint8Array
  ref: PDFRef
  dict: PDFDict
}

export type PageGraph = {
  content: Uint8Array
  getForm: (name: string) => FormXObject | undefined
  formByPath: Map<string, FormRecord>
  fonts: FontRes[]
  records: Map<string, FormRecord>
  fontRef: (formPath: string, resourceName: string) => PDFRef | undefined
}

function asDict(doc: PDFDocument, value: unknown): PDFDict | undefined {
  if (value instanceof PDFDict) return value
  const obj = value instanceof PDFRef ? doc.context.lookup(value) : value
  if (obj instanceof PDFDict) return obj
  if (obj instanceof PDFStream) return obj.dict
  return undefined
}

function asNumber(value: unknown): number {
  if (value instanceof PDFNumber) return value.asNumber()
  return 0
}

function asMatrix(value: unknown): Matrix {
  if (!(value instanceof PDFArray) || value.size() < 6) return IDENTITY
  return [
    asNumber(value.lookup(0)),
    asNumber(value.lookup(1)),
    asNumber(value.lookup(2)),
    asNumber(value.lookup(3)),
    asNumber(value.lookup(4)),
    asNumber(value.lookup(5)),
  ]
}

function streamRef(doc: PDFDocument, value: unknown): PDFRef | undefined {
  if (value instanceof PDFRef) return value
  if (value instanceof PDFDict || value instanceof PDFStream) {
    return doc.context.getObjectRef(value)
  }
  return undefined
}

function handleOf(ref: PDFRef): string {
  return `${ref.objectNumber} ${ref.generationNumber}`
}

function subtypeOf(dict: PDFDict): string {
  const value = dict.get(PDFName.of('Subtype'))
  return value instanceof PDFName ? value.decodeText() : ''
}

function resourcesOf(doc: PDFDocument, dict: PDFDict | undefined): PDFDict | undefined {
  if (!dict) return undefined
  return asDict(doc, dict.get(PDFName.of('Resources')))
}

function xobjectDict(doc: PDFDocument, resources: PDFDict | undefined): PDFDict | undefined {
  if (!resources) return undefined
  return asDict(doc, resources.get(PDFName.of('XObject')))
}

function fontDict(doc: PDFDocument, resources: PDFDict | undefined): PDFDict | undefined {
  if (!resources) return undefined
  return asDict(doc, resources.get(PDFName.of('Font')))
}

function baseFontOf(doc: PDFDocument, value: unknown): string {
  const dict = asDict(doc, value)
  const name = dict?.get(PDFName.of('BaseFont'))
  if (name instanceof PDFName) return stripSubsetPrefix(name.decodeText())
  return ''
}

export function stripSubsetPrefix(name: string): string {
  if (/^[A-Z]{6}\+/.test(name)) return name.slice(7)
  return name.includes('+') ? (name.split('+').pop() ?? name) : name
}

function listFonts(doc: PDFDocument, resources: PDFDict | undefined, formPath: string): FontRes[] {
  const fonts = fontDict(doc, resources)
  if (!fonts) return []
  const out: FontRes[] = []
  for (const [key, value] of fonts.entries()) {
    const ref = streamRef(doc, value)
    if (!ref) continue
    out.push({
      name: key.decodeText(),
      ref,
      baseFont: baseFontOf(doc, value),
      formPath,
    })
  }
  return out
}

function makeFormGetter(
  doc: PDFDocument,
  resources: PDFDict | undefined,
  records: Map<string, FormRecord>,
  parent?: (name: string) => FormXObject | undefined,
): (name: string) => FormXObject | undefined {
  const xo = xobjectDict(doc, resources)
  const cache = new Map<string, FormXObject | undefined>()
  return (name: string) => {
    if (cache.has(name)) return cache.get(name)
    const value = xo?.get(PDFName.of(name))
    const dict = asDict(doc, value)
    if (!dict || subtypeOf(dict) !== 'Form') {
      const fallback = parent?.(name)
      cache.set(name, fallback)
      return fallback
    }
    const ref = streamRef(doc, value)
    if (!ref) {
      cache.set(name, parent?.(name))
      return cache.get(name)
    }
    const handle = handleOf(ref)
    const content = streamBytes(doc.context.lookup(value instanceof PDFRef ? value : ref))
    records.set(handle, { content, ref, dict })
    const own = resourcesOf(doc, dict)
    const form: FormXObject = {
      matrix: asMatrix(dict.get(PDFName.of('Matrix'))),
      content,
      handle,
      getForm: makeFormGetter(doc, own, records, parent),
    }
    cache.set(name, form)
    return form
  }
}

export function loadPageGraph(doc: PDFDocument, page: PDFPage): PageGraph {
  page.node.normalize()
  const resources = asDict(doc, page.node.get(PDFName.of('Resources')))
  const fonts = listFonts(doc, resources, '')
  const formByPath = new Map<string, FormRecord>()
  const records = new Map<string, FormRecord>()
  const getForm = makeFormGetter(doc, resources, records)

  return {
    content: contentBytesOf(page),
    getForm,
    formByPath,
    fonts,
    records,
    fontRef(formPath, resourceName) {
      const match =
        fonts.find((f) => f.formPath === formPath && f.name === resourceName) ??
        fonts.find((f) => f.name === resourceName)
      return match?.ref
    },
  }
}

export function noteFormPath(
  graph: PageGraph,
  path: string,
  form: FormXObject,
  doc: PDFDocument,
): void {
  if (!form.handle) return
  const record = graph.records.get(form.handle)
  if (!record) return
  graph.formByPath.set(path, record)
  graph.fonts.push(...listFonts(doc, resourcesOf(doc, record.dict), path))
}

export function rewriteStream(doc: PDFDocument, record: FormRecord, bytes: Uint8Array): void {
  const dict: Record<string, PDFDict | PDFArray | PDFName | PDFRef | PDFNumber | PDFStream> = {}
  for (const [key, value] of record.dict.entries()) {
    const name = key.decodeText()
    if (name === 'Length' || name === 'Filter' || name === 'DecodeParms') continue
    if (
      value instanceof PDFDict ||
      value instanceof PDFArray ||
      value instanceof PDFName ||
      value instanceof PDFRef ||
      value instanceof PDFNumber ||
      value instanceof PDFStream
    ) {
      dict[name] = value
    }
  }
  doc.context.assign(record.ref, doc.context.flateStream(bytes, dict))
}

export function writePageContents(page: PDFPage, bytes: Uint8Array): void {
  const stream = page.doc.context.flateStream(bytes)
  const ref = page.doc.context.register(stream)
  page.node.set(PDFName.of('Contents'), ref)
}

export function mountFont(page: PDFPage, name: string, ref: PDFRef): void {
  page.node.setFontDictionary(PDFName.of(name), ref)
}
