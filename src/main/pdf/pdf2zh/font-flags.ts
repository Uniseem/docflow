// BabelDOC il_creater_active._compute_font_style_flags: pymupdf.Font(fontbuffer=
// doc.extract_font(xref)[3]) and its is_bold / is_italic / is_monospaced / is_serif. MuPDF.js
// exposes the same MuPDF functions (fz_new_font_from_buffer, fz_font_is_*); on the arXiv
// fixtures both give the same flags. A font without an embedded program gives an empty buffer,
// for which pymupdf.Font falls back to MuPDF's Noto Serif Regular (PyMuPDF 1.28.2): regular
// serif. A program MuPDF cannot load raises, and BabelDOC records None for all four.
import {
  PDFArray,
  PDFName,
  PDFRef,
  PDFStream,
  type PDFDict,
  type PDFDocument,
} from '@cantoo/pdf-lib'
import type * as MuPDFModule from 'mupdf'
import type { FontFlags } from '../../../shared/pdf-types'
import { streamBytes } from '../compose/streams'
import { lookupDict } from './pages'

type MuPDF = typeof MuPDFModule

const NONE: FontFlags = { bold: null, italic: null, monospace: null, serif: null }
const NOTO_SERIF: FontFlags = { bold: false, italic: false, monospace: false, serif: true }

let mupdf: MuPDF | undefined

export async function loadMupdf(): Promise<MuPDF> {
  mupdf ??= await import('mupdf')
  return mupdf
}

/** PyMuPDF JM_get_fontextension + JM_get_fontbuffer: the embedded font program, if any. */
export function embeddedFontProgram(doc: PDFDocument, font: PDFDict): Uint8Array | undefined {
  let descriptorOwner: PDFDict | undefined = font
  const descendants = font.lookupMaybe(PDFName.of('DescendantFonts'), PDFArray)
  if (descendants) descriptorOwner = lookupDict(doc, descendants.get(0))
  const descriptor = descriptorOwner
    ? lookupDict(doc, descriptorOwner.get(PDFName.of('FontDescriptor')))
    : undefined
  if (!descriptor) return undefined
  const file = descriptor.get(PDFName.of('FontFile'))
  const file2 = descriptor.get(PDFName.of('FontFile2'))
  const file3 = descriptor.get(PDFName.of('FontFile3'))
  // The extension check decides whether extract_font reads the buffer at all.
  if (!file && !file2) {
    if (!file3) return undefined
    const subtype = lookupDict(doc, file3)?.get(PDFName.of('Subtype'))
    const known = ['Type1C', 'CIDFontType0C', 'OpenType']
    if (!(subtype instanceof PDFName) || !known.includes(subtype.decodeText())) return undefined
  }
  // JM_get_fontbuffer keeps the last of FontFile, FontFile2, FontFile3 that exists.
  const chosen = file3 ?? file2 ?? file
  const stream = chosen instanceof PDFRef ? doc.context.lookup(chosen) : chosen
  if (!(stream instanceof PDFStream)) return undefined
  const bytes = streamBytes(stream)
  return bytes.length > 0 ? bytes : undefined
}

/** Flags of one /Font dictionary entry; cached per dictionary. */
export async function fontFlagsReader(
  doc: PDFDocument,
): Promise<(font: PDFDict | undefined) => FontFlags> {
  const lib = await loadMupdf()
  const cache = new WeakMap<PDFDict, FontFlags>()
  return (font) => {
    if (!font) return NOTO_SERIF
    const hit = cache.get(font)
    if (hit) return hit
    let flags = NOTO_SERIF
    const program = embeddedFontProgram(doc, font)
    if (program) {
      try {
        const face = new lib.Font('font', program)
        try {
          flags = {
            bold: face.isBold(),
            italic: face.isItalic(),
            monospace: face.isMono(),
            serif: face.isSerif(),
          }
        } finally {
          face.destroy()
        }
      } catch {
        flags = NONE
      }
    }
    cache.set(font, flags)
    return flags
  }
}
