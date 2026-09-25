// BabelDOC 0.6.4 assets/embedding_assets_metadata.py: the fonts a Simplified Chinese target
// uses. CN_FONT_FAMILY is extended by __add_fallback_to_font_family with every other family's
// fonts (TW, HK, KR, JP, EN); DocFlow ships the CN and EN ones, and skips the TW/HK/KR/JP
// region fonts and their script fonts, which only matter for glyphs every earlier font lacks
// (ADR-0018). Order inside each list is BabelDOC's.
import fontsJson from './fonts.json'

export type BundledFont = {
  file: string
  bold: boolean
  italic: boolean
  monospace: boolean
  serif: boolean
  ascent: number
  descent: number
  sha3_256: string
  size: number
}

// fonts.json is also read by scripts/fetch-assets.mjs, which downloads the files.
export const BUNDLED_FONTS: readonly BundledFont[] = fontsJson

export type FontType = 'normal' | 'script' | 'fallback'

export const FONT_FAMILY: Readonly<Record<FontType, readonly string[]>> & { base: string } = {
  normal: [
    'SourceHanSerifCN-Bold.ttf',
    'SourceHanSerifCN-Regular.ttf',
    'SourceHanSansCN-Bold.ttf',
    'SourceHanSansCN-Regular.ttf',
    'NotoSerif-Regular.ttf',
    'NotoSerif-Bold.ttf',
    'NotoSans-Regular.ttf',
    'NotoSans-Bold.ttf',
  ],
  script: [
    'LXGWWenKaiGB-Regular.1.520.ttf',
    'NotoSans-Italic.ttf',
    'NotoSans-BoldItalic.ttf',
    'NotoSerif-Italic.ttf',
    'NotoSerif-BoldItalic.ttf',
  ],
  fallback: ['GoNotoKurrent-Regular.ttf', 'GoNotoKurrent-Bold.ttf'],
  base: 'SourceHanSansCN-Regular.ttf',
}

export function bundledFont(file: string): BundledFont {
  const font = BUNDLED_FONTS.find((f) => f.file === file)
  if (!font) throw new Error(`unknown bundled font ${file}`)
  return font
}

/** PDF resource name under which a bundled font is mounted (the file name without `.ttf`). */
export function fontResourceName(file: string): string {
  return `DocFlow-${file.replace(/\.ttf$/, '')}`
}
