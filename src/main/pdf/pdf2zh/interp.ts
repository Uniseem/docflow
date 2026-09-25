// Port of PDFMathTranslate 1.9.11 `pdf2zh/pdfinterp.py` PDFPageInterpreterEx on top of the
// pdfminer.six 20250416 interpreter it subclasses. It rebuilds `ops_base` (the stream without
// text), collects the lines pdf2zh hands to the converter (do_S), and recurses into form
// XObjects like do_Do. Kept operators are copied byte for byte instead of re-serialised.
import type { LtLine, Matrix, Rect } from '../../../shared/pdf-types'
import { lexContent, tokenText } from '../compose/content-lexer'

export type InterpForm = {
  /** "objectNumber generation" of the form stream; obj_patch key. */
  handle: string
  matrix: Matrix
  /** /BBox; pdf2zh only interprets forms that have one. */
  bbox: Rect | undefined
  content: Uint8Array
  /** Resources its operators refer to (own /Resources, or the drawing stream's). */
  resources: unknown
  getForm(name: string): InterpForm | undefined
}

export type TextOpInfo = {
  /** Show-text operator number in execution order across the page and its forms. */
  seq: number
  /** Resource name of the current font (Tf operand without the slash). */
  font: string
  formPath: string
  /** Text-space origin of the operator mapped by the CTM (for alignment checks). */
  start: [number, number]
  /**
   * Whether a positioning operator came since the previous show-text operator. If not, the
   * text continues after glyphs whose widths are unknown here and only `start[1]` is exact.
   */
  positioned: boolean
}

export type UnitEvent = { kind: 'text'; seq: number } | { kind: 'line'; line: LtLine }

export type InterpUnit = {
  /** '' for the page; '1', '1/2' … for forms, numbered by drawing order like pdf.js. */
  formPath: string
  /** Form stream to patch; undefined for the page. */
  handle: string | undefined
  /** CTM the stream was interpreted with (page CTM, or form Matrix × CTM). */
  ctm: Matrix
  /** ltpage.width: page crop width, or the LTFigure width pdfminer derives from BBox. */
  width: number
  resources: unknown
  events: UnitEvent[]
  opsBase: Uint8Array
  /** Text operators dropped from this stream. */
  removed: number
}

export type InterpResult = {
  units: InterpUnit[]
  textOps: TextOpInfo[]
}

const MAX_FORM_DEPTH = 12

// pdfminer mult_matrix(m1, m0): m1 × m0
export function multMatrix(m1: Matrix, m0: Matrix): Matrix {
  const [a1, b1, c1, d1, e1, f1] = m1
  const [a0, b0, c0, d0, e0, f0] = m0
  return [
    a0 * a1 + c0 * b1,
    b0 * a1 + d0 * b1,
    a0 * c1 + c0 * d1,
    b0 * c1 + d0 * d1,
    a0 * e1 + c0 * f1 + e0,
    b0 * e1 + d0 * f1 + f0,
  ]
}

// pdfminer apply_matrix_pt
export function applyMatrixPt(m: Matrix, x: number, y: number): [number, number] {
  const [a, b, c, d, e, f] = m
  return [a * x + c * y + e, b * x + d * y + f]
}

/** pdf2zh process_page: CTM for the page's crop box and /Rotate. */
export function pageCtm(cropbox: Rect, rotate: number): Matrix {
  const [x0, y0, x1, y1] = cropbox
  if (rotate === 90) return [0, -1, 1, 0, -y0, x1]
  if (rotate === 180) return [-1, 0, 0, -1, x1, y1]
  if (rotate === 270) return [0, 1, -1, 0, y1, -x0]
  return [1, 0, 0, 1, -x0, -y0]
}

/** pdfminer LTFigure: BBox read as (x, y, w, h), corners mapped by `matrix`. */
export function figureWidth(bbox: Rect, matrix: Matrix): number {
  const [x, y, w, h] = bbox
  const pts = [
    applyMatrixPt(matrix, x, y),
    applyMatrixPt(matrix, x + w, y),
    applyMatrixPt(matrix, x, y + h),
    applyMatrixPt(matrix, x + w, y + h),
  ]
  const xs = pts.map((p) => p[0])
  return Math.max(...xs) - Math.min(...xs)
}

// Operators pdfminer knows (do_* methods) with their argument count; unknown ones are skipped.
// SC/SCN/sc/scn take no declared arguments: pdf2zh's overrides pop them themselves.
const ARITY: Record<string, number> = {
  q: 0, Q: 0, w: 1, J: 1, j: 1, M: 1, d: 2, ri: 1, i: 1, gs: 1, cm: 6,
  m: 2, l: 2, c: 6, v: 4, y: 4, h: 0, re: 4,
  S: 0, s: 0, f: 0, F: 0, 'f*': 0, B: 0, 'B*': 0, b: 0, 'b*': 0, n: 0, W: 0, 'W*': 0,
  CS: 1, cs: 1, G: 1, g: 1, RG: 3, rg: 3, K: 4, k: 4, SCN: 0, scn: 0, SC: 0, sc: 0, sh: 1,
  BT: 0, ET: 0, BX: 0, EX: 0, MP: 1, DP: 2, BMC: 1, BDC: 2, EMC: 0,
  Tc: 1, Tw: 1, Tz: 1, TL: 1, Tf: 2, Tr: 1, Ts: 1, Td: 2, TD: 2, Tm: 6, 'T*': 0,
  TJ: 1, Tj: 1, "'": 1, '"': 3, BI: 0, ID: 0, EI: 1, Do: 1, d0: 2, d1: 6,
} // prettier-ignore

// execute(): with arguments T*, ', ", EI, MP, DP, BMC, BDC are dropped; without arguments
// T*, BI, ID, EMC are dropped. Everything else goes to ops_base.
function dropped(op: string, nargs: number): boolean {
  if (op[0] === 'T') return true
  if (nargs > 0) return ['"', "'", 'EI', 'MP', 'DP', 'BMC', 'BDC'].includes(op)
  return ['BI', 'ID', 'EMC'].includes(op)
}

type PathSegment = [string, ...number[]]
// Stroking colour: undefined = never set (pdfminer None), a number (G), a tuple (RG, K),
// or 'list' for SC/SCN (pdf2zh stores the args list, which is_black never accepts).
type StrokeColor = undefined | number | number[] | 'list'

type State = {
  ctm: Matrix
  linewidth: number
  scolor: StrokeColor
  font: string
  fontSize: number
  hscale: number
  charSpacing: number
  wordSpacing: number
  leading: number
  rise: number
  tm: Matrix
  tlm: Matrix
}

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]
const SHOW_TEXT = new Set(['Tj', 'TJ', "'", '"'])
// psparser turns these keywords into objects: they are operands, not operators.
const OBJECT_KEYWORDS = new Set(['true', 'false', 'null'])
const N_S = new TextEncoder().encode('n S ')

// `start`: byte offset of the operand, so a kept operator can be copied with just its own.
type Operand = { start: number } & (
  { kind: 'number'; value: number } | { kind: 'name'; value: string } | { kind: 'other' }
)
// pdf2zh's do_SC/do_SCN/do_sc/do_scn pop the colour components themselves and return them.
const SELF_POPPING = new Set(['SC', 'SCN', 'sc', 'scn'])

function isBlack(color: StrokeColor): boolean {
  if (color === undefined || color === 'list') return false
  if (Array.isArray(color)) return color.reduce((sum, v) => sum + v, 0) === 0
  return color === 0
}

function translateMatrix(m: Matrix, tx: number, ty: number): Matrix {
  // T(tx, ty) × m, the text-space move of Td/T*/TJ.
  return multMatrix([1, 0, 0, 1, tx, ty], m)
}

export function interpretPage(
  content: Uint8Array,
  ctm: Matrix,
  width: number,
  getForm: (name: string) => InterpForm | undefined,
  resources: unknown = undefined,
): InterpResult {
  const units: InterpUnit[] = []
  const textOps: TextOpInfo[] = []
  const run = (
    bytes: Uint8Array,
    unitCtm: Matrix,
    unitWidth: number,
    formPath: string,
    handle: string | undefined,
    lookup: (name: string) => InterpForm | undefined,
    depth: number,
    shadow: boolean,
    unitResources: unknown,
  ): void => {
    const unit: InterpUnit = {
      formPath,
      handle,
      ctm: unitCtm,
      width: unitWidth,
      resources: unitResources,
      events: [],
      opsBase: new Uint8Array(),
      removed: 0,
    }
    // A form without /BBox is not interpreted by pdfminer; its text operators are still
    // counted so the numbering matches pdf.js, which draws it.
    if (!shadow) units.push(unit)
    const tokens = lexContent(bytes)
    const out: Uint8Array[] = []
    const space = new Uint8Array([32])
    const stack: State[] = []
    let state: State = {
      ctm: unitCtm,
      linewidth: 0,
      scolor: undefined,
      font: '',
      fontSize: 0,
      hscale: 1,
      charSpacing: 0,
      wordSpacing: 0,
      leading: 0,
      rise: 0,
      tm: IDENTITY,
      tlm: IDENTITY,
    }
    let curpath: PathSegment[] = []
    let formCount = 0
    let operands: Operand[] = []
    let depthBracket = 0
    let openStart = 0
    // Numbers before the first string of the last TJ array: they move the first glyph.
    let arrayLead = 0
    let arrayLeadOpen = false
    let positioned = true

    const numbers = (n: number): number[] | undefined => {
      if (operands.length < n) return undefined
      const args = operands.slice(operands.length - n)
      if (args.some((a) => a.kind !== 'number')) return undefined
      return args.map((a) => (a as { value: number }).value)
    }
    const emitText = (lead = 0) => {
      const tx = (-lead / 1000) * state.fontSize * state.hscale
      const trm = multMatrix(multMatrix([1, 0, 0, 1, tx, state.rise], state.tm), state.ctm)
      textOps.push({
        seq: textOps.length,
        font: state.font,
        formPath,
        start: applyMatrixPt(trm, 0, 0),
        positioned,
      })
      positioned = false
      unit.events.push({ kind: 'text', seq: textOps.length - 1 })
    }

    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i]!
      if (token.kind === 'space') continue
      if (token.kind === 'inline-image') {
        // BI … ID … EI: EI is dropped with its image argument.
        operands = []
        continue
      }
      const isOperator =
        token.kind === 'operator' &&
        depthBracket === 0 &&
        !OBJECT_KEYWORDS.has(tokenText(bytes, token))
      if (!isOperator) {
        if (depthBracket === 0) openStart = token.start
        if (token.kind === 'lbracket' && depthBracket === 0) {
          arrayLead = 0
          arrayLeadOpen = true
        } else if (depthBracket === 1 && arrayLeadOpen) {
          if (token.kind === 'number') arrayLead += Number(tokenText(bytes, token))
          else arrayLeadOpen = false
        }
        if (token.kind === 'lbracket' || token.kind === 'ldict') depthBracket += 1
        else if (token.kind === 'rbracket' || token.kind === 'rdict') {
          depthBracket = Math.max(0, depthBracket - 1)
          if (depthBracket === 0) operands.push({ start: openStart, kind: 'other' })
        } else if (depthBracket === 0) {
          const start = token.start
          if (token.kind === 'number') {
            operands.push({ start, kind: 'number', value: Number(tokenText(bytes, token)) })
          } else if (token.kind === 'name') {
            operands.push({ start, kind: 'name', value: tokenText(bytes, token).slice(1) })
          } else {
            operands.push({ start, kind: 'other' })
          }
        }
        continue
      }
      const op = tokenText(bytes, token)
      const nargs = ARITY[op]
      const args = operands
      operands = []
      if (nargs === undefined) continue // unknown operator: pdfminer has no do_* for it
      if (nargs > 0 && args.length < nargs) continue // pop() came up short: not executed
      operands = args
      let output: Uint8Array | 'drop' | 'keep' = dropped(op, nargs) ? 'drop' : 'keep'

      switch (op) {
        case 'q':
          stack.push({ ...state, tm: state.tm, tlm: state.tlm })
          break
        case 'Q': {
          const prev = stack.pop()
          if (prev) state = prev
          break
        }
        case 'cm': {
          const n = numbers(6)
          if (n) state = { ...state, ctm: multMatrix(n as unknown as Matrix, state.ctm) }
          break
        }
        case 'w': {
          const n = numbers(1)
          if (n) state = { ...state, linewidth: n[0]! }
          break
        }
        case 'm':
        case 'l': {
          const n = numbers(2)
          if (n) curpath.push([op, n[0]!, n[1]!])
          break
        }
        case 'c': {
          const n = numbers(6)
          if (n) curpath.push(['c', ...n])
          break
        }
        case 'v':
        case 'y': {
          const n = numbers(4)
          if (n) curpath.push([op, ...n])
          break
        }
        case 'h':
          curpath.push(['h'])
          break
        case 're': {
          const n = numbers(4)
          if (n) {
            const [x, y, w, h] = n as [number, number, number, number]
            curpath.push(['m', x, y], ['l', x + w, y], ['l', x + w, y + h], ['l', x, y + h], ['h'])
          }
          break
        }
        case 'S': {
          // do_S: an isolated, horizontal, black two-point line goes to the converter.
          const p0 = curpath[0]
          const p1 = curpath[1]
          if (
            curpath.length === 2 &&
            p0?.[0] === 'm' &&
            p1?.[0] === 'l' &&
            applyMatrixPt(state.ctm, p0[1]!, p0[2]!)[1] ===
              applyMatrixPt(state.ctm, p1[1]!, p1[2]!)[1] &&
            isBlack(state.scolor)
          ) {
            const a = applyMatrixPt(state.ctm, p0[1]!, p0[2]!)
            const b = applyMatrixPt(state.ctm, p1[1]!, p1[2]!)
            unit.events.push({
              kind: 'line',
              line: {
                x0: Math.min(a[0], b[0]),
                y0: Math.min(a[1], b[1]),
                pts: [a, b],
                linewidth: state.linewidth,
              },
            })
            output = N_S
          }
          curpath = []
          break
        }
        case 's':
        case 'f':
        case 'F':
        case 'f*':
        case 'B':
        case 'B*':
        case 'b':
        case 'b*':
        case 'n':
          curpath = []
          break
        case 'G': {
          const n = numbers(1)
          if (n) state = { ...state, scolor: n[0]! }
          break
        }
        case 'RG': {
          const n = numbers(3)
          if (n) state = { ...state, scolor: n }
          break
        }
        case 'K': {
          const n = numbers(4)
          if (n) state = { ...state, scolor: n }
          break
        }
        case 'SC':
        case 'SCN':
          state = { ...state, scolor: 'list' }
          break
        case 'BT':
          state = { ...state, tm: IDENTITY, tlm: IDENTITY }
          positioned = true
          break
        case 'Tf': {
          const name = args[args.length - 2]
          const size = args[args.length - 1]
          state = {
            ...state,
            font: name?.kind === 'name' ? name.value : state.font,
            fontSize: size?.kind === 'number' ? size.value : state.fontSize,
          }
          break
        }
        case 'Tc': {
          const n = numbers(1)
          if (n) state = { ...state, charSpacing: n[0]! }
          break
        }
        case 'Tz': {
          const n = numbers(1)
          if (n) state = { ...state, hscale: n[0]! / 100 }
          break
        }
        case 'Tw': {
          const n = numbers(1)
          if (n) state = { ...state, wordSpacing: n[0]! }
          break
        }
        case 'TL': {
          const n = numbers(1)
          if (n) state = { ...state, leading: n[0]! }
          break
        }
        case 'Ts': {
          const n = numbers(1)
          if (n) state = { ...state, rise: n[0]! }
          break
        }
        case 'Td':
        case 'TD': {
          const n = numbers(2)
          if (n) {
            const tlm = translateMatrix(state.tlm, n[0]!, n[1]!)
            state = {
              ...state,
              leading: op === 'TD' ? -n[1]! : state.leading,
              tlm,
              tm: tlm,
            }
            positioned = true
          }
          break
        }
        case 'Tm': {
          const n = numbers(6)
          if (n) state = { ...state, tm: n as unknown as Matrix, tlm: n as unknown as Matrix }
          positioned = true
          break
        }
        case 'T*': {
          const tlm = translateMatrix(state.tlm, 0, -state.leading)
          state = { ...state, tlm, tm: tlm }
          positioned = true
          break
        }
        case "'":
        case '"': {
          if (op === '"') {
            const n = args.slice(-3)
            if (n[0]?.kind === 'number') state = { ...state, wordSpacing: n[0].value }
            if (n[1]?.kind === 'number') state = { ...state, charSpacing: n[1].value }
          }
          const tlm = translateMatrix(state.tlm, 0, -state.leading)
          state = { ...state, tlm, tm: tlm }
          positioned = true
          emitText()
          break
        }
        case 'Tj':
          emitText()
          break
        case 'TJ':
          emitText(arrayLead)
          break
        case 'Do': {
          const arg = args[args.length - 1]
          const form = arg?.kind === 'name' ? lookup(arg.value) : undefined
          if (!form) break
          formCount += 1
          const path = formPath ? `${formPath}/${formCount}` : String(formCount)
          if (depth < MAX_FORM_DEPTH) {
            const formCtm = multMatrix(form.matrix, state.ctm)
            run(
              form.content,
              formCtm,
              form.bbox ? figureWidth(form.bbox, formCtm) : 0,
              path,
              form.handle,
              (name) => form.getForm(name),
              depth + 1,
              shadow || !form.bbox,
              form.resources,
            )
          }
          break
        }
        default:
          break
      }
      operands = []
      if (output === 'drop') {
        if (SHOW_TEXT.has(op)) unit.removed += 1
        continue
      }
      if (output === 'keep') {
        // execute() writes the popped arguments and the name: surplus operands are not kept.
        let from = token.start
        if (nargs > 0) from = args[args.length - nargs]!.start
        else if (SELF_POPPING.has(op)) from = args[0]?.start ?? token.start
        out.push(bytes.subarray(from, token.end), space)
      } else out.push(output)
    }
    const total = out.reduce((n, part) => n + part.length, 0)
    const merged = new Uint8Array(total)
    let offset = 0
    for (const part of out) {
      merged.set(part, offset)
      offset += part.length
    }
    unit.opsBase = merged
  }

  run(content, ctm, width, '', undefined, getForm, 0, false, resources)
  return { units, textOps }
}
