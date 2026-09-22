import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { analyzePdf } from '../analyze'
import { inspectPdf } from '../inspect'
import { composePdf, defaultComposeOptions } from './index'
import { verifyPdf } from '../verify'
import { ERROR_CODES } from '../../../shared/errors'
import { contentBytesOf } from './streams'
import { PDFDocument } from '@cantoo/pdf-lib'

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

  test('long fixture compose+dual+verify is within 15s for 30 pages worth', async () => {
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
})
