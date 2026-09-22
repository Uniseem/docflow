import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { ERROR_CODES, PermanentError } from '../../shared/errors'
import { inspectPdf } from './inspect'

const fixtures = join(process.cwd(), 'tests/fixtures')

describe('inspectPdf', () => {
  test('encrypted pdf', async () => {
    await expect(inspectPdf(join(fixtures, 'encrypted.pdf'))).rejects.toMatchObject({
      code: ERROR_CODES.pdf_encrypted,
    })
  })

  test('scanned pdf', async () => {
    await expect(inspectPdf(join(fixtures, 'scanned.pdf'))).rejects.toMatchObject({
      code: ERROR_CODES.scanned_pdf,
    })
  })

  test('invisible text counts as scanned', async () => {
    await expect(inspectPdf(join(fixtures, 'invisible-text.pdf'))).rejects.toMatchObject({
      code: ERROR_CODES.scanned_pdf,
    })
  })

  test('empty pdf', async () => {
    await expect(inspectPdf(join(fixtures, 'empty.pdf'))).rejects.toMatchObject({
      code: ERROR_CODES.pdf_empty,
    })
  })

  test('invalid header', async () => {
    const tmp = join(fixtures, 'README.md')
    await expect(inspectPdf(tmp)).rejects.toBeInstanceOf(PermanentError)
    await expect(inspectPdf(tmp)).rejects.toMatchObject({ code: ERROR_CODES.pdf_invalid })
  })

  test('normal single-column', async () => {
    const info = await inspectPdf(join(fixtures, 'single-column.pdf'))
    expect(info.pages).toBe(3)
    expect(info.pageSizes).toEqual([
      [612, 792],
      [612, 792],
      [612, 792],
    ])
    expect(info.hasTextLayer).toBe(true)
    expect(info.visibleTextChars).toBeGreaterThan(200)
  })
})
