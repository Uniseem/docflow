import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { ERROR_CODES } from '../../../shared/errors'
import { FONTS_DIR } from '../../../../tests/unit/pdf2zh-reference'
import { BundledFontSet } from './font-set'

describe('BundledFontSet', () => {
  test('glyph coverage and advance widths of a bundled font', () => {
    const fonts = new BundledFontSet(FONTS_DIR)
    expect(fonts.hasGlyph('SourceHanSerifCN-Regular.ttf', '中'.codePointAt(0)!)).toBe(true)
    expect(fonts.width('SourceHanSerifCN-Regular.ttf', '中', 10)).toBeCloseTo(10, 5)
  })

  test('a missing font file tells the user to reinstall', async () => {
    const fonts = new BundledFontSet(await mkdtemp(join(tmpdir(), 'df-fonts-')))
    expect(() => fonts.hasGlyph('NotoSerif-Regular.ttf', 65)).toThrow(
      expect.objectContaining({ code: ERROR_CODES.font_embed_failed, permanent: true }) as Error,
    )
  })
})
