import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { analyzePdf } from '../analyze'
import { inspectPdf } from '../inspect'
import { composePdf, defaultComposeOptions } from './index'
import { verifyPdf } from '../verify'
import { ERROR_CODES } from '../../../shared/errors'
import { contentBytesOf } from './streams'
import {
  PDFDocument,
  PDFName,
  StandardFonts,
  beginText,
  drawObject,
  endText,
  setFontAndSize,
  setTextMatrix,
  showText,
} from '@cantoo/pdf-lib'
import { loadPageGraph } from './resources'

const fixtures = join(process.cwd(), 'tests/fixtures')
const fonts = {
  regular: join(process.cwd(), 'resources/fonts/NotoSansSC-Regular.otf'),
  bold: join(process.cwd(), 'resources/fonts/NotoSansSC-Bold.otf'),
}

const ERROR_FILES: Record<string, string> = {
  'encrypted.pdf': ERROR_CODES.pdf_encrypted,
  'scanned.pdf': ERROR_CODES.scanned_pdf,
  'empty.pdf': ERROR_CODES.pdf_empty,
  'invisible-text.pdf': ERROR_CODES.scanned_pdf,
}

describe('pdf compose integration', () => {
  test('inspect error fixtures keep their codes', async () => {
    for (const [name, code] of Object.entries(ERROR_FILES)) {
      await expect(inspectPdf(join(fixtures, name))).rejects.toMatchObject({ code })
    }
  })

  test('fake-translate compose+verify for synthetic fixtures', async () => {
    const names = (await readdir(fixtures)).filter(
      (name) =>
        name.endsWith('.pdf') &&
        !name.startsWith('arxiv-') &&
        !ERROR_FILES[name] &&
        name !== 'long.pdf',
    )
    const dir = await mkdtemp(join(tmpdir(), 'df-compose-'))
    for (const name of names) {
      const sourcePath = join(fixtures, name)
      const analysis = await analyzePdf(sourcePath)
      const translations = analysis.paragraphs.map((para) => ({
        id: para.id,
        text: para.translatable ? `译${para.text}` : para.text,
        kept: !para.translatable,
      }))
      const monoPath = join(dir, `${name}.zh.pdf`)
      const dualPath = join(dir, `${name}.dual.pdf`)
      const result = await composePdf({
        sourcePath,
        monoPath,
        dualPath,
        analysis,
        translations,
        fonts,
        options: defaultComposeOptions(),
      })
      expect(result.monoBytes, name).toBeGreaterThan(1024)
      expect(result.dualBytes, name).toBeGreaterThan(1024)
      if (analysis.stats.translatable > 0) {
        expect(result.paragraphsWritten, `${name} written`).toBeGreaterThan(0)
        expect(result.writtenPages.length, `${name} pages`).toBeGreaterThan(0)
        expect(
          result.warnings.filter((w) => w.code === 'page_skipped'),
          `${name} page_skipped`,
        ).toHaveLength(0)
      }
      const verified = await verifyPdf({
        monoPath,
        dualPath,
        pages: analysis.pages,
        writtenPages: result.writtenPages,
      })
      expect(verified.monoPages, name).toBe(analysis.pages)
      expect(verified.dualPages, name).toBe(analysis.pages * 2)
      expect(verified.translatedPagesWithoutCjk, name).toEqual([])

      const source = await PDFDocument.load(await readFile(sourcePath), { ignoreEncryption: true })
      const mono = await PDFDocument.load(await readFile(monoPath), { ignoreEncryption: true })
      const keptParas = analysis.paragraphs.filter(
        (p) => !p.translatable && p.text.trim().length > 4,
      )
      const sample = keptParas[0]
      if (sample && sample.formPath === '') {
        const original = Buffer.from(contentBytesOf(source.getPages()[sample.page]!)).toString(
          'latin1',
        )
        const rewritten = Buffer.from(contentBytesOf(mono.getPages()[sample.page]!)).toString(
          'latin1',
        )
        const snippet = sample.text.slice(0, 8)
        if (original.includes(snippet.split(' ')[0] ?? '')) {
          expect(rewritten.length, name).toBeGreaterThan(10)
        }
      }
    }
  }, 120_000)

  test('long fixture compose+dual+verify is within 30s for 30 pages worth', async () => {
    const sourcePath = join(fixtures, 'long.pdf')
    const analysis = await analyzePdf(sourcePath)
    const dir = await mkdtemp(join(tmpdir(), 'df-long-'))
    const started = Date.now()
    const result = await composePdf({
      sourcePath,
      monoPath: join(dir, 'mono.pdf'),
      dualPath: join(dir, 'dual.pdf'),
      analysis,
      translations: analysis.paragraphs.map((para) => ({
        id: para.id,
        text: para.translatable ? `译${para.text}` : para.text,
        kept: !para.translatable,
      })),
      fonts,
      options: defaultComposeOptions(),
    })
    await verifyPdf({
      monoPath: join(dir, 'mono.pdf'),
      dualPath: join(dir, 'dual.pdf'),
      pages: analysis.pages,
      writtenPages: result.writtenPages,
    })
    expect(result.paragraphsWritten).toBeGreaterThan(10)
    expect(result.writtenPages.length).toBeGreaterThan(10)
    const elapsed = Date.now() - started
    expect(elapsed, `compose+dual+verify ${elapsed}ms`).toBeLessThan(30_000)
  }, 60_000)

  test('keeps paragraphs nested inside a shared form untouched', async () => {
    const doc = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.TimesRoman)
    const nestedText = 'Nested text inside a shared form must stay the same on every page.'
    const inner = doc.context.formXObject(
      [
        beginText(),
        setFontAndSize('F1', 10),
        setTextMatrix(1, 0, 0, 1, 72, 600),
        showText(font.encodeText(nestedText)),
        endText(),
      ],
      { BBox: [0, 0, 612, 792], Matrix: [1, 0, 0, 1, 0, 0], Resources: { Font: { F1: font.ref } } },
    )
    const innerRef = doc.context.register(inner)
    const outer = doc.context.formXObject([drawObject('Inner')], {
      BBox: [0, 0, 612, 792],
      Matrix: [1, 0, 0, 1, 0, 0],
      Resources: { XObject: { Inner: innerRef } },
    })
    const outerRef = doc.context.register(outer)
    for (let i = 0; i < 2; i += 1) {
      const page = doc.addPage([612, 792])
      page.node.setXObject(PDFName.of('Shared'), outerRef)
      page.pushOperators(drawObject('Shared'))
      page.drawText(`Body text of page ${i + 1} explains the method in a single line.`, {
        x: 72,
        y: 700,
        size: 10,
        font,
      })
    }
    const dir = await mkdtemp(join(tmpdir(), 'df-nested-shared-'))
    const sourcePath = join(dir, 'nested-shared.pdf')
    await writeFile(sourcePath, await doc.save())

    const analysis = await analyzePdf(sourcePath)
    expect(analysis.forms.filter((f) => f.shared).map((f) => f.formPath)).toEqual(['1', '1'])
    // Text inside the shared form's children is not sent for translation either.
    expect(
      analysis.paragraphs.filter((p) => p.formPath.startsWith('1/') && p.translatable),
    ).toEqual([])
    const result = await composePdf({
      sourcePath,
      monoPath: join(dir, 'mono.pdf'),
      dualPath: null,
      analysis,
      translations: analysis.paragraphs.map((para) => ({
        id: para.id,
        text: `译${para.text}`,
        kept: !para.translatable,
      })),
      fonts,
      options: defaultComposeOptions(),
    })
    const codes = result.warnings.map((w) => w.code)
    expect(codes).not.toContain('page_skipped')
    expect(codes).not.toContain('op_mismatch')
    expect(result.writtenPages).toEqual([0, 1])

    const innerContent = async (path: string) => {
      const pdf = await PDFDocument.load(await readFile(path))
      const graph = loadPageGraph(pdf, pdf.getPages()[0]!)
      const form = graph.getForm('Shared')?.getForm?.('Inner')
      return Buffer.from(form?.content ?? new Uint8Array()).toString('latin1')
    }
    const before = await innerContent(sourcePath)
    expect(before).toContain('Tj')
    expect(await innerContent(join(dir, 'mono.pdf'))).toBe(before)
  }, 30_000)
})
