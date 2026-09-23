import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { PDFDocument } from '@cantoo/pdf-lib'
import { analyzePdf } from '../analyze'
import { composePdf, defaultComposeOptions } from './index'
import { loadPageGraph } from './resources'
import type * as Emit from './emit'

vi.mock('./emit', async (importOriginal) => {
  const actual = await importOriginal<typeof Emit>()
  return {
    ...actual,
    emitPageOps: () => {
      throw new Error('encode failed')
    },
  }
})

const fixtures = join(process.cwd(), 'tests/fixtures')
const fonts = {
  regular: join(process.cwd(), 'resources/fonts/NotoSansSC-Regular.otf'),
  bold: join(process.cwd(), 'resources/fonts/NotoSansSC-Bold.otf'),
}

async function formContent(path: string): Promise<string> {
  const doc = await PDFDocument.load(await readFile(path))
  const graph = loadPageGraph(doc, doc.getPages()[0]!)
  return Buffer.from(graph.getForm('Fm1')?.content ?? new Uint8Array()).toString('latin1')
}

describe('compose page rewrite is all-or-nothing', () => {
  test('form streams stay untouched when emitting the page fails', async () => {
    const sourcePath = join(fixtures, 'form-wrapped.pdf')
    const analysis = await analyzePdf(sourcePath)
    expect(analysis.paragraphs.some((p) => p.translatable && p.formPath === '1')).toBe(true)
    const monoPath = join(await mkdtemp(join(tmpdir(), 'df-rollback-')), 'mono.pdf')
    const result = await composePdf({
      sourcePath,
      monoPath,
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
    expect(result.warnings.some((w) => w.code === 'encode_failed')).toBe(true)
    expect(result.writtenPages).toEqual([])
    const before = await formContent(sourcePath)
    expect(before).toContain('Tj')
    expect(await formContent(monoPath)).toBe(before)
  }, 30_000)
})
