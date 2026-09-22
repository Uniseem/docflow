import { readFile } from 'node:fs/promises'
import fontkit from '@cantoo/fontkit'
import type { PDFDocument, PDFFont, PDFRef } from '@cantoo/pdf-lib'
import { PDF } from '../../../shared/pdf-constants'
import { ERROR_CODES, PermanentError } from '../../../shared/errors'
import type { AnalysisResult, Glyph } from '../../../shared/pdf-types'
import type { TextOp } from './content-walker'
import type { FontRes, PageGraph } from './resources'
import { stripSubsetPrefix } from './resources'
import type { Warning } from './rewrite'

export { stripSubsetPrefix }

export type MappedFont = {
  fontKey: string
  resourceName: string
  ref: PDFRef
  alias: string
}

export async function embedCjkFonts(
  doc: PDFDocument,
  fonts: { regular: string; bold: string },
  needBold: boolean,
): Promise<{ regular: PDFFont; bold: PDFFont | undefined; warnings: Warning[] }> {
  doc.registerFontkit(fontkit)
  const warnings: Warning[] = []
  const regular = await embedOne(doc, fonts.regular, warnings)
  const bold = needBold ? await embedOne(doc, fonts.bold, warnings) : undefined
  return { regular, bold, warnings }
}

async function embedOne(doc: PDFDocument, path: string, warnings: Warning[]): Promise<PDFFont> {
  const bytes = await readFile(path)
  try {
    return await doc.embedFont(bytes, { subset: true })
  } catch {
    warnings.push({
      code: 'font_subset_fallback',
      message: 'CJK subset embed failed; retrying without subset',
    })
    try {
      return await doc.embedFont(bytes, { subset: false })
    } catch {
      throw new PermanentError(ERROR_CODES.font_embed_failed)
    }
  }
}

export function mapOriginalFonts(
  ops: TextOp[],
  glyphs: Glyph[],
  graph: PageGraph,
  fontMap: AnalysisResult['fontMap'],
): Map<string, MappedFont> {
  const votes = new Map<string, Map<string, { count: number; name: string; ref: PDFRef }>>()
  const firsts = firstGlyphs(glyphs)
  for (const glyph of firsts) {
    const op = ops.find(
      (item) =>
        item.formPath === glyph.formPath &&
        Math.hypot(item.start[0] - glyph.x, item.start[1] - glyph.y) <= PDF.OP_MATCH_TOLERANCE,
    )
    if (!op) continue
    const ref = graph.fontRef(op.formPath, op.fontName)
    if (!ref) continue
    const byKey =
      votes.get(glyph.fontKey) ?? new Map<string, { count: number; name: string; ref: PDFRef }>()
    const key = `${ref.objectNumber}:${op.fontName}`
    const cur = byKey.get(key)
    if (cur) cur.count += 1
    else byKey.set(key, { count: 1, name: op.fontName, ref })
    votes.set(glyph.fontKey, byKey)
  }

  const mapped = new Map<string, MappedFont>()
  let n = 1
  const needed = new Set(glyphs.map((g) => g.fontKey))
  for (const fontKey of needed) {
    const picked =
      pickMajority(votes.get(fontKey)) ?? baseFontFallback(fontKey, fontMap, graph.fonts)
    if (!picked) continue
    mapped.set(fontKey, {
      fontKey,
      resourceName: picked.name,
      ref: picked.ref,
      alias: `DFo${n}`,
    })
    n += 1
  }
  return mapped
}

function pickMajority(
  votes: Map<string, { count: number; name: string; ref: PDFRef }> | undefined,
): { name: string; ref: PDFRef } | undefined {
  if (!votes || votes.size === 0) return undefined
  let best: { count: number; name: string; ref: PDFRef } | undefined
  for (const row of votes.values()) {
    if (!best || row.count > best.count) best = row
  }
  return best
}

function baseFontFallback(
  fontKey: string,
  fontMap: AnalysisResult['fontMap'],
  fonts: FontRes[],
): { name: string; ref: PDFRef } | undefined {
  const family = stripSubsetPrefix(fontMap[fontKey]?.family ?? fontKey)
  const hit = fonts.find((f) => f.baseFont === family || f.name === family)
  return hit ? { name: hit.name, ref: hit.ref } : undefined
}

function firstGlyphs(glyphs: Glyph[]): Glyph[] {
  const map = new Map<string, Glyph>()
  for (const glyph of glyphs) {
    const key = `${glyph.formPath}:${glyph.opSeq}`
    if (!map.has(key)) map.set(key, glyph)
  }
  return [...map.values()]
}
