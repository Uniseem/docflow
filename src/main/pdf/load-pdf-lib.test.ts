import { PDFDocument, PDFRawStream, PDFRef } from '@cantoo/pdf-lib'
import { describe, expect, test } from 'vitest'
import { inlineIndirectLengths, loadPdfLib } from './load-pdf-lib'

const DATA = '0 0 m\r' // the stream data itself ends with CR, right before `endstream`

function pdfWithIndirectLength(): Uint8Array {
  const text = [
    '%PDF-1.4',
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R >> endobj',
    `4 0 obj << /Length 5 0 R >>\nstream\n${DATA}endstream\nendobj`,
    `5 0 obj ${DATA.length} endobj`,
    'trailer << /Root 1 0 R /Size 6 >>',
    '%%EOF',
  ].join('\n')
  return new Uint8Array(Buffer.from(text, 'latin1'))
}

function contentsOf(doc: PDFDocument): Uint8Array {
  const stream = doc.context.lookup(PDFRef.of(4))
  if (!(stream instanceof PDFRawStream)) throw new Error('stream 4 missing')
  return stream.getContents()
}

describe('inlineIndirectLengths', () => {
  test('pdf-lib alone drops the trailing CR of a stream with an indirect Length', async () => {
    const doc = await PDFDocument.load(pdfWithIndirectLength())
    expect(contentsOf(doc).length).toBe(DATA.length - 1)
  })

  test('keeps every data byte once the Length is inlined', async () => {
    const doc = await loadPdfLib(pdfWithIndirectLength())
    expect(Buffer.from(contentsOf(doc)).toString('latin1')).toBe(DATA)
  })

  test('patches in place without changing the byte length', () => {
    const input = pdfWithIndirectLength()
    const output = inlineIndirectLengths(input)
    expect(output.length).toBe(input.length)
    expect(Buffer.from(output).toString('latin1')).toContain(`/Length ${DATA.length}     >>`)
    expect(Buffer.from(input).toString('latin1')).toContain('/Length 5 0 R >>')
  })

  test('returns the same bytes when there is nothing to patch', () => {
    const input = new Uint8Array(Buffer.from('%PDF-1.4\n1 0 obj << /Length 3 >> endobj', 'latin1'))
    expect(inlineIndirectLengths(input)).toBe(input)
  })

  test('skips a value that does not fit in the reference text', () => {
    const text = '4 0 obj << /Length 5 0 R >>\n5 0 obj 123456789 endobj'
    const input = new Uint8Array(Buffer.from(text, 'latin1'))
    expect(inlineIndirectLengths(input)).toBe(input)
  })
})
