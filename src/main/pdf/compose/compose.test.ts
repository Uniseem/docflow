import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDict, PDFDocument, PDFName, StandardFonts, degrees, rgb } from '@cantoo/pdf-lib'
import * as mupdf from 'mupdf'
import { describe, expect, test } from 'vitest'
import { ERROR_CODES } from '../../../shared/errors'
import type { AnalysisResult, ComposeOptions, TranslatedParagraph } from '../../../shared/pdf-types'
import { fakeTranslations } from '../../../../tests/unit/fake-translations'
import {
  FONTS_DIR,
  fixture,
  fixturesDir,
  referenceLayouts,
} from '../../../../tests/unit/pdf2zh-reference'
import { buildParagraphs } from '../../translate/babeldoc/paragraphs'
import { analyzePdf } from '../analyze'
import { inspectPdf } from '../inspect'
import { loadPdfLib } from '../load-pdf-lib'
import { openPdfDocument } from '../pdfjs'
import { verifyPdf } from '../verify'
import { composePdf } from './index'
import { streamBytes } from './streams'

const ERROR_FILES: Record<string, string> = {
  encrypted: ERROR_CODES.pdf_encrypted,
  scanned: ERROR_CODES.scanned_pdf,
  empty: ERROR_CODES.pdf_empty,
}

/** Words the output may still show: formulas and paragraphs left untranslated. */
function keptText(analysis: AnalysisResult, translations: readonly TranslatedParagraph[]): string {
  const done = new Set(translations.map((t) => t.id))
  const formulas = analysis.units.flatMap((unit) =>
    unit.formulas.flatMap((f) => f.chars.map((c) => c.text)),
  )
  const kept = buildParagraphs(analysis)
    .filter((p) => !done.has(p.id))
    .map((p) => p.unicode)
  return `${formulas.join('')}\n${kept.join('\n')}`
}

async function pageText(path: string): Promise<string[]> {
  const doc = await openPdfDocument(await readFile(path))
  const out: string[] = []
  for (let i = 1; i <= doc.numPages; i += 1) {
    const content = await (await doc.getPage(i)).getTextContent()
    out.push(content.items.map((item) => ('str' in item ? item.str : '')).join(''))
  }
  await doc.cleanup()
  return out
}

async function compose(name: string, options?: Partial<ComposeOptions>) {
  const sourcePath = fixture(name)
  const analysis = await analyzePdf(sourcePath, referenceLayouts(name))
  const dir = await mkdtemp(join(tmpdir(), 'df-compose-'))
  const translations = fakeTranslations(analysis)
  const result = await composePdf({
    sourcePath,
    monoPath: join(dir, 'mono.pdf'),
    dualPath: join(dir, 'dual.pdf'),
    analysis,
    translations,
    fonts: { dir: FONTS_DIR },
    options: options ?? {},
  })
  return {
    analysis,
    translations,
    result,
    mono: join(dir, 'mono.pdf'),
    dual: join(dir, 'dual.pdf'),
  }
}

describe('composePdf (pdf2zh write-back)', () => {
  test('inspect error fixtures keep their codes', async () => {
    for (const [name, code] of Object.entries(ERROR_FILES)) {
      await expect(inspectPdf(join(fixturesDir, `${name}.pdf`))).rejects.toMatchObject({ code })
    }
  })

  test.each(['single-column', 'two-column', 'inline-formula', 'display-math', 'colored-text'])(
    '%s: the original text is gone, translations and formulas are drawn',
    { timeout: 60_000 },
    async (name) => {
      const { analysis, translations, result, mono, dual } = await compose(name)
      expect(result.paragraphsWritten).toBe(translations.length)
      expect(result.paragraphsWritten).toBeGreaterThan(0)
      expect(result.opsRemoved).toBeGreaterThan(0)
      const text = (await pageText(mono)).join('\n')
      // Every translated paragraph was redrawn as 译文; only formulas and paragraphs BabelDOC
      // leaves alone (short, numeric) keep Latin words, with their original glyphs.
      const kept = keptText(analysis, translations)
      const leftover = (text.match(/[A-Za-z]{4,}/g) ?? []).filter((word) => !kept.includes(word))
      expect(leftover).toEqual([])
      expect(text).toContain('译文')
      const verified = await verifyPdf({
        monoPath: mono,
        dualPath: dual,
        pages: analysis.pages,
        writtenPages: result.writtenPages,
        dualMode: 'side-by-side',
      })
      expect(verified.dualPages).toBe(analysis.pages)
      expect(verified.sizeMismatches).toBe(0)
      expect(verified.translatedPagesWithoutCjk).toEqual([])
    },
  )

  test('page contents are q {ops_base}Q 1 0 0 1 x0 y0 cm {ops_new} with the used fonts mounted', async () => {
    const { mono } = await compose('single-column')
    const doc = await loadPdfLib(await readFile(mono))
    // ops_new: text objects, wrapped in q {graphic state} … Q when the text has a colour.
    const prefix = /Q 1 0 0 1 [-\d.]+ [-\d.]+ cm (q [^B]*)?BT /
    for (const page of doc.getPages()) {
      // The stream as written (pdf-lib's normalize() would wrap it in another q/Q).
      const content = Buffer.from(
        streamBytes(doc.context.lookup(page.node.get(PDFName.of('Contents')))),
      ).toString('latin1')
      expect(content.startsWith('q ')).toBe(true)
      expect(content).toMatch(prefix)
      expect(content.trimEnd()).toMatch(/ET( Q)?$/)
      // Only the redraw draws text: Tf appears after the base stream's closing Q.
      const base = content.slice(0, content.search(prefix))
      expect(base).not.toMatch(/\bT[jJ]\b/)
      const fonts = page.node.Resources()?.lookup(PDFName.of('Font'), PDFDict)
      // Times-Roman is not embedded, so it maps like Noto Serif Regular: Source Han Serif.
      expect(fonts?.has(PDFName.of('DocFlow-SourceHanSerifCN-Regular'))).toBe(true)
      expect(fonts?.has(PDFName.of('tiro'))).toBe(false)
    }
  })

  test('a form XObject is rewritten in its own stream through the inverse CTM', async () => {
    const { mono } = await compose('form-wrapped')
    const doc = await loadPdfLib(await readFile(mono))
    const xobjects = doc.getPages()[0]!.node.Resources()?.lookup(PDFName.of('XObject'), PDFDict)
    const [, ref] = [...(xobjects?.entries() ?? [])][0]!
    const form = Buffer.from(streamBytes(doc.context.lookup(ref))).toString('latin1')
    // do_Do: `q {ops_base}Q a b c d e f cm {ops_new}`
    const prefix = /^q .*Q [-\d.e]+ [-\d.e]+ [-\d.e]+ [-\d.e]+ [-\d.e]+ [-\d.e]+ cm (q [^B]*)?BT /s
    expect(form).toMatch(prefix)
    const base = form.slice(0, form.search(/ [-\d.e]+ cm (q [^B]*)?BT /))
    expect(base).not.toMatch(/\bT[jJ]\b/)
  })

  test('shared form: body text translated, the form redrawn as pdf2zh keeps it', async () => {
    const { analysis, translations, result, mono } = await compose('shared-form')
    expect(result.writtenPages).toEqual([0, 1])
    const kept = keptText(analysis, translations)
    for (const page of await pageText(mono)) {
      const words = page.match(/[A-Za-z]{4,}/g) ?? []
      expect(words.filter((word) => !kept.includes(word))).toEqual([])
    }
  })

  test('colours of the original text carry over to the translation', async () => {
    const { mono } = await compose('colored-text')
    const doc = await loadPdfLib(await readFile(mono))
    const content = Buffer.from(
      streamBytes(doc.context.lookup(doc.getPages()[0]!.node.get(PDFName.of('Contents')))),
    ).toString('latin1')
    // BabelDOC passthrough: the translated red title keeps its colour, and so does the blue
    // line pdf2zh keeps as a formula ({v0}), redrawn in its own font.
    expect(content).toMatch(/q [^B]*\b0\.8 0\.1 0\.1 rg BT \/DocFlow-/)
    expect(content).toMatch(/q [^B]*\b0\.1 0\.2 0\.7 rg BT \/(?!DocFlow-)\S+ 11\.000000 Tf /)
  })

  test('a /Rotate 90 page: upright translation in place, inline image and colours kept', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'df-rotate-'))
    const src = join(dir, 'rotated.pdf')
    const lib = await PDFDocument.create()
    const font = await lib.embedFont(StandardFonts.TimesRoman)
    const page = lib.addPage([612, 792])
    page.setRotation(degrees(90))
    // Drawn turned by 90° so that it reads upright once the viewer applies /Rotate.
    const line = (text: string, x: number, y: number, color = rgb(0, 0, 0)) =>
      page.drawText(text, { x: 612 - y, y: x, size: 11, font, rotate: degrees(90), color })
    line('Landscape results of the catalysts compared here', 72, 560, rgb(0.8, 0.1, 0.1))
    line('Each row gives the ammonia yield under visible light', 72, 500)
    line('and the apparent quantum efficiency at 420 nm.', 72, 486)
    const image = 'q 20 0 0 20 300 300 cm BI /W 2 /H 2 /BPC 8 /CS /G ID \x00\xff\xff\x00 EI Q'
    page.node.addContentStream(lib.context.register(lib.context.stream(image)))
    await writeFile(src, await lib.save())

    // Display space is 792 × 612; boxes in pixels from the top-left like the model's.
    const layout = {
      width: 792,
      height: 612,
      boxes: [
        { name: 'title', conf: 0.9, xyxy: [60, 40, 400, 62] as [number, number, number, number] },
        {
          name: 'plain text',
          conf: 0.9,
          xyxy: [60, 100, 420, 135] as [number, number, number, number],
        },
      ],
    }
    const analysis = await analyzePdf(src, [layout])
    expect(analysis.units[0]!.texts).toHaveLength(2)
    const mono = join(dir, 'mono.pdf')
    await composePdf({
      sourcePath: src,
      monoPath: mono,
      dualPath: null,
      analysis,
      translations: fakeTranslations(analysis),
      fonts: { dir: FONTS_DIR },
    })
    const out = mupdf.Document.openDocument(await readFile(mono), 'application/pdf')
    const stext = JSON.parse(out.loadPage(0).toStructuredText().asJSON()) as {
      blocks: Array<{
        lines?: Array<{ bbox: { x: number; y: number; w: number; h: number }; text: string }>
      }>
    }
    const lines = stext.blocks.flatMap((block) => block.lines ?? [])
    expect(lines.map((l) => l.text).join('')).toContain('译文')
    expect(lines.map((l) => l.text).join('')).not.toMatch(/[A-Za-z]{4,}/)
    for (const l of lines) {
      // Upright (wider than tall) and inside the displayed boxes the text came from.
      expect(l.bbox.w).toBeGreaterThan(l.bbox.h)
      expect(l.bbox.x).toBeGreaterThanOrEqual(71)
      expect(l.bbox.y).toBeGreaterThan(30)
      expect(l.bbox.y + l.bbox.h).toBeLessThan(140)
    }
    const doc = await loadPdfLib(await readFile(mono))
    const content = Buffer.from(
      streamBytes(doc.context.lookup(doc.getPages()[0]!.node.get(PDFName.of('Contents')))),
    ).toString('latin1')
    expect(content).toContain('BI /W 2 /H 2 /BPC 8 /CS /G ID \x00\xff\xff\x00 EI')
    expect(content).toMatch(/q [^B]*\b0\.8 0\.1 0\.1 rg BT \/DocFlow-/)
  })

  test('OCR workaround: black translations on white backgrounds, the page picture kept', async () => {
    const sourcePath = fixture('ocr-scan')
    // Three paragraphs per page (DocLayout-YOLO image space: origin top left, 72 dpi).
    const box = (top: number) => ({
      name: 'plain text',
      conf: 0.9,
      xyxy: [66, top, 545, top + 36] as [number, number, number, number],
    })
    const layouts = Array.from({ length: 3 }, () => ({
      width: 612,
      height: 792,
      boxes: [box(57), box(105), box(153)],
    }))
    const analysis = await analyzePdf(sourcePath, layouts, { ocrWorkaround: true })
    expect(analysis.ocrWorkaround).toBe(true)
    const translations = fakeTranslations(analysis, { richText: false })
    const dir = await mkdtemp(join(tmpdir(), 'df-compose-'))
    const mono = join(dir, 'mono.pdf')
    const result = await composePdf({
      sourcePath,
      monoPath: mono,
      dualPath: null,
      analysis,
      translations,
      fonts: { dir: FONTS_DIR },
    })
    expect(result.writtenPages).toEqual([0, 1, 2])
    const doc = await loadPdfLib(await readFile(mono))
    const content = Buffer.from(
      streamBytes(doc.context.lookup(doc.getPages()[0]!.node.get(PDFName.of('Contents')))),
    ).toString('latin1')
    // PDFCreater._render_rectangle(WHITE, line width 0.1) before any text, then BLACK text.
    const rectangles = content.match(
      /q 1 g 1 G {2}0\.100000 w [\d.]+ [\d.]+ [\d.]+ [\d.]+ re {2}f {2}n Q/g,
    )
    expect(rectangles).toHaveLength(3)
    expect(content.indexOf('re  f  n Q')).toBeLessThan(content.indexOf(' Tf '))
    expect(content).toMatch(/q 0 g 0 G BT \/DocFlow-/)
    expect(content).toMatch(/ Do\b/)

    const rendered = new mupdf.PDFDocument(await readFile(mono))
    const page = rendered.loadPage(0)
    expect(page.toStructuredText().asText()).toContain('译文 1.1')
    const pix = page.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, false, true)
    const at = (x: number, y: number) => pix.getPixels()[y * pix.getStride() + x]!
    // The first box shows the black translation; the picture's empty lower half is unchanged.
    let darkest = 255
    for (let y = 60; y < 90; y += 1)
      for (let x = 60; x < 540; x += 1) darkest = Math.min(darkest, at(x, y))
    expect(darkest).toBeLessThan(80)
    expect(at(300, 600)).toBeGreaterThan(240)
    rendered.destroy()
  })

  test('long fixture compose+dual+verify stays within 30 s', { timeout: 120_000 }, async () => {
    const started = Date.now()
    const { analysis, result, mono, dual } = await compose('long')
    const verified = await verifyPdf({
      monoPath: mono,
      dualPath: dual,
      pages: analysis.pages,
      writtenPages: result.writtenPages,
      dualMode: 'side-by-side',
    })
    expect(verified.monoPages).toBe(analysis.pages)
    expect(Date.now() - started).toBeLessThan(30_000)
  })
})
