import { PDF } from '../../../shared/pdf-constants'
import type { Matrix } from '../../../shared/pdf-types'
import { apply, multiply } from '../analyze/glyphs'
import { lexContent, tokenText, type Token } from './content-lexer'

export type TextOp = {
  tokenRange: [number, number]
  start: [number, number]
  fontName: string
  formPath: string
  seq: number
}

type GState = {
  ctm: Matrix
  tm: Matrix
  tlm: Matrix
  fontName: string
  fontSize: number
  leading: number
  rise: number
  charSpacing: number
  wordSpacing: number
}

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

function clone(m: Matrix): Matrix {
  return [m[0], m[1], m[2], m[3], m[4], m[5]]
}

function translate(tx: number, ty: number): Matrix {
  return [1, 0, 0, 1, tx, ty]
}

function num(tokens: Token[], bytes: Uint8Array, index: number): number {
  const token = tokens[index]
  if (!token) return 0
  return Number(tokenText(bytes, token))
}

export type FormXObject = {
  matrix: Matrix
  content: Uint8Array
  handle?: string
  getForm?: (name: string) => FormXObject | undefined
}

export function walkTextOps(
  bytes: Uint8Array,
  options: {
    formPath?: string
    getForm?: (name: string) => FormXObject | undefined
    shared?: ReadonlySet<string>
    depth?: number
    ctm?: Matrix
    onForm?: (path: string, form: FormXObject) => void
  } = {},
): TextOp[] {
  const tokens = lexContent(bytes)
  const ops: TextOp[] = []
  const stack: GState[] = []
  const state: GState = {
    ctm: clone(options.ctm ?? IDENTITY),
    tm: clone(IDENTITY),
    tlm: clone(IDENTITY),
    fontName: '',
    fontSize: 0,
    leading: 0,
    rise: 0,
    charSpacing: 0,
    wordSpacing: 0,
  }
  const formPath = options.formPath ?? ''
  let formCount = 0
  let seq = 0
  let i = 0

  const skipSpace = () => {
    while (i < tokens.length && tokens[i]?.kind === 'space') i += 1
  }

  while (i < tokens.length) {
    skipSpace()
    const token = tokens[i]
    if (!token) break
    if (token.kind !== 'operator' && token.kind !== 'inline-image') {
      i += 1
      continue
    }
    const op = tokenText(bytes, token)
    const args = operandsBefore(tokens, bytes, i)
    const argStart = args.start
    switch (op) {
      case 'q':
        stack.push({ ...state, ctm: clone(state.ctm), tm: clone(state.tm), tlm: clone(state.tlm) })
        break
      case 'Q': {
        const prev = stack.pop()
        if (prev) Object.assign(state, prev)
        break
      }
      case 'cm': {
        const n = args.numbers
        if (n.length >= 6) {
          state.ctm = multiply(state.ctm, [n[0]!, n[1]!, n[2]!, n[3]!, n[4]!, n[5]!])
        }
        break
      }
      case 'BT':
        state.tm = clone(IDENTITY)
        state.tlm = clone(IDENTITY)
        break
      case 'ET':
        break
      case 'Tf':
        state.fontName = args.names.at(-2) ?? args.names.at(-1) ?? state.fontName
        if (args.names.length && args.numbers.length) {
          state.fontName = args.names[0] ?? state.fontName
          state.fontSize = args.numbers[0] ?? state.fontSize
        }
        break
      case 'Tc':
        state.charSpacing = args.numbers[0] ?? 0
        break
      case 'Tw':
        state.wordSpacing = args.numbers[0] ?? 0
        break
      case 'TL':
        state.leading = args.numbers[0] ?? 0
        break
      case 'Ts':
        state.rise = args.numbers[0] ?? 0
        break
      case 'Td':
      case 'TD': {
        const tx = args.numbers[0] ?? 0
        const ty = args.numbers[1] ?? 0
        if (op === 'TD') state.leading = -ty
        // Td translates in text space: T(tx, ty) × Tlm (PDF 32000 §9.4.2).
        state.tlm = multiply(state.tlm, translate(tx, ty))
        state.tm = clone(state.tlm)
        break
      }
      case 'Tm': {
        const n = args.numbers
        if (n.length >= 6) {
          state.tm = [n[0]!, n[1]!, n[2]!, n[3]!, n[4]!, n[5]!]
          state.tlm = clone(state.tm)
        }
        break
      }
      case 'T*':
        state.tlm = multiply(state.tlm, translate(0, -state.leading))
        state.tm = clone(state.tlm)
        break
      case "'":
        state.tlm = multiply(state.tlm, translate(0, -state.leading))
        state.tm = clone(state.tlm)
        pushText(ops, bytes, tokens, argStart, i, state, formPath, seq)
        seq += 1
        break
      case '"':
        state.wordSpacing = args.numbers[0] ?? state.wordSpacing
        state.charSpacing = args.numbers[1] ?? state.charSpacing
        state.tlm = multiply(state.tlm, translate(0, -state.leading))
        state.tm = clone(state.tlm)
        pushText(ops, bytes, tokens, argStart, i, state, formPath, seq)
        seq += 1
        break
      case 'Tj':
      case 'TJ':
        pushText(ops, bytes, tokens, argStart, i, state, formPath, seq)
        seq += 1
        break
      case 'Do': {
        const name = (args.names[0] ?? '').replace(/^\//, '')
        const form = options.getForm?.(name)
        const depth = options.depth ?? 0
        const nextPath = formPath ? `${formPath}/${formCount + 1}` : String(formCount + 1)
        if (form) {
          formCount += 1
          options.onForm?.(nextPath, form)
        }
        if (form && !options.shared?.has(nextPath) && depth < PDF.MAX_FORM_DEPTH) {
          const childOpts: Parameters<typeof walkTextOps>[1] = {
            formPath: nextPath,
            depth: depth + 1,
            ctm: multiply(state.ctm, form.matrix),
          }
          const nextGet = form.getForm ?? options.getForm
          if (nextGet) childOpts.getForm = nextGet
          if (options.shared) childOpts.shared = options.shared
          if (options.onForm) childOpts.onForm = options.onForm
          const child = walkTextOps(form.content, childOpts)
          for (const item of child) ops.push({ ...item, seq: seq + item.seq })
          seq += child.length
        }
        break
      }
      default:
        break
    }
    i += 1
  }
  return ops
}

function pushText(
  ops: TextOp[],
  bytes: Uint8Array,
  tokens: Token[],
  argStart: number,
  opIndex: number,
  state: GState,
  formPath: string,
  seq: number,
): void {
  const startToken = tokens[argStart]
  const opToken = tokens[opIndex]
  if (!startToken || !opToken) return
  const trm = multiply(state.ctm, multiply(state.tm, [1, 0, 0, 1, 0, state.rise]))
  const origin = apply(trm, 0, 0)
  ops.push({
    tokenRange: [startToken.start, opToken.end],
    start: origin,
    fontName: state.fontName.replace(/^\//, ''),
    formPath,
    seq,
  })
}

function operandsBefore(
  tokens: Token[],
  bytes: Uint8Array,
  opIndex: number,
): { start: number; numbers: number[]; names: string[] } {
  let i = opIndex
  const numbers: number[] = []
  const names: string[] = []
  let depth = 0
  while (i > 0) {
    i -= 1
    const token = tokens[i]
    if (!token || token.kind === 'space') continue
    if (token.kind === 'operator' || token.kind === 'inline-image') {
      i += 1
      break
    }
    if (token.kind === 'rbracket' || token.kind === 'rdict') depth += 1
    else if (token.kind === 'lbracket' || token.kind === 'ldict') {
      depth -= 1
      if (depth < 0) {
        i += 1
        break
      }
    } else if (depth === 0) {
      if (token.kind === 'number') numbers.unshift(num(tokens, bytes, i))
      if (token.kind === 'name') names.unshift(tokenText(bytes, token))
    }
  }
  while (i < opIndex && tokens[i]?.kind === 'space') i += 1
  return { start: i, numbers, names }
}
