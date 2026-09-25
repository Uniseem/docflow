// BabelDOC 0.6.4 format/pdf/document_il/utils/fontmap.py FontMapper.map / map_in_type: picks
// the bundled font for one character of a translation from the original font's flags.
import type { FontFlags } from '../../../shared/pdf-types'
import { bundledFont, FONT_FAMILY, type FontType } from './fonts'

/** translation_config.primary_font_family; 'auto' is None. */
export type PrimaryFontFamily = 'auto' | 'serif' | 'sans-serif' | 'script'

export type HasGlyph = (file: string, codePoint: number) => boolean

export class FontMapper {
  readonly #primary: PrimaryFontFamily
  readonly #hasGlyph: HasGlyph
  readonly #cache = new Map<string, string | null>()

  constructor(primary: PrimaryFontFamily, hasGlyph: HasGlyph) {
    this.#primary = primary
    this.#hasGlyph = hasGlyph
  }

  /** The bundled font file for `char`, or null when no font has it (BabelDOC then drops it). */
  map(original: FontFlags | undefined, char: string): string | null {
    const key = `${flagKey(original)}\u0000${char}`
    const hit = this.#cache.get(key)
    if (hit !== undefined) return hit
    const result = this.#map(original, char)
    this.#cache.set(key, result)
    return result
  }

  #map(original: FontFlags | undefined, char: string): string | null {
    const codePoint = char.codePointAt(0) ?? 0
    const bold = Boolean(original?.bold)
    let italic = Boolean(original?.italic)
    let serif = Boolean(original?.serif)
    if (this.#primary === 'serif') serif = true
    else if (this.#primary === 'sans-serif') serif = false
    else if (this.#primary === 'script') {
      serif = false
      italic = true
    }

    const script = this.#mapInType(bold, italic, serif, codePoint, 'script')
    if (script) return script
    for (const file of FONT_FAMILY.script) {
      if (italic && this.#hasGlyph(file, codePoint)) return file
    }
    const normal = this.#mapInType(bold, italic, serif, codePoint, 'normal')
    if (normal) return normal
    const fallback = this.#mapInType(bold, italic, serif, codePoint, 'fallback')
    if (fallback) return fallback
    for (const file of FONT_FAMILY.fallback) {
      if (this.#hasGlyph(file, codePoint)) return file
    }
    return null
  }

  #mapInType(
    bold: boolean,
    italic: boolean,
    serif: boolean,
    codePoint: number,
    type: FontType,
  ): string | null {
    if (type === 'script' && !italic) return null
    for (const file of FONT_FAMILY[type]) {
      if (!this.#hasGlyph(file, codePoint)) continue
      if (bold !== bundledFont(file).bold) continue
      // 不知道什么原因，思源黑体的 serif 属性为 1，先 workaround
      const named = file.toLowerCase().includes('serif')
      if (serif && !named) continue
      if (!serif && named) continue
      return file
    }
    return null
  }
}

function flagKey(flags: FontFlags | undefined): string {
  if (!flags) return '-'
  return [flags.bold, flags.italic, flags.monospace, flags.serif]
    .map((v) => (v === null ? '-' : v ? '1' : '0'))
    .join('')
}
