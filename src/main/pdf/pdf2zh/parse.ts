// Port of PDFMathTranslate 1.9.11 `pdf2zh/converter.py` TranslateConverter.receive_layout,
// part "A. 原文档解析". Behaviour is kept one-to-one; comments point at the original lines.
// Unless `strict`, these rules come from BabelDOC 0.6.4 instead (ADR-0017): its formula-font
// lists, whitespace normalisation, "a space is a formula only inside a formula", and spaces
// neither open a paragraph in another layout box nor widen a paragraph's box.
import type {
  CharStyle,
  LtChar,
  LtLine,
  ParagraphInfo,
  ParagraphItem,
  Pdf2zhFormula,
  Pdf2zhParagraph,
} from '../../../shared/pdf-types'
import type { LayoutMap } from './doclayout'

export type LtItem = ({ kind: 'char' } & LtChar) | ({ kind: 'line' } & LtLine)

export type ParsedUnit = {
  /** sstk: paragraph strings with {vN} formula markers. */
  texts: string[]
  /** pstk */
  paragraphs: Pdf2zhParagraph[]
  /** var + varl + varf + vlen */
  formulas: Pdf2zhFormula[]
  /** lstk: lines outside formulas, redrawn in place. */
  lines: LtLine[]
  /** Per paragraph: layout label and composition (ADR-0018). */
  infos: ParagraphInfo[]
  /** Character styles the compositions refer to. */
  styles: CharStyle[]
}

export type ParseOptions = {
  /** Only PDFMathTranslate 1.9.11's rules (the parity tests use this). */
  strict?: boolean
}

// vflag: fonts of LaTeX and code (re.match anchors at the start).
const FORMULA_FONT_RE =
  /^(CM[^R]|MS.M|XY|MT|BL|RM|EU|LA|RS|LINE|LCIRCLE|TeX-|rsfs|txsy|wasy|stmary|.*Mono|.*Code|.*Ital|.*Sym|.*Math)/

// BabelDOC formular_helper.is_formulas_font: known math fonts, known text fonts, then a broad
// pattern (pdf2zh's without `.*Ital`, with CM[^RB] and (MS|XY|…)[A-Z]).
const TEXT_FONT_RE = new RegExp(
  '^(' +
    [
      '', 'BLKFort.*', 'Cambria.*', 'EUAlbertina.*', 'NimbusRomNo9L.*', 'GlosaMath.*',
      'URWPalladioL.*', 'CMSS.+', 'Arial.*', 'TimesNewRoman.*', 'SegoeUI.*', 'CMTT9.*',
      'CMSL10.*', 'CMTI10.*', 'CMTT10.*', 'CMTI12.*', 'CMR12.*', 'MeridienLTStd.*', 'Calibri.*',
      'STIXMathJax_Main.*', '.*NewBaskerville.*', '.*FranklinGothic.*', '.*AGaramondPro.*',
      '.*PalatinoItalCOR.*', '.*ITCSymbolStd.*', '.*PlantinStd.*', '.*DJ5EscrowCond.*',
      '.*ExchangeBook.*', '.*DJ5Exchange.*', '.*Times.*', '.*PalatinoLTStd.*',
      '.*Times New Roman,Italic.*', '.*EhrhardtMT.*', '.*GillSansMTStd.*', '.*MedicineSymbols3.*',
      '.*HardingText.*', '.*GraphikNaturel.*', '.*HelveticaNeue.*', '.*GoudyOldStyleT.*',
      '.*Symbol.*', '.*ScalaSansLF.*', '.*ScalaLF.*', '.*ScalaSansPro.*', '.*PetersburgC.*',
      '.*ColiseumC.*', '.*Gantari.*', '.*OptimaLTStd.*', '.*CronosPro.*', '.*ACaslon.*',
      '.*Frutiger.*', '.*BrandonGrotesque.*', '.*FairfieldLH.*', '.*CaeciliaLTStd.*',
      '.*Whitney.*', '.*Mercury.*', '.*SabonLTStd.*', '.*AnonymousPro.*', '.*SabonLTPro.*',
      '.*ArnoPro.*', '.*CharisSIL.*', '.*MSReference.*', '.*CMUSerif-Roman.*', '.*CourierNewPS.*',
      '.*XCharter.*', '.*GillSans.*', '.*Perpetua.*', '.*GEInspira.*', '.*AGaramond.*',
      '.*BMath.*', '.*MSTT.*', '.*Bookinsanity.*', '.*ScalySans.*', '.*Code2000.*', '.*Minion.*',
      '.*JansonTextLT.*', '.*MathPack.*', '.*Macmillan.*', '.*NimbusSan.*', '.*Mincho.*',
      '.*Amerigo.*', '.*MSGloriolaIIStd.*', '.*CMU.+', '.*LinLibertine.*', '.*txsys.*',
    ].join('|') +
    ')$',
) // prettier-ignore
const MATH_FONT_RE = new RegExp(
  '^(' +
    [
      '', '.*Asana.*', '.*MiriamMonoCLM-BookOblique.*', '.*Miriam Mono CLM.*', '.*Logix.*',
      '.*AeBonum.*', '.*AeMRoman.*', '.*AePagella.*', '.*AeSchola.*', '.*Concrete.*',
      '.*LatinModernMathCompanion.*', '.*Latin Modern Math Companion.*',
      '.*RalphSmithsFormalScriptCompanion.*', '.*Ralph Smiths Formal Script Companion.*',
      '.*TeXGyreBonumMathCompanion.*', '.*TeX Gyre Bonum Companion.*',
      '.*TeXGyrePagellaMathCompanion.*', '.*TeX Gyre Pagella Math Companion.*',
      '.*TeXGyreTermesMathCompanion.*', '.*TeX Gyre Termes Math Companion.*',
      '.*XITSMathCompanion.*', '.*XITS Math Companion.*', '.*Erewhon.*', '.*Euler-Math.*',
      '.*Euler Math.*', '.*FiraMath-Regular.*', '.*Fira Math.*', '.*Garamond-Math.*',
      '.*GFSNeohellenicMath.*', '.*KpMath.*', '.*Lete Sans Math.*', '.*LeteSansMath.*',
      '.*Linux Libertine O.*', '.*LibertinusMath-Regular.*', '.*Libertinus Math.*',
      '.*LatinModernMath-Regular.*', '.*Latin Modern Math.*', '.*Luciole.*', '.*NewCM.*',
      '.*NewComputerModern.*', '.*OldStandard-Math.*', '.*STIXMath-Regular.*', '.*STIX Math.*',
      '.*STIXTwoMath-Regular.*', '.*STIX Two Math.*', '.*TeXGyreBonumMath.*',
      '.*TeX Gyre Bonum Math.*', '.*TeXGyreDejaVuMath.*', '.*TeX Gyre DejaVu Math.*',
      '.*TeXGyrePagellaMath.*', '.*TeX Gyre Pagella Math.*', '.*TeXGyreScholaMath.*',
      '.*TeX Gyre Schola Math.*', '.*TeXGyreTermesMath.*', '.*TeX Gyre Termes Math.*',
      '.*XCharter-Math.*', '.*XCharter Math.*', '.*XITSMath-Bold.*', '.*XITS Math.*',
      '.*XITSMath.*', '.*IBMPlexMath.*', '.*IBM Plex Math.*',
    ].join('|') +
    ')$',
) // prettier-ignore
const BROAD_FORMULA_FONT_RE =
  /^(CM[^RB]|(MS|XY|MT|BL|RM|EU|LA|RS)[A-Z]|LINE|LCIRCLE|TeX-|rsfs|txsy|wasy|stmary|.*Mono|.*Code|.*Sym|.*Math|AdvP4C4E74|AdvPSSym|AdvP4C4E59)/

/** BabelDOC is_formulas_font (without its BASE64: name encoding). */
export function isFormulasFont(fontName: string): boolean {
  const font = fontName.split('+').pop() ?? ''
  if (!font) return false
  if (MATH_FONT_RE.test(font)) return true
  if (TEXT_FONT_RE.test(font)) return false
  return BROAD_FORMULA_FONT_RE.test(font)
}

// BabelDOC il_creater.unicode_spaces: a glyph made only of these becomes " ".
const SPACES_RE = /^[\u0020\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\u200b\u2060\t]+$/
// unicodedata.category(char[0]) in ["Lm", "Mn", "Sk", "Sm", "Zl", "Zp", "Zs"]
const FORMULA_CATEGORY_RE = /^[\p{Lm}\p{Mn}\p{Sk}\p{Sm}\p{Zl}\p{Zp}\p{Zs}]/u

/** Python `len(s.strip())`: code points after stripping whitespace. */
function strippedLength(s: string): number {
  return [...s.trim()].length
}

export function vflag(font: string, char: string, strict = true): boolean {
  const name = font.split('+').pop() ?? ''
  if (/^\(cid:/.test(char)) return true
  if (strict ? FORMULA_FONT_RE.test(name) : isFormulasFont(font)) return true
  if (char && char !== ' ') {
    const first = String.fromCodePoint(char.codePointAt(0) ?? 0)
    const code = first.codePointAt(0) ?? 0
    if (FORMULA_CATEGORY_RE.test(first) || (code >= 0x370 && code < 0x400)) return true
  }
  return false
}

/** Python `int()` truncates toward zero; numpy clip. */
function cell(value: number, max: number): number {
  return Math.min(Math.max(Math.trunc(value), 0), max - 1)
}

function layoutClass(layout: LayoutMap, x: number, y: number): number {
  const cx = cell(x, layout.width)
  const cy = cell(y, layout.height)
  return layout.cls[cy * layout.width + cx] ?? 1
}

/**
 * @param items LTChar / LTLine in content-stream order for one LTPage or LTFigure.
 * @param width ltpage.width (vmax = width / 4).
 */
export function parseLayout(
  items: readonly LtItem[],
  layout: LayoutMap,
  width: number,
  options: ParseOptions = {},
): ParsedUnit {
  const strict = options.strict ?? false
  const sstk: string[] = []
  const pstk: Pdf2zhParagraph[] = []
  let vbkt = 0
  let vstk: LtChar[] = []
  let vlstk: LtLine[] = []
  let vfix = 0
  const formulas: Pdf2zhFormula[] = []
  const lstk: LtLine[] = []
  let xt: LtChar | undefined
  let xtCls = -1
  const vmax = width / 4
  // BabelDOC in_formula_state: whether the previous character was classified as formula.
  let prevCurV = false
  // Paragraphs whose style a text character has seeded (BabelDOC _merge_styles).
  const styled = new Set<Pdf2zhParagraph>()
  // BabelDOC's view of each paragraph next to sstk: characters with their style, and formulas.
  const infos: ParagraphInfo[] = []
  const styles: CharStyle[] = []
  const styleIds = new Map<string, number>()
  const styleOf = (c: LtChar): number => {
    const key = `${c.font}\u0000${c.size}\u0000${c.gstate}`
    let id = styleIds.get(key)
    if (id === undefined) {
      id = styles.length
      styles.push({ font: c.font, size: c.size, gstate: c.gstate })
      styleIds.set(key, id)
    }
    return id
  }
  const paraItems = (): ParagraphItem[] => infos[infos.length - 1]!.items
  const pushChar = (c: LtChar) => {
    paraItems().push({
      kind: 'char',
      text: c.text,
      x0: c.x0,
      y0: c.y0,
      x1: c.x1,
      y1: c.y1,
      code: c.code,
      codeBytes: c.codeBytes,
      style: styleOf(c),
    })
  }
  // A space pdf2zh inserts: BabelDOC's dummy space char, styled like the character before it.
  const pushSpace = (prev: LtChar, x1: number) => {
    paraItems().push({
      kind: 'char',
      text: ' ',
      x0: prev.x1,
      y0: prev.y0,
      x1,
      y1: prev.y1,
      code: -1,
      codeBytes: 0,
      style: styleOf(prev),
      dummy: true,
    })
  }
  const labelOf = (cls: number): Pick<ParagraphInfo, 'label' | 'layoutBox'> => {
    const box = cls >= 2 ? layout.boxes?.[cls - 2] : undefined
    if (!box) return { label: null, layoutBox: null }
    const [bx0, by0, bx1, by1] = box.xyxy
    return { label: box.name, layoutBox: [bx0, layout.height - by1, bx1, layout.height - by0] }
  }

  const pushFormula = () => {
    paraItems().push({ kind: 'formula', index: formulas.length })
    formulas.push({ chars: vstk, lines: vlstk, fix: vfix, len: 0 })
  }

  for (const item of items) {
    if (item.kind === 'char') {
      const child =
        !strict && item.text !== ' ' && SPACES_RE.test(item.text) ? { ...item, text: ' ' } : item
      let curV = false
      let cls = layoutClass(layout, child.x0, child.y0)
      // 锚定文档中 bullet 的位置
      if (child.text === '•') cls = 0
      // BabelDOC _group_characters_into_paragraphs: a space does not open a paragraph in
      // another layout box; it stays with the characters before it.
      if (!strict && child.text === ' ' && sstk.length > 0) cls = xtCls
      const last = sstk.length - 1
      if (
        cls === 0 ||
        (cls === xtCls &&
          strippedLength(sstk[last] ?? '') > 1 &&
          child.size < (pstk[last]?.size ?? 0) * 0.79) ||
        vflag(child.fontname, child.text, strict) ||
        child.vertical
      ) {
        curV = true
      }
      // 判定括号组是否属于公式
      if (!curV) {
        if (vstk.length > 0 && child.text === '(') {
          curV = true
          vbkt += 1
        }
        if (vbkt && child.text === ')') {
          curV = true
          vbkt -= 1
        }
      }
      // BabelDOC styles_and_formulas: `if char.char_unicode == " ": is_formula = in_formula_state`
      if (!strict && child.text === ' ') curV = prevCurV
      prevCurV = curV
      if (
        !curV ||
        cls !== xtCls ||
        (sstk[sstk.length - 1] !== '' && Math.abs(child.x0 - (xt?.x0 ?? 0)) > vmax)
      ) {
        if (vstk.length > 0) {
          if (!curV && cls === xtCls && child.x0 > Math.max(...vstk.map((vch) => vch.x0))) {
            vfix = (vstk[0]?.y0 ?? 0) - child.y0
          }
          if (sstk[sstk.length - 1] === '') xtCls = -1
          sstk[sstk.length - 1] += `{v${formulas.length}}`
          pushFormula()
          vstk = []
          vlstk = []
          vfix = 0
        }
      }
      // 当前字符不属于公式或当前字符是公式的第一个字符
      if (vstk.length === 0) {
        if (cls === xtCls && xt) {
          if (child.x0 > xt.x1 + 1) {
            sstk[sstk.length - 1] += ' '
            pushSpace(xt, child.x0)
          } else if (child.x1 < xt.x0) {
            sstk[sstk.length - 1] += ' '
            pushSpace(xt, xt.x1)
            pstk[pstk.length - 1]!.brk = true
          }
        } else {
          sstk.push('')
          infos.push({ ...labelOf(cls), items: [] })
          pstk.push({
            y: child.y0,
            x: child.x0,
            x0: child.x0,
            x1: child.x0,
            y0: child.y0,
            y1: child.y1,
            size: child.size,
            brk: false,
            gstate: null,
          })
        }
      }
      const para = pstk[pstk.length - 1]!
      if (!curV) {
        if (
          (child.size > para.size || strippedLength(sstk[sstk.length - 1] ?? '') === 1) &&
          child.text !== ' '
        ) {
          para.y -= child.size - para.size
          para.size = child.size
        }
        sstk[sstk.length - 1] += child.text
        pushChar(child)
        if (!styled.has(para)) {
          styled.add(para)
          para.gstate = child.gstate
        } else if (para.gstate !== child.gstate) {
          para.gstate = null
        }
      } else {
        if (vstk.length === 0 && cls === xtCls && xt && child.x0 > xt.x0) {
          vfix = child.y0 - xt.y0
        }
        vstk.push(child)
      }
      // 更新段落边界 (BabelDOC trims spaces off every line before it takes the box)
      if (strict || child.text !== ' ') {
        para.x0 = Math.min(para.x0, child.x0)
        para.x1 = Math.max(para.x1, child.x1)
        para.y0 = Math.min(para.y0, child.y0)
        para.y1 = Math.max(para.y1, child.y1)
      }
      xt = child
      xtCls = cls
    } else {
      const cls = layoutClass(layout, item.x0, item.y0)
      if (vstk.length > 0 && cls === xtCls) vlstk.push(item)
      else lstk.push(item)
    }
  }
  // 处理结尾
  if (vstk.length > 0) {
    sstk[sstk.length - 1] += `{v${formulas.length}}`
    pushFormula()
  }
  for (const formula of formulas) {
    const first = formula.chars[0]
    formula.len = Math.max(...formula.chars.map((vch) => vch.x1)) - (first?.x0 ?? 0)
  }
  for (const info of infos) sizeLineBreakSpaces(info.items)
  return { texts: sstk, paragraphs: pstk, formulas, lines: lstk, infos, styles }
}

/**
 * A space pdf2zh puts at a line break has no gap to measure: give it BabelDOC's width for a
 * newline dummy, min(|distance|, median distance) (layout_helper._add_space_dummy_chars_to_list,
 * where the "median" is the second smallest distinct gap > 1, or the only one, or 1).
 */
function sizeLineBreakSpaces(items: ParagraphItem[]): void {
  const chars = items.filter((item) => item.kind === 'char')
  const glyphs = chars.filter((c) => !c.dummy)
  const gaps = new Set<number>()
  for (let i = 0; i + 1 < glyphs.length; i += 1) {
    const distance = glyphs[i + 1]!.x0 - glyphs[i]!.x1
    if (distance > 1) gaps.add(distance)
  }
  const distinct = [...gaps].sort((a, b) => a - b)
  const median = distinct.length === 0 ? 1 : distinct.length === 1 ? distinct[0]! : distinct[1]!
  for (let i = 0; i < chars.length; i += 1) {
    const space = chars[i]!
    if (!space.dummy || space.x1 !== space.x0) continue
    const next = chars.slice(i + 1).find((c) => !c.dummy)
    const distance = next ? Math.abs(next.x0 - space.x0) : median
    space.x1 = space.x0 + Math.min(distance, median)
  }
}
