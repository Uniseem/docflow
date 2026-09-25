import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDict, PDFName } from '@cantoo/pdf-lib'
import { describe, expect, test } from 'vitest'
import { ERROR_CODES } from '../../../shared/errors'
import type { AnalysisResult, TranslatedParagraph } from '../../../shared/pdf-types'
import {
  NOTO_FONT,
  fixture,
  fixturesDir,
  referenceLayouts,
} from '../../../../tests/unit/pdf2zh-reference'
import { analyzePdf } from '../analyze'
import { inspectPdf } from '../inspect'
import { loadPdfLib } from '../load-pdf-lib'
import { openPdfDocument } from '../pdfjs'
import { segmentsOf } from '../pdf2zh/segments'
import { verifyPdf } from '../verify'
import { composePdf } from './index'
import { streamBytes } from './streams'

const ERROR_FILES: Record<string, string> = {
  encrypted: ERROR_CODES.pdf_encrypted,
  scanned: ERROR_CODES.scanned_pdf,
  empty: ERROR_CODES.pdf_empty,
  'invisible-text': ERROR_CODES.scanned_pdf,
}

/** Chinese stand-in for a translation that keeps the {vN} markers in place. */
function fakeTranslations(analysis: AnalysisResult): TranslatedParagraph[] {
  return segmentsOf(analysis).map((segment) => ({
    id: segment.id,
    text: segment.text.replace(/[A-Za-z]+/g, '译文'),
    kept: false,
  }))
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

async function compose(name: string) {
  const sourcePath = fixture(name)
  const analysis = await analyzePdf(sourcePath, referenceLayouts(name))
  const dir = await mkdtemp(join(tmpdir(), 'df-compose-'))
  const result = await composePdf({
    sourcePath,
    monoPath: join(dir, 'mono.pdf'),
    dualPath: join(dir, 'dual.pdf'),
    analysis,
    translations: fakeTranslations(analysis),
    fonts: { noto: NOTO_FONT },
  })
  return { analysis, result, mono: join(dir, 'mono.pdf'), dual: join(dir, 'dual.pdf') }
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
      const { analysis, result, mono, dual } = await compose(name)
      expect(result.paragraphsWritten).toBe(analysis.stats.translatable)
      expect(result.opsRemoved).toBeGreaterThan(0)
      const text = (await pageText(mono)).join('\n')
      // Every translated paragraph was redrawn as 译文; only formula characters stay Latin.
      const formulaText = analysis.units
        .flatMap((unit) => unit.formulas.flatMap((f) => f.chars.map((c) => c.text)))
        .join('')
      const leftover = (text.match(/[A-Za-z]{4,}/g) ?? []).filter(
        (word) => !formulaText.includes(word),
      )
      expect(leftover).toEqual([])
      expect(text).toContain('译文')
      const verified = await verifyPdf({
        monoPath: mono,
        dualPath: dual,
        pages: analysis.pages,
        writtenPages: result.writtenPages,
      })
      expect(verified.dualPages).toBe(analysis.pages * 2)
      expect(verified.translatedPagesWithoutCjk).toEqual([])
    },
  )

  test('page contents are q {ops_base}Q 1 0 0 1 x0 y0 cm BT … ET with tiro and noto mounted', async () => {
    const { mono } = await compose('single-column')
    const doc = await loadPdfLib(await readFile(mono))
    for (const page of doc.getPages()) {
      // The stream as written (pdf-lib's normalize() would wrap it in another q/Q).
      const content = Buffer.from(
        streamBytes(doc.context.lookup(page.node.get(PDFName.of('Contents')))),
      ).toString('latin1')
      expect(content.startsWith('q ')).toBe(true)
      expect(content).toMatch(/Q 1 0 0 1 [-\d.]+ [-\d.]+ cm BT /)
      expect(content.trimEnd().endsWith('ET')).toBe(true)
      // Only the redraw draws text: Tf appears after the base stream's closing Q.
      const base = content.slice(0, content.search(/Q 1 0 0 1 [-\d.]+ [-\d.]+ cm BT /))
      expect(base).not.toMatch(/\bT[jJ]\b/)
      const fonts = page.node.Resources()?.lookup(PDFName.of('Font'), PDFDict)
      expect(fonts?.has(PDFName.of('tiro'))).toBe(true)
      expect(fonts?.has(PDFName.of('noto'))).toBe(true)
    }
  })

  test('a form XObject is rewritten in its own stream through the inverse CTM', async () => {
    const { mono } = await compose('form-wrapped')
    const doc = await loadPdfLib(await readFile(mono))
    const xobjects = doc.getPages()[0]!.node.Resources()?.lookup(PDFName.of('XObject'), PDFDict)
    const [, ref] = [...(xobjects?.entries() ?? [])][0]!
    const form = Buffer.from(streamBytes(doc.context.lookup(ref))).toString('latin1')
    // do_Do: `q {ops_base}Q a b c d e f cm {ops_new}`
    expect(form).toMatch(/^q .*Q [-\d.e]+ [-\d.e]+ [-\d.e]+ [-\d.e]+ [-\d.e]+ [-\d.e]+ cm BT /s)
    const base = form.slice(0, form.lastIndexOf(' cm BT '))
    expect(base).not.toMatch(/\bT[jJ]\b/)
  })

  test('shared form: body text translated, the form redrawn as pdf2zh keeps it', async () => {
    const { analysis, result, mono } = await compose('shared-form')
    expect(result.writtenPages).toEqual([0, 1])
    const formulaText = analysis.units
      .flatMap((unit) => unit.formulas.flatMap((f) => f.chars.map((c) => c.text)))
      .join('')
    for (const page of await pageText(mono)) {
      const words = page.match(/[A-Za-z]{4,}/g) ?? []
      expect(words.filter((word) => !formulaText.includes(word))).toEqual([])
    }
  })

  test('long fixture compose+dual+verify stays within 30 s', { timeout: 120_000 }, async () => {
    const started = Date.now()
    const { analysis, result, mono, dual } = await compose('long')
    const verified = await verifyPdf({
      monoPath: mono,
      dualPath: dual,
      pages: analysis.pages,
      writtenPages: result.writtenPages,
    })
    expect(verified.monoPages).toBe(analysis.pages)
    expect(Date.now() - started).toBeLessThan(30_000)
  })
})
