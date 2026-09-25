// high_level.translate_patch: `pix = doc_zh[page.pageno].get_pixmap()`, the page PyMuPDF
// renders at 72 dpi (RGB, no alpha, annotations drawn) for DocLayout-YOLO. MuPDF.js is the
// same MuPDF engine compiled to WebAssembly.
import { readFile } from 'node:fs/promises'
import type * as MuPDFModule from 'mupdf'

type MuPDF = typeof MuPDFModule

export type Pixmap = { width: number; height: number; rgb: Uint8Array }

let mupdf: MuPDF | undefined
// The worker renders one document page by page: keep it open between requests.
let opened: { path: string; doc: InstanceType<MuPDF['Document']> } | undefined

export async function renderPage(path: string, index: number): Promise<Pixmap> {
  mupdf ??= await import('mupdf')
  if (opened?.path !== path) {
    opened?.doc.destroy()
    opened = undefined
    const doc = mupdf.Document.openDocument(await readFile(path), 'application/pdf')
    opened = { path, doc }
  }
  const page = opened.doc.loadPage(index)
  try {
    const pix = page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true)
    try {
      const width = pix.getWidth()
      const height = pix.getHeight()
      const stride = pix.getStride()
      const samples = pix.getPixels()
      const rgb = new Uint8Array(width * height * 3)
      for (let y = 0; y < height; y += 1) {
        rgb.set(samples.subarray(y * stride, y * stride + width * 3), y * width * 3)
      }
      return { width, height, rgb }
    } finally {
      pix.destroy()
    }
  } finally {
    page.destroy()
  }
}
