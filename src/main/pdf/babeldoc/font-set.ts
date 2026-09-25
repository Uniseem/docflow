// The bundled fonts as FontMapper and the typesetter use them (pymupdf.Font.has_glyph and
// char_lengths in BabelDOC), loaded on first use: most documents never reach the fallbacks.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import fontkit, { type Font as FontkitFont } from '@cantoo/fontkit'
import { ERROR_CODES, PermanentError } from '../../../shared/errors'
import { bundledFont } from './fonts'

export class BundledFontSet {
  readonly #dir: string
  readonly #fonts = new Map<string, { bytes: Uint8Array; font: FontkitFont }>()
  readonly #widths = new Map<string, number>()

  constructor(dir: string) {
    this.#dir = dir
  }

  #load(file: string): { bytes: Uint8Array; font: FontkitFont } {
    let entry = this.#fonts.get(file)
    if (!entry) {
      bundledFont(file)
      let bytes: Uint8Array
      try {
        bytes = new Uint8Array(readFileSync(join(this.#dir, file)))
      } catch (error) {
        // A missing font file is an installation problem, not an internal error.
        throw Object.assign(new PermanentError(ERROR_CODES.font_embed_failed), { cause: error })
      }
      const font = fontkit.create(bytes)
      if (!font || !('glyphForCodePoint' in font)) throw new Error(`${file} is not a single font`)
      entry = { bytes, font }
      this.#fonts.set(file, entry)
    }
    return entry
  }

  bytes(file: string): Uint8Array {
    return this.#load(file).bytes
  }

  /** has_glyph(ord(ch)) != 0 */
  hasGlyph = (file: string, codePoint: number): boolean => {
    return this.#load(file).font.hasGlyphForCodePoint(codePoint)
  }

  /** char_lengths(ch, size)[0]: the glyph's advance at `size`. */
  width = (file: string, ch: string, size: number): number => {
    const key = `${file}\u0000${ch}`
    let unit = this.#widths.get(key)
    if (unit === undefined) {
      const { font } = this.#load(file)
      const glyph = font.glyphForCodePoint(ch.codePointAt(0) ?? 0)
      unit = (glyph?.advanceWidth ?? 0) / font.unitsPerEm
      this.#widths.set(key, unit)
    }
    return unit * size
  }
}
