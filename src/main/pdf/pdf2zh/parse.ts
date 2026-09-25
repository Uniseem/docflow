// Port of PDFMathTranslate 1.9.11 `pdf2zh/converter.py` TranslateConverter.receive_layout,
// part "A. 原文档解析". Behaviour is kept one-to-one; comments point at the original lines.
// Unless `strict`, these rules come from BabelDOC 0.6.4 instead (ADR-0017): its formula-font
// lists, whitespace normalisation, "a space is a formula only inside a formula", and spaces
// neither open a paragraph in another layout box nor widen a paragraph's box.
import type { LtChar, LtLine, Pdf2zhFormula, Pdf2zhParagraph } from '../../../shared/pdf-types'
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

  const pushFormula = () => {
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
          } else if (child.x1 < xt.x0) {
            sstk[sstk.length - 1] += ' '
            pstk[pstk.length - 1]!.brk = true
          }
        } else {
          sstk.push('')
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
  return { texts: sstk, paragraphs: pstk, formulas, lines: lstk }
}
