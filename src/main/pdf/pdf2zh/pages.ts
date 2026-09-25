// Page and form XObject access for the pdf2zh port, with pdfminer's rules: crop box and
// /Rotate give the page CTM (pdfinterp.process_page); a form with its own /Resources uses only
// those, one without inherits the resources of the stream that draws it (do_Do).
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
import type { Matrix, Rect } from '../../../shared/pdf-types'
import { contentBytesOf, streamBytes } from '../compose/streams'
import { applyMatrixPt, pageCtm, type InterpForm } from './interp'

export type FormRecord = {
  ref: PDFRef
  dict: PDFDict
  /** The form's own /Resources, if it has one. */
  resources: PDFDict | undefined
}

export type PageSource = {
  content: Uint8Array
  cropbox: Rect
  rotate: number
  ctm: Matrix
  /** LTPage size: the crop box after the page CTM. */
  width: number
  height: number
  getForm: (name: string) => InterpForm | undefined
  resources: PDFDict | undefined
  /** Form streams met while interpreting, by handle. */
  forms: Map<string, FormRecord>
}

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

export function lookupDict(doc: PDFDocument, value: unknown): PDFDict | undefined {
  const obj = value instanceof PDFRef ? doc.context.lookup(value) : value
  if (obj instanceof PDFDict) return obj
  if (obj instanceof PDFStream) return obj.dict
  return undefined
}

function numbersOf(doc: PDFDocument, value: unknown): number[] | undefined {
  const obj = value instanceof PDFRef ? doc.context.lookup(value) : value
  if (!(obj instanceof PDFArray)) return undefined
  const out: number[] = []
  for (let i = 0; i < obj.size(); i += 1) {
    const item = obj.lookup(i)
    out.push(item instanceof PDFNumber ? item.asNumber() : 0)
  }
  return out
}

function formGetter(
  doc: PDFDocument,
  resources: PDFDict | undefined,
  forms: Map<string, FormRecord>,
): (name: string) => InterpForm | undefined {
  const xobjects = resources ? lookupDict(doc, resources.get(PDFName.of('XObject'))) : undefined
  const cache = new Map<string, InterpForm | undefined>()
  return (name) => {
    if (cache.has(name)) return cache.get(name)
    const value = xobjects?.get(PDFName.of(name))
    const stream = value instanceof PDFRef ? doc.context.lookup(value) : value
    let form: InterpForm | undefined
    if (value instanceof PDFRef && stream instanceof PDFStream) {
      const dict = stream.dict
      const subtype = dict.get(PDFName.of('Subtype'))
      if (subtype instanceof PDFName && subtype.decodeText() === 'Form') {
        const handle = `${value.objectNumber} ${value.generationNumber}`
        const own = lookupDict(doc, dict.get(PDFName.of('Resources')))
        forms.set(handle, { ref: value, dict, resources: own })
        const bbox = numbersOf(doc, dict.get(PDFName.of('BBox')))
        const matrix = numbersOf(doc, dict.get(PDFName.of('Matrix')))
        form = {
          handle,
          matrix: matrix && matrix.length >= 6 ? (matrix.slice(0, 6) as Matrix) : IDENTITY,
          bbox: bbox && bbox.length >= 4 ? (bbox.slice(0, 4) as Rect) : undefined,
          content: streamBytes(stream),
          resources: own ?? resources,
          getForm: formGetter(doc, own ?? resources, forms),
        }
      }
    }
    cache.set(name, form)
    return form
  }
}

export function pageSource(doc: PDFDocument, page: PDFPage): PageSource {
  const crop = page.getCropBox()
  const cropbox: Rect = [crop.x, crop.y, crop.x + crop.width, crop.y + crop.height]
  const rotate = ((page.getRotation().angle % 360) + 360) % 360
  const ctm = pageCtm(cropbox, rotate)
  const a = applyMatrixPt(ctm, cropbox[0], cropbox[1])
  const b = applyMatrixPt(ctm, cropbox[2], cropbox[3])
  const forms = new Map<string, FormRecord>()
  // normalize() (inside contentBytesOf) pulls inherited /Resources onto the page.
  const content = contentBytesOf(page)
  const resources = lookupDict(doc, page.node.Resources())
  return {
    content,
    cropbox,
    rotate,
    ctm,
    width: Math.abs(a[0] - b[0]),
    height: Math.abs(a[1] - b[1]),
    getForm: formGetter(doc, resources, forms),
    resources,
    forms,
  }
}
