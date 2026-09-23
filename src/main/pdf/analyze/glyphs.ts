import type { Glyph, Matrix, Rect } from '../../../shared/pdf-types'
import { OPS, type PDFPageProxy } from '../pdfjs'

export type PageGraphics = {
  glyphs: Glyph[]
  imageRects: Rect[]
}

type PdfjsFont = {
  name?: string
  loadedName?: string
  fontMatrix?: number[]
  vertical?: boolean
  composite?: boolean
  isType3Font?: boolean
  ascent?: number
  descent?: number
  cMap?: { codespaceRanges?: number[][] }
}

type ShowGlyph = {
  originalCharCode?: number
  unicode?: string
  width?: number
  isSpace?: boolean
}

type GraphicsState = {
  ctm: Matrix
  fill: [number, number, number]
  font: PdfjsFont | undefined
  fontKey: string
  fontSize: number
  charSpacing: number
  wordSpacing: number
  hScale: number
  leading: number
  rise: number
  renderMode: number
  tm: Matrix
  tlm: Matrix
}

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]
const BOLD_RE = /bold|black|heavy|semibold|-BX|CMBX/i
const ITALIC_RE = /italic|oblique|-It$|MI\d|CMTI|Slanted/i

function cloneMatrix(m: Matrix): Matrix {
  return [m[0], m[1], m[2], m[3], m[4], m[5]]
}

export function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ]
}

export function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
}

function translate(tx: number, ty: number): Matrix {
  return [1, 0, 0, 1, tx, ty]
}

function hypot(x: number, y: number): number {
  return Math.hypot(x, y)
}

function asNumbers(args: unknown): number[] {
  if (ArrayBuffer.isView(args) && 'length' in args) {
    return Array.from(args as unknown as ArrayLike<number>, (value) => Number(value))
  }
  if (Array.isArray(args)) {
    if (
      args.length === 1 &&
      (ArrayBuffer.isView(args[0]) || (Array.isArray(args[0]) && typeof args[0][0] === 'number'))
    ) {
      return asNumbers(args[0])
    }
    return args.map((value) => Number(value))
  }
  return []
}

function parseFillColor(args: unknown): [number, number, number] | undefined {
  if (typeof args === 'string' && /^#[0-9a-fA-F]{6}$/.test(args)) {
    const n = Number.parseInt(args.slice(1), 16)
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
  }
  if (Array.isArray(args) && args.length === 1 && typeof args[0] === 'string') {
    return parseFillColor(args[0])
  }
  const nums = asNumbers(args)
  if (nums.length === 1) {
    const g = normalizeChannel(nums[0] ?? 0)
    return [g, g, g]
  }
  if (nums.length >= 3 && nums.length < 4) {
    return [
      normalizeChannel(nums[0] ?? 0),
      normalizeChannel(nums[1] ?? 0),
      normalizeChannel(nums[2] ?? 0),
    ]
  }
  if (nums.length >= 4) {
    const c = normalizeChannel(nums[0] ?? 0)
    const m = normalizeChannel(nums[1] ?? 0)
    const y = normalizeChannel(nums[2] ?? 0)
    const k = normalizeChannel(nums[3] ?? 0)
    return [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)]
  }
  return undefined
}

function normalizeChannel(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value > 1) return Math.min(1, value / 255)
  return Math.min(1, Math.max(0, value))
}

function lookupFont(page: PDFPageProxy, loadedName: string): PdfjsFont | undefined {
  if (!loadedName) return undefined
  try {
    return page.commonObjs.get(loadedName) as PdfjsFont
  } catch {
    return undefined
  }
}

function fontFamilyOf(font: PdfjsFont | undefined, fallback: string): string {
  const name = font?.name ?? fallback
  return name.split('+').pop() ?? name
}

function codeBytesOf(font: PdfjsFont | undefined, code: number): number {
  if (!font?.composite) return 1
  const ranges = font.cMap?.codespaceRanges
  if (!ranges?.length) return 2
  for (let bytes = 1; bytes <= ranges.length; bytes += 1) {
    const group = ranges[bytes - 1]
    if (!group) continue
    for (let i = 0; i + 1 < group.length; i += 2) {
      const start = group[i] ?? 0
      const end = group[i + 1] ?? 0
      if (code >= start && code <= end) return bytes
    }
  }
  return 2
}

function unitSquareBBox(ctm: Matrix): Rect {
  const pts: Array<[number, number]> = [
    apply(ctm, 0, 0),
    apply(ctm, 1, 0),
    apply(ctm, 1, 1),
    apply(ctm, 0, 1),
  ]
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

function pushForm(path: string, index: number): string {
  return path ? `${path}/${index}` : String(index)
}

function popForm(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? '' : path.slice(0, cut)
}

export async function extractPageGraphics(
  page: PDFPageProxy,
  pageIndex: number,
): Promise<PageGraphics> {
  const ops = await page.getOperatorList()
  const glyphs: Glyph[] = []
  const imageRects: Rect[] = []
  const stack: GraphicsState[] = []
  const formCounts = [0]
  let formPath = ''
  let formDepth = 0
  let opSeq = 0
  const state: GraphicsState = {
    ctm: cloneMatrix(IDENTITY),
    fill: [0, 0, 0],
    font: undefined,
    fontKey: '',
    fontSize: 0,
    charSpacing: 0,
    wordSpacing: 0,
    hScale: 1,
    leading: 0,
    rise: 0,
    renderMode: 0,
    tm: cloneMatrix(IDENTITY),
    tlm: cloneMatrix(IDENTITY),
  }

  const save = () => {
    stack.push({
      ...state,
      ctm: cloneMatrix(state.ctm),
      fill: [...state.fill],
      tm: cloneMatrix(state.tm),
      tlm: cloneMatrix(state.tlm),
    })
  }
  const restore = () => {
    const prev = stack.pop()
    if (!prev) return
    state.ctm = prev.ctm
    state.fill = prev.fill
    state.font = prev.font
    state.fontKey = prev.fontKey
    state.fontSize = prev.fontSize
    state.charSpacing = prev.charSpacing
    state.wordSpacing = prev.wordSpacing
    state.hScale = prev.hScale
    state.leading = prev.leading
    state.rise = prev.rise
    state.renderMode = prev.renderMode
    state.tm = prev.tm
    state.tlm = prev.tlm
  }

  for (let i = 0; i < ops.fnArray.length; i += 1) {
    const fn = ops.fnArray[i] ?? 0
    const args = ops.argsArray[i] as unknown
    switch (fn) {
      case OPS.save:
        save()
        break
      case OPS.restore:
        restore()
        break
      case OPS.transform: {
        const n = asNumbers(args)
        if (n.length >= 6) {
          state.ctm = multiply(state.ctm, [n[0]!, n[1]!, n[2]!, n[3]!, n[4]!, n[5]!])
        }
        break
      }
      case OPS.paintFormXObjectBegin: {
        save()
        const list = Array.isArray(args) ? args : []
        const matrix = asNumbers(list[0]).length >= 6 ? asNumbers(list[0]) : [1, 0, 0, 1, 0, 0]
        state.ctm = multiply(state.ctm, [
          matrix[0]!,
          matrix[1]!,
          matrix[2]!,
          matrix[3]!,
          matrix[4]!,
          matrix[5]!,
        ])
        formDepth += 1
        if (formCounts.length <= formDepth) formCounts.push(0)
        formCounts[formDepth] = (formCounts[formDepth] ?? 0) + 1
        formCounts.splice(formDepth + 1)
        formPath = pushForm(formPath, formCounts[formDepth] ?? 1)
        break
      }
      case OPS.paintFormXObjectEnd:
        restore()
        formPath = popForm(formPath)
        formDepth = Math.max(0, formDepth - 1)
        break
      case OPS.beginText:
        state.tm = cloneMatrix(IDENTITY)
        state.tlm = cloneMatrix(IDENTITY)
        break
      case OPS.setFont: {
        const list = Array.isArray(args) ? args : []
        const loadedName = String(list[0] ?? '')
        state.fontKey = loadedName
        state.fontSize = Number(list[1] ?? 0)
        state.font = lookupFont(page, loadedName)
        break
      }
      case OPS.setCharSpacing:
        state.charSpacing = Number(asNumbers(args)[0] ?? 0)
        break
      case OPS.setWordSpacing:
        state.wordSpacing = Number(asNumbers(args)[0] ?? 0)
        break
      case OPS.setHScale:
        state.hScale = Number(asNumbers(args)[0] ?? 100) / 100
        break
      case OPS.setLeading:
        state.leading = Number(asNumbers(args)[0] ?? 0)
        break
      case OPS.setTextRise:
        state.rise = Number(asNumbers(args)[0] ?? 0)
        break
      case OPS.setTextRenderingMode:
        state.renderMode = Number(asNumbers(args)[0] ?? 0)
        break
      case OPS.moveText: {
        const n = asNumbers(args)
        state.tlm = multiply(state.tlm, translate(n[0] ?? 0, n[1] ?? 0))
        state.tm = cloneMatrix(state.tlm)
        break
      }
      case OPS.setLeadingMoveText: {
        const n = asNumbers(args)
        state.leading = -(n[1] ?? 0)
        state.tlm = multiply(state.tlm, translate(n[0] ?? 0, n[1] ?? 0))
        state.tm = cloneMatrix(state.tlm)
        break
      }
      case OPS.setTextMatrix: {
        const n = asNumbers(args)
        if (n.length >= 6) {
          state.tm = [n[0]!, n[1]!, n[2]!, n[3]!, n[4]!, n[5]!]
          state.tlm = cloneMatrix(state.tm)
        }
        break
      }
      case OPS.nextLine:
        state.tlm = multiply(state.tlm, translate(0, -state.leading))
        state.tm = cloneMatrix(state.tlm)
        break
      case OPS.setFillRGBColor:
      case OPS.setFillGray:
      case OPS.setFillCMYKColor:
      case OPS.setFillColor:
      case OPS.setFillColorN: {
        const color = parseFillColor(args)
        if (color) state.fill = color
        break
      }
      case OPS.paintImageXObject:
      case OPS.paintImageXObjectRepeat:
      case OPS.paintInlineImageXObject:
        imageRects.push(unitSquareBBox(state.ctm))
        break
      case OPS.showText:
      case OPS.showSpacedText: {
        const items = Array.isArray(args) ? (Array.isArray(args[0]) ? args[0] : args) : []
        showText(state, items, pageIndex, formPath, opSeq, glyphs)
        opSeq += 1
        break
      }
      default:
        break
    }
  }

  return { glyphs, imageRects }
}

function showText(
  state: GraphicsState,
  items: unknown[],
  pageIndex: number,
  formPath: string,
  opSeq: number,
  glyphs: Glyph[],
): void {
  const font = state.font
  const fontMatrix = font?.fontMatrix ?? [0.001, 0, 0, 0.001, 0, 0]
  const size = state.fontSize
  const th = state.hScale
  const family = fontFamilyOf(font, state.fontKey)
  const bold = BOLD_RE.test(family)
  const italic = ITALIC_RE.test(family)
  const vertical = Boolean(font?.vertical)
  const type3 = Boolean(font?.isType3Font)
  const composite = Boolean(font?.composite)
  const ascent = Number.isFinite(font?.ascent) ? (font?.ascent as number) : 0.8
  const descent = Number.isFinite(font?.descent) ? (font?.descent as number) : -0.2
  const scale: Matrix = [size * th, 0, 0, size, 0, state.rise]

  for (const item of items) {
    if (typeof item === 'number') {
      // Displacements are in text space: T(tx, 0) × Tm (PDF 32000 §9.4.4).
      state.tm = multiply(state.tm, translate((-item * size * th) / 1000, 0))
      continue
    }
    const glyph = item as ShowGlyph
    const w0 = Number(glyph.width ?? 0) * Number(fontMatrix[0] ?? 0.001)
    const spacing = state.charSpacing + (glyph.isSpace ? state.wordSpacing : 0)
    const tx = (w0 * size + spacing) * th
    const trm = multiply(state.ctm, multiply(state.tm, scale))
    const origin = apply(trm, 0, 0)
    const visualSize = hypot(trm[2], trm[3]) || size
    // Length of one text-space unit along the baseline, in page space.
    const userTm = multiply(state.ctm, state.tm)
    const unit = hypot(userTm[0], userTm[1]) || 1
    const width = w0 * size * th * unit
    const adv = tx * unit
    const code = Number(glyph.originalCharCode ?? 0)
    const unicode = glyph.unicode ?? ''
    glyphs.push({
      page: pageIndex,
      opSeq,
      formPath,
      code,
      unicode,
      fontKey: state.fontKey,
      fontFamily: family,
      composite,
      codeBytes: codeBytesOf(font, code),
      bold,
      italic,
      type3,
      trm,
      x: origin[0],
      y: origin[1],
      size: visualSize,
      adv,
      width,
      ascent,
      descent,
      rotated: Math.abs(trm[1]) > 1e-3 || Math.abs(trm[2]) > 1e-3,
      vertical,
      renderMode: state.renderMode,
      color: [...state.fill],
      isSpace: Boolean(glyph.isSpace) || unicode === ' ',
    })
    state.tm = multiply(state.tm, translate(tx, 0))
  }
}

export function visibleGlyphCount(glyphs: readonly Glyph[]): number {
  return glyphs.filter((g) => g.renderMode !== 3 && g.renderMode !== 7).length
}
