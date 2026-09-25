import { readFile } from 'node:fs/promises'
import fontkit from '@cantoo/fontkit'
import {
  PDFName,
  StandardFonts,
  type PDFDict,
  type PDFDocument,
  type PDFFont,
  type PDFRef,
} from '@cantoo/pdf-lib'
import { ERROR_CODES, PermanentError } from '../../../shared/errors'
import { ComposeRequest, ComposeResult, type Matrix } from '../../../shared/pdf-types'
import { writeFileAtomic } from '../../settings/atomic-write'
import { loadPdfLib } from '../load-pdf-lib'
import { interpretPage } from '../pdf2zh/interp'
import { lookupDict, pageSource } from '../pdf2zh/pages'
import { needsTranslation, segmentId } from '../pdf2zh/segments'
import { NOTO, TIRO, typesetUnit, type TypesetFonts } from '../pdf2zh/typeset'
import { buildDualPdf } from './dual'

export type ComposeOutput = ComposeResult & { writtenPages: number[] }

type Warning = ComposeResult['warnings'][number]

/**
 * pdf2zh translate_stream / translate_patch write-back: every page (and every form XObject it
 * interprets) becomes `q {ops_base}Q <cm> {ops_new}`, where ops_base is the stream without its
 * text and ops_new redraws all characters: translations typeset in tiro/noto, formulas and
 * kept text with their original fonts.
 */
export async function composePdf(input: ComposeRequest): Promise<ComposeOutput> {
  const request = ComposeRequest.parse(input)
  const sourceBytes = await readFile(request.sourcePath)
  const doc = await loadPdfLib(sourceBytes)
  doc.registerFontkit(fontkit)
  const tiro = await doc.embedFont(StandardFonts.TimesRoman)
  const noto = await embedNoto(doc, request.fonts.noto)
  const fonts = typesetFonts(tiro, noto)
  const warnings: Warning[] = []

  const sourceTitle = doc.getTitle()
  doc.setTitle(sourceTitle ? `${sourceTitle}（中文）` : '（中文）')

  const translations = new Map(request.translations.map((row) => [row.id, row]))
  const units = new Map(request.analysis.units.map((unit) => [unit.id, unit]))
  const formPatches = new Map<string, { ref: PDFRef; dict: PDFDict; bytes: Uint8Array }>()
  let paragraphsWritten = 0
  let paragraphsKept = 0
  let opsRemoved = 0
  let runsRedrawn = 0
  const writtenPages: number[] = []

  const pages = doc.getPages()
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const page = pages[pageIndex]!
    const source = pageSource(doc, page)
    const interp = interpretPage(
      source.content,
      source.ctm,
      source.width,
      source.getForm,
      source.resources,
    )
    let pageBytes: Uint8Array | undefined
    // verify looks for Chinese text on the pages that received a translation.
    let translatedHere = false
    for (const unit of interp.units) {
      const id = unit.formPath ? `${pageIndex}/${unit.formPath}` : String(pageIndex)
      const data = units.get(id)
      const news = (data?.texts ?? []).map((text, index) => {
        if (!data || !needsTranslation(text)) return text
        const row = translations.get(segmentId(data, index))
        if (row && !row.kept) {
          paragraphsWritten += 1
          translatedHere = true
          return row.text
        }
        paragraphsKept += 1
        return text
      })
      const unknownFonts = (data?.formulas ?? []).some((f) => f.chars.some((c) => !c.font))
      if (unknownFonts) {
        warnings.push({
          page: pageIndex,
          code: 'font_unmapped',
          message: 'some formula characters had no resource font and were not redrawn',
        })
      }
      const opsNew = data
        ? typesetUnit(data, news, fonts)
        : typesetUnit({ paragraphs: [], formulas: [], lines: [] }, [], fonts)
      opsRemoved += unit.removed
      runsRedrawn += data?.formulas.length ?? 0
      if (!unit.formPath) {
        // process_page: `q {ops_base}Q 1 0 0 1 {x0} {y0} cm {ops_new}`
        const [x0, y0] = source.cropbox
        pageBytes = concat('q ', unit.opsBase, `Q 1 0 0 1 ${num(x0)} ${num(y0)} cm ${opsNew}`)
        continue
      }
      const record = unit.handle ? source.forms.get(unit.handle) : undefined
      if (!record) continue
      mountFonts(doc, record.resources, tiro, noto)
      // do_Do: ops_new is in page space; the inverse CTM maps it back into the form.
      formPatches.set(unit.handle!, {
        ref: record.ref,
        dict: record.dict,
        bytes: concat('q ', unit.opsBase, `Q ${inverse(unit.ctm).map(num).join(' ')} cm ${opsNew}`),
      })
    }
    if (!pageBytes) continue
    mountFonts(doc, source.resources, tiro, noto, page.node)
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(pageBytes)))
    if (translatedHere) writtenPages.push(pageIndex)
  }
  for (const patch of formPatches.values()) rewriteForm(doc, patch.ref, patch.dict, patch.bytes)

  const monoBytes = await doc.save({ useObjectStreams: true })
  await writeFileAtomic(request.monoPath, monoBytes)
  let dualBytes: number | null = null
  if (request.dualPath) {
    const dual = await buildDualPdf(sourceBytes, monoBytes, sourceTitle)
    await writeFileAtomic(request.dualPath, dual)
    dualBytes = dual.length
  }
  const result = ComposeResult.parse({
    monoBytes: monoBytes.length,
    dualBytes,
    paragraphsWritten,
    paragraphsKept,
    opsRemoved,
    runsRedrawn,
    warnings,
  })
  return { ...result, writtenPages }
}

async function embedNoto(doc: PDFDocument, path: string): Promise<PDFFont> {
  const bytes = await readFile(path)
  try {
    return await doc.embedFont(bytes, { subset: true })
  } catch {
    try {
      return await doc.embedFont(bytes, { subset: false })
    } catch {
      throw new PermanentError(ERROR_CODES.font_embed_failed)
    }
  }
}

/** pdfminer's WinAnsiEncoding for Times-Roman maps these codes back to the same character. */
function tiroHas(ch: string): boolean {
  if (ch.length !== 1) return false
  const code = ch.charCodeAt(0)
  return (
    (code >= 0x20 && code <= 0x7e) ||
    (code >= 0xa1 && code <= 0xac) ||
    (code >= 0xae && code <= 0xff)
  )
}

function typesetFonts(tiro: PDFFont, noto: PDFFont): TypesetFonts {
  const widths = new Map<string, number>()
  return {
    tiroHas,
    tiroWidth(ch) {
      let width = widths.get(ch)
      if (width === undefined) {
        width = tiro.widthOfTextAtSize(ch, 1)
        widths.set(ch, width)
      }
      return width
    },
    notoWidth: (ch, size) => noto.widthOfTextAtSize(ch, size),
    notoHex: (text) => noto.encodeText(text).toString().slice(1, -1),
  }
}

/** translate_stream inserts `tiro` and `noto` into the /Font dictionaries streams use. */
function mountFonts(
  doc: PDFDocument,
  resources: PDFDict | undefined,
  tiro: PDFFont,
  noto: PDFFont,
  owner?: PDFDict,
): void {
  let res = resources
  if (!res) {
    if (!owner) return
    res = doc.context.obj({})
    owner.set(PDFName.of('Resources'), res)
  }
  let fontDict = lookupDict(doc, res.get(PDFName.of('Font')))
  if (!fontDict) {
    fontDict = doc.context.obj({})
    res.set(PDFName.of('Font'), fontDict)
  }
  fontDict.set(PDFName.of(TIRO), tiro.ref)
  fontDict.set(PDFName.of(NOTO), noto.ref)
}

function rewriteForm(doc: PDFDocument, ref: PDFRef, dict: PDFDict, bytes: Uint8Array): void {
  const entries: Record<string, unknown> = {}
  for (const [key, value] of dict.entries()) {
    const name = key.decodeText()
    if (name === 'Length' || name === 'Filter' || name === 'DecodeParms') continue
    entries[name] = value
  }
  doc.context.assign(ref, doc.context.flateStream(bytes, entries as never))
}

/** Inverse of an affine CTM, as pdf2zh computes it with numpy (row-vector convention). */
function inverse(m: Matrix): Matrix {
  const [a, b, c, d, e, f] = m
  const det = a * d - b * c
  const ia = d / det
  const ib = -b / det
  const ic = -c / det
  const id = a / det
  return [ia, ib, ic, id, -(e * ia + f * ic), -(e * ib + f * id)]
}

/** Number for a content stream (never exponent notation). */
function num(value: number): string {
  if (!Number.isFinite(value)) return '0'
  let text = String(value)
  if (/e/i.test(text)) text = value.toFixed(12).replace(/0+$/, '').replace(/\.$/, '')
  return text === '-0' ? '0' : text
}

function concat(...parts: Array<string | Uint8Array>): Uint8Array {
  const chunks = parts.map((part) =>
    typeof part === 'string' ? Buffer.from(part, 'latin1') : part,
  )
  const out = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}
