import { PDFDocument } from '@cantoo/pdf-lib'

// PDF whitespace only: `\s` would also match NBSP (0xA0) in the latin1 view of binary data.
const WS = '[\\0\\t\\n\\f\\r ]'
const LENGTH_REF_RE = new RegExp(`/Length${WS}+(\\d+)${WS}+(\\d+)${WS}+R`, 'g')
const INT_OBJECT_RE = new RegExp(
  `(?<![\\d.])(\\d+)${WS}+(\\d+)${WS}+obj${WS}*(\\d+)${WS}*endobj`,
  'g',
)

/**
 * pdf-lib cannot resolve an indirect `/Length` while it parses the stream that uses it, so it
 * scans for `endstream` and drops a CR/LF in front of it — even when that byte is data (for
 * example the last byte of a Flate stream's checksum). Rewrite resolvable `/Length n g R`
 * entries to the number they point at, padded to the same byte length so offsets and the
 * xref table stay valid. Returns the input unchanged when nothing needs patching.
 */
export function inlineIndirectLengths(bytes: Uint8Array): Uint8Array {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1')
  if (!text.includes('/Length')) return bytes
  const values = new Map<string, string>()
  for (const match of text.matchAll(INT_OBJECT_RE)) {
    values.set(`${match[1]} ${match[2]}`, match[3] ?? '')
  }
  let patched: Uint8Array | null = null
  for (const match of text.matchAll(LENGTH_REF_RE)) {
    const value = values.get(`${match[1]} ${match[2]}`)
    if (!value) continue
    const replacement = `/Length ${value}`
    if (replacement.length > match[0].length) continue
    patched ??= new Uint8Array(bytes)
    const padded = replacement.padEnd(match[0].length, ' ')
    for (let i = 0; i < padded.length; i += 1) patched[match.index + i] = padded.charCodeAt(i)
  }
  return patched ?? bytes
}

export function loadPdfLib(bytes: Uint8Array): Promise<PDFDocument> {
  return PDFDocument.load(inlineIndirectLengths(bytes), { ignoreEncryption: true })
}
