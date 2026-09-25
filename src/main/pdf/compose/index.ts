import { readFile } from 'node:fs/promises'
import fontkit from '@cantoo/fontkit'
import {
  PDFName,
  type PDFDict,
  type PDFDocument,
  type PDFFont,
  type PDFPage,
  type PDFRef,
} from '@cantoo/pdf-lib'
import { ERROR_CODES, PermanentError } from '../../../shared/errors'
import {
  ComposeRequest,
  ComposeResult,
  type ComposeRequestInput,
  type LayoutUnit,
  type Matrix,
  type TranslatedParagraph,
} from '../../../shared/pdf-types'
import { writeFileAtomic } from '../../settings/atomic-write'
import { BundledFontSet } from '../babeldoc/font-set'
import { FontMapper } from '../babeldoc/fontmap'
import { fontResourceName } from '../babeldoc/fonts'
import { loadPdfLib } from '../load-pdf-lib'
import { interpretPage } from '../pdf2zh/interp'
import { lookupDict, pageSource } from '../pdf2zh/pages'
import {
  lineOps,
  preprocessDocument,
  renderPage,
  type ReflowFonts,
  type ReflowPage,
  type ReflowParagraph,
} from '../pdf2zh/reflow'
import { segmentId } from '../pdf2zh/segments'
import { buildDualPdf, keepPages } from './dual'

export type ComposeOutput = ComposeResult & {
  writtenPages: number[]
  /** Pages of mono.pdf (fewer than the source with only_include_translated_page). */
  monoPages: number
}

type Warning = ComposeResult['warnings'][number]

/**
 * pdf2zh translate_stream / translate_patch write-back: every page (and every form XObject it
 * interprets) becomes `q {ops_base}Q <inverse CTM> cm {ops_new}`, where ops_base is the stream
 * without its text and ops_new redraws all characters. ops_new is laid out by BabelDOC's
 * typesetting (pdf2zh/reflow.ts, ADR-0017) with its font mapping and rich-text compositions
 * (ADR-0018); untranslated text keeps its original glyphs.
 */
export async function composePdf(input: ComposeRequestInput): Promise<ComposeOutput> {
  const request = ComposeRequest.parse(input)
  const { options } = request
  const sourceBytes = await readFile(request.sourcePath)
  const doc = await loadPdfLib(sourceBytes)
  doc.registerFontkit(fontkit)
  const fontSet = new BundledFontSet(request.fonts.dir)
  const mapper = new FontMapper(options.fontFamily, fontSet.hasGlyph)
  const embedded = new Map<string, PDFFont>()
  const fonts: ReflowFonts = {
    mapper,
    width: fontSet.width,
    hex: (file, ch) => {
      const font = embedded.get(file)
      if (!font) throw new Error(`font ${file} was not embedded`)
      return font.encodeText(ch).toString().slice(1, -1)
    },
  }
  const warnings: Warning[] = []

  const sourceTitle = doc.getTitle()
  doc.setTitle(sourceTitle ? `${sourceTitle}（中文）` : '（中文）')

  const translations = new Map(request.translations.map((row) => [row.id, row]))
  const selected = options.pages ? new Set(options.pages) : null
  const units = new Map(request.analysis.units.map((unit) => [unit.id, unit]))
  const formPatches = new Map<string, { ref: PDFRef; dict: PDFDict; bytes: Uint8Array }>()
  let paragraphsWritten = 0
  let paragraphsKept = 0
  let opsRemoved = 0
  let runsRedrawn = 0
  const writtenPages: number[] = []
  const pages = doc.getPages()

  // Every paragraph first: BabelDOC fixes each paragraph's scale against the whole document
  // before drawing any page.
  const reflowPages: ReflowPage[] = pages.map((page) => ({ ...pageLimits(page), paragraphs: [] }))
  const byUnit = new Map<string, ReflowParagraph[]>()
  const rectangles = new Map<string, string>()
  // verify looks for Chinese text on the pages that received a translation.
  const translatedPages = new Set<number>()
  for (const data of request.analysis.units) {
    const reflowPage = reflowPages[data.page]
    if (!reflowPage || (selected && !selected.has(data.page))) continue
    const paragraphs = data.paragraphs.map((para, index): ReflowParagraph => {
      const row = translations.get(segmentId(data, index))
      const comps = translated(row)
      if (comps) {
        paragraphsWritten += 1
        translatedPages.add(data.page)
      } else if (row) {
        paragraphsKept += 1
      }
      return {
        para,
        formulas: data.formulas,
        items: data.infos[index]?.items ?? [],
        styles: data.styles,
        fonts: data.fonts,
        comps,
        ocr: request.analysis.ocrWorkaround,
        stream: data.formPath,
        box: { x: para.x0, y: para.y0, x2: para.x1, y2: para.y1 },
      }
    })
    byUnit.set(data.id, paragraphs)
    reflowPage.paragraphs.push(...paragraphs)
    if (request.analysis.ocrWorkaround) rectangles.set(data.id, whiteBackgrounds(data))
    if (data.formulas.some((f) => f.chars.some((c) => !c.font))) {
      warnings.push({
        page: data.page,
        code: 'font_unmapped',
        message: 'some formula characters had no resource font and were not redrawn',
      })
    }
  }
  preprocessDocument(reflowPages, fonts)
  await embedUsedFonts(doc, reflowPages, fontSet, embedded)

  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    // Pages outside `pages` keep their content (BabelDOC only translates the chosen ones).
    if (selected && !selected.has(pageIndex)) continue
    const page = pages[pageIndex]!
    const source = pageSource(doc, page)
    const interp = interpretPage(
      source.content,
      source.ctm,
      source.width,
      source.getForm,
      source.resources,
    )
    const reflowPage = reflowPages[pageIndex]!
    renderPage(reflowPage, fonts)
    const notFit = reflowPage.paragraphs.filter((p) => p.rendered === false).length
    if (notFit > 0) {
      warnings.push({
        page: pageIndex,
        code: 'paragraph_not_fit',
        message: `${notFit} paragraph(s) did not fit at any scale and were not drawn`,
      })
    }
    let pageBytes: Uint8Array | undefined
    for (const unit of interp.units) {
      const id = unit.formPath ? `${pageIndex}/${unit.formPath}` : String(pageIndex)
      const data = units.get(id)
      const opsNew =
        (rectangles.get(id) ?? '') +
        (byUnit.get(id) ?? []).map((p) => p.ops ?? '').join('') +
        (data?.lines ?? [])
          .filter((l) => l.linewidth < 5)
          .map(lineOps)
          .join('')
      opsRemoved += unit.removed
      runsRedrawn += data?.formulas.length ?? 0
      if (!unit.formPath) {
        // process_page writes `q {ops_base}Q 1 0 0 1 {x0} {y0} cm {ops_new}`, the inverse of
        // the page CTM only without /Rotate; do_Do's inverse CTM also holds for rotated pages.
        pageBytes = concat(
          'q ',
          unit.opsBase,
          `Q ${inverse(source.ctm).map(num).join(' ')} cm ${opsNew}`,
        )
        continue
      }
      const record = unit.handle ? source.forms.get(unit.handle) : undefined
      if (!record) continue
      mountFonts(doc, record.resources, embedded)
      // do_Do: ops_new is in page space; the inverse CTM maps it back into the form.
      formPatches.set(unit.handle!, {
        ref: record.ref,
        dict: record.dict,
        bytes: concat('q ', unit.opsBase, `Q ${inverse(unit.ctm).map(num).join(' ')} cm ${opsNew}`),
      })
    }
    if (!pageBytes) continue
    mountFonts(doc, source.resources, embedded, page.node)
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(pageBytes)))
    if (translatedPages.has(pageIndex)) writtenPages.push(pageIndex)
  }
  for (const patch of formPatches.values()) rewriteForm(doc, patch.ref, patch.dict, patch.bytes)

  // only_include_translated_page: mono and dual keep the chosen pages only.
  const kept = selected && options.onlyTranslatedPages ? [...selected].sort((a, b) => a - b) : null
  if (kept) keepPages(doc, kept)
  const monoBytes = await doc.save({ useObjectStreams: true })
  await writeFileAtomic(request.monoPath, monoBytes)
  let dualBytes: number | null = null
  if (request.dualPath) {
    const dual = await buildDualPdf(sourceBytes, monoBytes, {
      title: sourceTitle,
      mode: options.dualMode,
      translateFirst: options.dualTranslateFirst,
      keep: kept,
    })
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
  // Pages are renumbered when only the chosen ones are kept.
  const renumber = kept ? new Map(kept.map((page, i) => [page, i])) : null
  return {
    ...result,
    writtenPages: renumber ? writtenPages.flatMap((p) => renumber.get(p) ?? []) : writtenPages,
    monoPages: kept ? kept.length : pages.length,
  }
}

/** A translation with compositions; a kept or missing one draws the original glyphs. */
function translated(row: TranslatedParagraph | undefined) {
  if (!row || row.kept || !row.comps) return undefined
  return row.comps
}

/**
 * ParagraphFinder.add_text_fill_background (OCR workaround): a white rectangle over the union
 * of each paragraph's box and its layout box, drawn before any character.
 */
function whiteBackgrounds(unit: LayoutUnit): string {
  let ops = ''
  unit.paragraphs.forEach((para, index) => {
    const layout = unit.infos[index]?.layoutBox
    if (!layout) return
    const x1 = Math.min(para.x0, layout[0])
    const y1 = Math.min(para.y0, layout[1])
    const x2 = Math.max(para.x1, layout[2])
    const y2 = Math.max(para.y1, layout[3])
    if (!(x2 > x1 && y2 > y1)) return
    // PDFCreater._render_rectangle with WHITE and line width 0.1.
    ops += `q 1 g 1 G  ${fix6(0.1)} w ${fix6(x1)} ${fix6(y1)} ${fix6(x2 - x1)} ${fix6(y2 - y1)} re  f  n Q\n`
  })
  return ops
}

function fix6(value: number): string {
  return value.toFixed(6)
}

/** The bundled fonts any laid-out character uses (FontMapper.add_font's used_font_ids). */
async function embedUsedFonts(
  doc: PDFDocument,
  pages: readonly ReflowPage[],
  fontSet: BundledFontSet,
  embedded: Map<string, PDFFont>,
): Promise<void> {
  const used = new Set<string>()
  for (const page of pages) {
    for (const p of page.paragraphs) {
      for (const unit of p.units ?? []) if (unit.kind === 'text') used.add(unit.font)
    }
  }
  for (const file of used) embedded.set(file, await embedFont(doc, fontSet.bytes(file)))
}

async function embedFont(doc: PDFDocument, bytes: Uint8Array): Promise<PDFFont> {
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

/**
 * get_max_right_space / get_max_bottom_space start from `cropbox.x2 * 0.9` and
 * `cropbox.y * 1.1` in PDF user space; paragraphs are relative to the crop box. BabelDOC does
 * not rotate pages, so a rotated page uses its displayed box from the origin.
 */
function pageLimits(page: PDFPage): { right: number; bottom: number } {
  const crop = page.getCropBox()
  const rotate = ((page.getRotation().angle % 360) + 360) % 360
  if (rotate === 0) {
    return { right: (crop.x + crop.width) * 0.9 - crop.x, bottom: crop.y * 1.1 - crop.y }
  }
  const width = rotate === 180 ? crop.width : crop.height
  return { right: width * 0.9, bottom: 0 }
}

/** FontMapper.add_font: the embedded fonts join every /Font dictionary a stream uses. */
function mountFonts(
  doc: PDFDocument,
  resources: PDFDict | undefined,
  embedded: ReadonlyMap<string, PDFFont>,
  owner?: PDFDict,
): void {
  if (embedded.size === 0) return
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
  for (const [file, font] of embedded) fontDict.set(PDFName.of(fontResourceName(file)), font.ref)
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
