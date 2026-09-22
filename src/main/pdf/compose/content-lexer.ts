export type TokenKind =
  | 'space'
  | 'number'
  | 'name'
  | 'string'
  | 'hex'
  | 'lbracket'
  | 'rbracket'
  | 'ldict'
  | 'rdict'
  | 'operator'
  | 'inline-image'

export type Token = {
  kind: TokenKind
  start: number
  end: number
}

const WS = new Set([0, 9, 10, 12, 13, 32])
const DELIM = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]) // ( ) < > [ ] { } / %

function isWs(b: number): boolean {
  return WS.has(b)
}

function isDigit(b: number): boolean {
  return b >= 48 && b <= 57
}

function isRegular(b: number): boolean {
  return !isWs(b) && !DELIM.has(b)
}

export function lexContent(bytes: Uint8Array): Token[] {
  const tokens: Token[] = []
  let i = 0
  const n = bytes.length

  const push = (kind: TokenKind, start: number, end: number) => {
    if (end > start) tokens.push({ kind, start, end })
  }

  const opText = (start: number, end: number) =>
    Buffer.from(bytes.subarray(start, end)).toString('latin1')

  while (i < n) {
    const b = bytes[i]!
    const start = i
    if (isWs(b)) {
      while (i < n && isWs(bytes[i]!)) i += 1
      push('space', start, i)
      continue
    }
    if (b === 37) {
      i += 1
      while (i < n && bytes[i] !== 10 && bytes[i] !== 13) i += 1
      if (i < n && bytes[i] === 13) {
        i += 1
        if (i < n && bytes[i] === 10) i += 1
      } else if (i < n && bytes[i] === 10) i += 1
      push('space', start, i)
      continue
    }
    if (b === 47) {
      i += 1
      while (i < n && isRegular(bytes[i]!)) i += 1
      push('name', start, i)
      continue
    }
    if (b === 40) {
      i = consumeString(bytes, i)
      push('string', start, i)
      continue
    }
    if (b === 60) {
      if (i + 1 < n && bytes[i + 1] === 60) {
        i += 2
        push('ldict', start, i)
        continue
      }
      i += 1
      while (i < n && bytes[i] !== 62) i += 1
      if (i < n) i += 1
      push('hex', start, i)
      continue
    }
    if (b === 62) {
      if (i + 1 < n && bytes[i + 1] === 62) {
        i += 2
        push('rdict', start, i)
        continue
      }
      i += 1
      push('operator', start, i)
      continue
    }
    if (b === 91) {
      i += 1
      push('lbracket', start, i)
      continue
    }
    if (b === 93) {
      i += 1
      push('rbracket', start, i)
      continue
    }
    if (b === 43 || b === 45 || b === 46 || isDigit(b)) {
      const numEnd = consumeNumber(bytes, i)
      if (numEnd > i) {
        i = numEnd
        push('number', start, i)
        continue
      }
    }
    while (i < n && isRegular(bytes[i]!)) i += 1
    if (i === start) i += 1
    const kind: TokenKind = opText(start, i) === 'BI' ? 'inline-image' : 'operator'
    if (kind === 'inline-image') {
      i = consumeInlineImage(bytes, i)
      push('inline-image', start, i)
    } else {
      push('operator', start, i)
    }
  }
  return tokens
}

function consumeNumber(bytes: Uint8Array, i: number): number {
  const n = bytes.length
  let j = i
  if (bytes[j] === 43 || bytes[j] === 45) j += 1
  let seen = false
  while (j < n && isDigit(bytes[j]!)) {
    seen = true
    j += 1
  }
  if (j < n && bytes[j] === 46) {
    j += 1
    while (j < n && isDigit(bytes[j]!)) {
      seen = true
      j += 1
    }
  }
  if (!seen) return i
  return j
}

function consumeString(bytes: Uint8Array, i: number): number {
  const n = bytes.length
  let depth = 0
  let j = i
  while (j < n) {
    const c = bytes[j]!
    if (c === 92) {
      j += 2
      continue
    }
    if (c === 40) depth += 1
    else if (c === 41) {
      depth -= 1
      j += 1
      if (depth === 0) return j
      continue
    }
    j += 1
  }
  return n
}

function consumeInlineImage(bytes: Uint8Array, afterBi: number): number {
  const n = bytes.length
  let i = afterBi
  while (i < n) {
    if (isWs(bytes[i]!) || bytes[i] === 37) {
      if (bytes[i] === 37) {
        while (i < n && bytes[i] !== 10 && bytes[i] !== 13) i += 1
      } else i += 1
      continue
    }
    if (bytes[i] === 73 && i + 1 < n && bytes[i + 1] === 68) {
      const prev = i === afterBi || !isRegular(bytes[i - 1]!)
      const next = i + 2 >= n || !isRegular(bytes[i + 2]!)
      if (prev && next) {
        i += 2
        if (i < n && isWs(bytes[i]!)) i += 1
        break
      }
    }
    i += 1
  }
  while (i < n) {
    if (isWs(bytes[i]!)) {
      const ws = i
      while (i < n && isWs(bytes[i]!)) i += 1
      if (i + 1 < n && bytes[i] === 69 && bytes[i + 1] === 73) {
        const after = i + 2
        if (after >= n || isWs(bytes[after]!) || after === n) {
          return after >= n ? n : after
        }
      }
      i = ws + 1
      continue
    }
    i += 1
  }
  return n
}

export function joinTokens(bytes: Uint8Array, tokens: readonly Token[]): Uint8Array {
  const out = new Uint8Array(bytes.length)
  let o = 0
  for (const token of tokens) {
    out.set(bytes.subarray(token.start, token.end), o)
    o += token.end - token.start
  }
  return out.subarray(0, o)
}

export function tokenText(bytes: Uint8Array, token: Token): string {
  return Buffer.from(bytes.subarray(token.start, token.end)).toString('latin1')
}
