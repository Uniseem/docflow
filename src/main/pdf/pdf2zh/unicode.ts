// pdfminer.six 20250416 `to_unichr`, the text of every LTChar pdf2zh sees: ToUnicode first,
// then the font encoding (pdffont.PDFSimpleFont / PDFType1Font / PDFCIDFont, encodingdb,
// cmapdb.CMapParser). A code it cannot map becomes "(cid:N)", which pdf2zh treats as a formula.
import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFStream,
  PDFString,
  type PDFDocument,
} from '@cantoo/pdf-lib'
import { lexContent, tokenText } from '../compose/content-lexer'
import { streamBytes } from '../compose/streams'
import { GLYPH_TO_UNICODE, LATIN_ENCODING, METRIC_FONTS } from './pdfminer-tables'

/** A code's text, or undefined when pdfminer raises PDFUnicodeNotDefined. */
export type ToUnichr = (code: number) => string | undefined

/** 'pdfjs': pdfminer has a mapping we do not port (CMap registries, TrueType cmap). */
export type UnicodeSource = ToUnichr | 'pdfjs'

type Encoding = Map<number, string>

const ENCODINGS: Record<string, Encoding> = (() => {
  const std: Encoding = new Map()
  const mac: Encoding = new Map()
  const win: Encoding = new Map()
  const pdf: Encoding = new Map()
  for (const [name, s, m, w, p] of LATIN_ENCODING) {
    const c = name2unicode(name)
    if (s) std.set(s, c)
    if (m) mac.set(m, c)
    if (w) win.set(w, c)
    if (p) pdf.set(p, c)
  }
  return {
    StandardEncoding: std,
    MacRomanEncoding: mac,
    WinAnsiEncoding: win,
    PDFDocEncoding: pdf,
  }
})()

/** Python str.strip(chars) */
function stripChars(value: string, chars: string): string {
  let start = 0
  let end = value.length
  while (start < end && chars.includes(value[start]!)) start += 1
  while (end > start && chars.includes(value[end - 1]!)) end -= 1
  return value.slice(start, end)
}

function checkedChar(code: number): string {
  if (code > 55295 && code < 57344) throw new Error(`invalid unicode ${code}`)
  return String.fromCodePoint(code)
}

/** encodingdb.name2unicode; throws where pdfminer raises. */
export function name2unicode(glyph: string): string {
  const name = glyph.split('.')[0] ?? ''
  const components = name.split('_')
  if (components.length > 1) return components.map(name2unicode).join('')
  const known = GLYPH_TO_UNICODE[name]
  if (known !== undefined) return known
  if (name.startsWith('uni')) {
    const hex = stripChars(name, 'uni')
    if (/^[0-9a-fA-F]/.test(hex) && hex.length % 4 === 0) {
      let out = ''
      for (let i = 0; i < hex.length; i += 4) {
        const digit = Number.parseInt(hex.slice(i, i + 4), 16)
        if (Number.isNaN(digit)) throw new Error(`bad glyph name ${glyph}`)
        out += checkedChar(digit)
      }
      return out
    }
  } else if (name.startsWith('u')) {
    const hex = stripChars(name, 'u')
    if (/^[0-9a-fA-F]/.test(hex) && hex.length >= 4 && hex.length <= 6) {
      const digit = Number.parseInt(hex, 16)
      if (Number.isNaN(digit)) throw new Error(`bad glyph name ${glyph}`)
      return checkedChar(digit)
    }
  }
  throw new Error(`unknown glyph name ${glyph}`)
}

function tryName(name: string): string | undefined {
  try {
    return name2unicode(name)
  } catch {
    return undefined
  }
}

/** EncodingDB.get_encoding(name, diff) */
function getEncoding(name: string, diff?: ReadonlyArray<number | string>): Encoding {
  const base = ENCODINGS[name] ?? ENCODINGS.StandardEncoding!
  if (!diff?.length) return base
  const out = new Map(base)
  let cid = 0
  for (const item of diff) {
    if (typeof item === 'number') cid = item
    else {
      const text = tryName(item)
      if (text !== undefined) out.set(cid, text)
      cid += 1
    }
  }
  return out
}

/** UTF-16BE decode with errors="ignore". */
function utf16be(bytes: Uint8Array): string {
  const units: number[] = []
  for (let i = 0; i + 1 < bytes.length; i += 2) units.push((bytes[i]! << 8) | bytes[i + 1]!)
  let out = ''
  for (let i = 0; i < units.length; i += 1) {
    const u = units[i]!
    if (u >= 0xd800 && u <= 0xdbff) {
      const next = units[i + 1]
      if (next !== undefined && next >= 0xdc00 && next <= 0xdfff) {
        out += String.fromCharCode(u, next)
        i += 1
      }
      continue
    }
    if (u >= 0xdc00 && u <= 0xdfff) continue
    out += String.fromCharCode(u)
  }
  return out
}

function nunpack(bytes: Uint8Array): number {
  let n = 0
  for (const b of bytes) n = n * 256 + b
  return n
}

/** Bytes of a PostScript string token: <hex> or (literal) with escapes. */
function stringBytes(raw: string): Uint8Array {
  if (raw.startsWith('<')) {
    const hex = raw.slice(1, -1).replace(/[^0-9a-fA-F]/g, '')
    const even = hex.length % 2 ? `${hex}0` : hex
    const out = new Uint8Array(even.length / 2)
    for (let i = 0; i < out.length; i += 1)
      out[i] = Number.parseInt(even.slice(i * 2, i * 2 + 2), 16)
    return out
  }
  const body = raw.slice(1, -1)
  const out: number[] = []
  for (let i = 0; i < body.length; i += 1) {
    const c = body.charCodeAt(i)
    if (c !== 92) {
      out.push(c & 0xff)
      continue
    }
    i += 1
    const e = body[i]
    if (e === undefined) break
    const simple: Record<string, number> = {
      n: 10,
      r: 13,
      t: 9,
      b: 8,
      f: 12,
      '(': 40,
      ')': 41,
      '\\': 92,
    }
    if (e in simple) out.push(simple[e]!)
    else if (/[0-7]/.test(e)) {
      let oct = e
      while (oct.length < 3 && /[0-7]/.test(body[i + 1] ?? '')) oct += body[(i += 1)]
      out.push(Number.parseInt(oct, 8) & 0xff)
    } else if (e === '\r') {
      if (body[i + 1] === '\n') i += 1
    } else if (e !== '\n') out.push(e.charCodeAt(0) & 0xff)
  }
  return Uint8Array.from(out)
}

type PsValue =
  | { kind: 'bytes'; value: Uint8Array }
  | { kind: 'int'; value: number }
  | { kind: 'name'; value: string }
  | { kind: 'array'; value: PsValue[] }
  | { kind: 'other' }

/** cmapdb.CMapParser into a FileUnicodeMap (bfchar, bfrange, cidchar, cidrange). */
export function parseToUnicode(data: Uint8Array): Map<number, string> {
  const map = new Map<number, string>()
  const add = (cid: number, code: PsValue) => {
    let text: string
    if (code.kind === 'name') {
      const t = tryName(code.value)
      if (t === undefined) return
      text = t
    } else if (code.kind === 'bytes') text = utf16be(code.value)
    else if (code.kind === 'int') text = String.fromCodePoint(code.value)
    else return
    if (text === '\u00a0' && map.get(cid) === ' ') return
    map.set(cid, text)
  }
  const tokens = lexContent(data)
  let stack: PsValue[] = []
  const arrays: PsValue[][] = []
  let inCmap = true
  const push = (value: PsValue) => {
    const top = arrays.at(-1)
    if (top) top.push(value)
    else stack.push(value)
  }
  for (const token of tokens) {
    if (token.kind === 'space') continue
    const text = tokenText(data, token)
    switch (token.kind) {
      case 'number':
        push(text.includes('.') ? { kind: 'other' } : { kind: 'int', value: Number(text) })
        continue
      case 'name':
        push({ kind: 'name', value: text.slice(1) })
        continue
      case 'string':
      case 'hex':
        push({ kind: 'bytes', value: stringBytes(text) })
        continue
      case 'lbracket':
        arrays.push([])
        continue
      case 'rbracket': {
        const done = arrays.pop()
        if (done) push({ kind: 'array', value: done })
        continue
      }
      case 'ldict':
      case 'rdict':
        continue
      case 'operator':
      case 'inline-image':
        break
    }
    if (text === 'begincmap') {
      inCmap = true
      stack = []
      continue
    }
    if (text === 'endcmap') {
      inCmap = false
      continue
    }
    if (!inCmap) continue
    const objs = stack
    if (text.startsWith('begin') || text === 'endcodespacerange' || text === 'endnotdefrange') {
      stack = []
      continue
    }
    if (text === 'endcidrange') {
      stack = []
      for (let i = 0; i + 2 < objs.length; i += 3) {
        const [s, e, cid] = [objs[i]!, objs[i + 1]!, objs[i + 2]!]
        if (s.kind !== 'bytes' || e.kind !== 'bytes' || cid.kind !== 'int') continue
        if (s.value.length !== e.value.length) continue
        const prefix = s.value.slice(0, -4)
        if (prefix.join() !== e.value.slice(0, -4).join()) continue
        const svar = s.value.slice(-4)
        const start = nunpack(svar)
        const end = nunpack(e.value.slice(-4))
        for (let k = 0; k <= end - start; k += 1) {
          const x = new Uint8Array([...prefix, ...bigEndian(start + k, svar.length)])
          add(cid.value + k, { kind: 'bytes', value: x })
        }
      }
      continue
    }
    if (text === 'endcidchar') {
      stack = []
      for (let i = 0; i + 1 < objs.length; i += 2) {
        const [cid, code] = [objs[i]!, objs[i + 1]!]
        if (code.kind === 'bytes' && cid.kind === 'int') add(cid.value, code)
      }
      continue
    }
    if (text === 'endbfrange') {
      stack = []
      for (let i = 0; i + 2 < objs.length; i += 3) {
        const [s, e, code] = [objs[i]!, objs[i + 1]!, objs[i + 2]!]
        if (s.kind !== 'bytes' || e.kind !== 'bytes' || s.value.length !== e.value.length) continue
        const start = nunpack(s.value)
        const end = nunpack(e.value)
        if (code.kind === 'array') {
          code.value.forEach((value, k) => {
            if (start + k <= end) add(start + k, value)
          })
        } else if (code.kind === 'bytes') {
          const v = code.value.slice(-4)
          const base = nunpack(v)
          const prefix = code.value.slice(0, -4)
          for (let k = 0; k <= end - start; k += 1) {
            add(start + k, {
              kind: 'bytes',
              value: new Uint8Array([...prefix, ...bigEndian(base + k, v.length)]),
            })
          }
        }
      }
      continue
    }
    if (text === 'endbfchar') {
      stack = []
      for (let i = 0; i + 1 < objs.length; i += 2) {
        const [cid, code] = [objs[i]!, objs[i + 1]!]
        if (cid.kind === 'bytes' && code.kind === 'bytes') add(nunpack(cid.value), code)
      }
      continue
    }
    if (text === 'def' || text === 'usecmap') {
      stack.splice(-(text === 'def' ? 2 : 1))
      continue
    }
    push({ kind: 'other' })
  }
  return map
}

function bigEndian(value: number, length: number): number[] {
  const out: number[] = []
  let v = value >>> 0
  for (let i = 0; i < 4; i += 1) {
    out.unshift(v & 0xff)
    v >>>= 8
  }
  return out.slice(4 - length)
}

/** Type1FontHeaderParser.get_encoding: `<int> /<name> put` in the clear-text header. */
export function type1Encoding(header: Uint8Array): Encoding {
  const text = Buffer.from(header).toString('latin1')
  const out: Encoding = new Map()
  const re = /(?:^|[\s[\]{}()<>/%])(\d+)\s*\/([^\s/[\]{}()<>%]+)\s+put(?=[\s[\]{}()<>/%]|$)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(text))) {
    const t = tryName(match[2]!)
    if (t !== undefined) out.set(Number(match[1]), t)
  }
  return out
}

function resolve(doc: PDFDocument, value: unknown): unknown {
  return value instanceof PDFRef ? doc.context.lookup(value) : value
}

function nameOf(value: unknown): string | undefined {
  return value instanceof PDFName ? value.decodeText() : undefined
}

function dictOf(doc: PDFDocument, value: unknown): PDFDict | undefined {
  const obj = resolve(doc, value)
  if (obj instanceof PDFDict) return obj
  if (obj instanceof PDFStream) return obj.dict
  return undefined
}

function textOf(doc: PDFDocument, value: unknown): string {
  const obj = resolve(doc, value)
  if (obj instanceof PDFString || obj instanceof PDFHexString) return obj.decodeText()
  return 'unknown'
}

function toUnicodeMap(doc: PDFDocument, value: unknown): Map<number, string> | undefined {
  const obj = resolve(doc, value)
  if (!(obj instanceof PDFStream)) return undefined
  try {
    return parseToUnicode(streamBytes(obj))
  } catch {
    return new Map()
  }
}

/** PDFResourceManager.get_font + to_unichr for one font dictionary. */
export function unicodeSource(doc: PDFDocument, fontDict: PDFDict): UnicodeSource {
  const subtype = nameOf(fontDict.get(PDFName.of('Subtype')))
  if (subtype === 'Type0') {
    const descendants = resolve(doc, fontDict.get(PDFName.of('DescendantFonts')))
    const child = descendants instanceof PDFArray ? dictOf(doc, descendants.get(0)) : undefined
    const info = dictOf(doc, child?.get(PDFName.of('CIDSystemInfo')))
    const ordering = textOf(doc, info?.get(PDFName.of('Ordering')))
    const cidcoding = `${textOf(doc, info?.get(PDFName.of('Registry'))).trim()}-${ordering.trim()}`
    const toUnicode = fontDict.get(PDFName.of('ToUnicode'))
    if (toUnicode !== undefined) {
      const map = toUnicodeMap(doc, toUnicode)
      if (map) return (code) => map.get(code)
      const cmapName = nameOf(resolve(doc, toUnicode)) ?? ''
      const encoding = nameOf(resolve(doc, fontDict.get(PDFName.of('Encoding')))) ?? ''
      if ([ordering, cmapName, encoding].some((n) => n.includes('Identity'))) {
        return (code) => String.fromCodePoint(code)
      }
      return () => undefined
    }
    if (cidcoding === 'Adobe-Identity' || cidcoding === 'Adobe-UCS') {
      const descriptor = dictOf(doc, child?.get(PDFName.of('FontDescriptor')))
      // TrueTypeFont.create_unicode_map() reads the embedded cmap, as pdf.js does.
      return descriptor?.get(PDFName.of('FontFile2')) ? 'pdfjs' : () => undefined
    }
    return 'pdfjs' // CMapDB.get_unicode_map for registered orderings
  }

  const encodingValue = resolve(doc, fontDict.get(PDFName.of('Encoding')))
  let cid2unicode: Encoding
  if (encodingValue instanceof PDFDict) {
    const base = nameOf(encodingValue.get(PDFName.of('BaseEncoding'))) ?? 'StandardEncoding'
    const diffs = resolve(doc, encodingValue.get(PDFName.of('Differences')))
    const diff: Array<number | string> = []
    if (diffs instanceof PDFArray) {
      for (let i = 0; i < diffs.size(); i += 1) {
        const item = diffs.lookup(i)
        if (item instanceof PDFNumber) diff.push(Math.trunc(item.asNumber()))
        else if (item instanceof PDFName) diff.push(item.decodeText())
      }
    }
    cid2unicode = getEncoding(base, diff)
  } else {
    cid2unicode = getEncoding(nameOf(encodingValue) ?? 'StandardEncoding')
  }
  const unicodeMap =
    fontDict.get(PDFName.of('ToUnicode')) !== undefined
      ? toUnicodeMap(doc, fontDict.get(PDFName.of('ToUnicode')))
      : undefined

  if (subtype !== 'Type3') {
    const baseFont = nameOf(fontDict.get(PDFName.of('BaseFont'))) ?? 'unknown'
    const descriptor = METRIC_FONTS.has(baseFont)
      ? undefined
      : dictOf(doc, fontDict.get(PDFName.of('FontDescriptor')))
    const fontFile = resolve(doc, descriptor?.get(PDFName.of('FontFile')))
    if (fontDict.get(PDFName.of('Encoding')) === undefined && fontFile instanceof PDFStream) {
      const length1 = resolve(doc, fontFile.dict.get(PDFName.of('Length1')))
      const n = length1 instanceof PDFNumber ? length1.asNumber() : 0
      cid2unicode = type1Encoding(streamBytes(fontFile).subarray(0, n))
    }
  }
  return (code) => unicodeMap?.get(code) ?? cid2unicode.get(code)
}
