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

  test('a failed check explains itself in Chinese and stays retryable', async () => {
    const sourcePath = join(process.cwd(), 'tests/fixtures/single-column.pdf')
    const failure = verifyPdf({ monoPath: sourcePath, dualPath: null, pages: 4, writtenPages: [] })
    await expect(failure).rejects.toMatchObject({
      code: 'verify_failed',
      permanent: false,
      message: '生成的 PDF 未通过校验（中文 PDF 有 3 页，原文有 4 页），稍后自动重试。',
    })
    await expect(
      verifyPdf({ monoPath: sourcePath, dualPath: null, pages: 3, writtenPages: [0, 2] }),
    ).rejects.toMatchObject({
      message: '生成的 PDF 未通过校验（第 1、3 页写入译文后没有中文），稍后自动重试。',
    })
  })
})
