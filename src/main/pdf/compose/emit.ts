import type { FormulaRun, Glyph, Paragraph } from '../../../shared/pdf-types'
import type { LayoutResult, LaidToken } from './layout'
import type { MappedFont } from './fonts'

export function fmt(n: number): string {
  return (Number.isFinite(n) ? n : 0).toFixed(3)
}

export function encodeCharCode(code: number, bytes: number): string {
  const width = Math.max(1, Math.min(4, bytes)) * 2
  return Math.max(0, Math.trunc(code)).toString(16).toUpperCase().padStart(width, '0')
}

export function colorOp(color: readonly [number, number, number]): string {
  return `${fmt(color[0])} ${fmt(color[1])} ${fmt(color[2])} rg`
}

type FormulaGroup = {
  glyphs: Glyph[]
  fontKey: string
  color: [number, number, number]
  trm: [number, number, number, number]
}

export function groupFormulaGlyphs(glyphs: Glyph[]): FormulaGroup[] {
  const groups: FormulaGroup[] = []
  let current: FormulaGroup | undefined
  for (const glyph of glyphs) {
    const trm: [number, number, number, number] = [
      glyph.trm[0],
      glyph.trm[1],
      glyph.trm[2],
      glyph.trm[3],
    ]
    if (current && canMerge(current, glyph, trm)) current.glyphs.push(glyph)
    else {
      current = { glyphs: [glyph], fontKey: glyph.fontKey, color: [...glyph.color], trm }
      groups.push(current)
    }
  }
  return groups
}

function canMerge(
  group: FormulaGroup,
  glyph: Glyph,
  trm: [number, number, number, number],
): boolean {
  if (group.fontKey !== glyph.fontKey) return false
  if (group.color.some((c, i) => Math.abs(c - (glyph.color[i] ?? 0)) > 1e-3)) return false
  if (group.trm.some((v, i) => Math.abs(v - (trm[i] ?? 0)) > 1e-3)) return false
  const prev = group.glyphs.at(-1)
  if (!prev) return false
  return Math.abs(prev.x + prev.adv - glyph.x) <= 0.05 && Math.abs(prev.y - glyph.y) <= 0.05
}

export function emitFormulaRun(
  run: FormulaRun,
  x: number,
  y: number,
  fontScale: number,
  aliases: Map<string, MappedFont>,
): string {
  const first = run.glyphs[0]
  if (!first) return ''
  const chunks: string[] = []
  for (const group of groupFormulaGlyphs(run.glyphs)) {
    const g0 = group.glyphs[0]
    if (!g0) continue
    const mapped = aliases.get(group.fontKey)
    if (!mapped) continue
    const nx = x + (g0.x - first.x) * fontScale
    const ny = y + (g0.y - first.y) * fontScale
    const hex = group.glyphs.map((g) => encodeCharCode(g.code, g.codeBytes)).join('')
    chunks.push(colorOp(group.color))
    chunks.push(`/${mapped.alias} 1.000 Tf`)
    chunks.push(
      `${fmt(g0.trm[0] * fontScale)} ${fmt(g0.trm[1] * fontScale)} ${fmt(g0.trm[2] * fontScale)} ${fmt(g0.trm[3] * fontScale)} ${fmt(nx)} ${fmt(ny)} Tm`,
    )
    chunks.push(`<${hex}> Tj`)
  }
  return chunks.join('\n')
}

export function emitTextRun(
  fontName: string,
  size: number,
  x: number,
  y: number,
  hex: string,
): string {
  return `/${fontName} ${fmt(size)} Tf\n1.000 0.000 0.000 1.000 ${fmt(x)} ${fmt(y)} Tm\n${hex} Tj`
}

export function emitPageOps(
  paragraphs: Paragraph[],
  layouts: Map<string, LayoutResult>,
  encode: (text: string, bold: boolean) => string,
  aliases: Map<string, MappedFont>,
  cjkName: (bold: boolean) => string,
): string {
  const parts = ['BT', '0 Tc 0 Tw 100 Tz 0 Ts 0 Tr']
  for (const para of paragraphs) {
    const layout = layouts.get(para.id)
    if (!layout) continue
    const paraColor = colorOp(para.color)
    parts.push(paraColor)
    // Formula runs switch to their own glyph colours; text after them must switch back.
    let colorDirty = false
    for (const line of layout.lines) {
      for (const token of line.tokens) {
        if (token.kind === 'text' && token.text && colorDirty) {
          parts.push(paraColor)
          colorDirty = false
        }
        const chunk = emitToken(token, para, layout, line.baseline, encode, aliases, cjkName)
        if (token.kind === 'formula' && chunk) colorDirty = true
        parts.push(chunk)
      }
    }
  }
  parts.push('ET')
  return parts.filter(Boolean).join('\n')
}

function emitToken(
  token: LaidToken,
  para: Paragraph,
  layout: LayoutResult,
  baseline: number,
  encode: (text: string, bold: boolean) => string,
  aliases: Map<string, MappedFont>,
  cjkName: (bold: boolean) => string,
): string {
  if (token.kind === 'text') {
    if (!token.text) return ''
    return emitTextRun(
      cjkName(para.bold),
      layout.fontSize,
      token.x,
      baseline,
      encode(token.text, para.bold),
    )
  }
  const run = para.runs.find((item) => item.id === token.id)
  if (!run) return ''
  const y = baseline + run.baselineOffset * layout.fontScale
  return emitFormulaRun(run, token.x, y, layout.fontScale, aliases)
}

export function wrapPageContent(rewritten: Uint8Array, appended: string): Uint8Array {
  const prefix = Buffer.from('q\n')
  const mid = Buffer.from('\nQ\n')
  const suffix = Buffer.from(appended)
  const out = new Uint8Array(prefix.length + rewritten.length + mid.length + suffix.length)
  out.set(prefix, 0)
  out.set(rewritten, prefix.length)
  out.set(mid, prefix.length + rewritten.length)
  out.set(suffix, prefix.length + rewritten.length + mid.length)
  return out
}
