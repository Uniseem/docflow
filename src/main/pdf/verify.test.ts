import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { analyzePdf } from './analyze'
import { composePdf, defaultComposeOptions } from './compose'
import { verifyPdf } from './verify'

const fonts = {
  regular: join(process.cwd(), 'resources/fonts/NotoSansSC-Regular.otf'),
  bold: join(process.cwd(), 'resources/fonts/NotoSansSC-Bold.otf'),
}

describe('verifyPdf', () => {
  test('rewritten single-column pages execute operator lists and contain CJK', async () => {
    const sourcePath = join(process.cwd(), 'tests/fixtures/single-column.pdf')
    const analysis = await analyzePdf(sourcePath)
    const dir = await mkdtemp(join(tmpdir(), 'df-verify-'))
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
    const verified = await verifyPdf({
      monoPath: join(dir, 'mono.pdf'),
      dualPath: join(dir, 'dual.pdf'),
      pages: analysis.pages,
      writtenPages: result.writtenPages,
    })
    expect(verified.monoPages).toBe(3)
    expect(verified.dualPages).toBe(6)
    expect(verified.translatedPagesWithoutCjk).toEqual([])
    expect(verified.sizeMismatches).toBe(0)
  })
})
