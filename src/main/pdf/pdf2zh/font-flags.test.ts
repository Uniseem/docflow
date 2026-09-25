import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PDFName } from '@cantoo/pdf-lib'
import { describe, expect, test } from 'vitest'
import { loadPdfLib } from '../load-pdf-lib'
import { fontFlagsReader } from './font-flags'
import { lookupDict } from './pages'

describe('fontFlagsReader (BabelDOC _compute_font_style_flags)', () => {
  // Expected values computed with PyMuPDF 1.28.2 `pymupdf.Font(fontbuffer=extract_font(xref)[3])`.
  test('matches PyMuPDF on the arXiv fixture fonts', async () => {
    const bytes = await readFile(join(process.cwd(), 'tests/fixtures/arxiv-2201.11903.pdf'))
    const doc = await loadPdfLib(bytes)
    const read = await fontFlagsReader(doc)
    const resources = lookupDict(doc, doc.getPages()[0]!.node.Resources())
    const fonts = lookupDict(doc, resources?.get(PDFName.of('Font')))
    const flags = (name: string) => {
      const f = read(lookupDict(doc, fonts?.get(PDFName.of(name))))
      return [f.bold, f.italic, f.monospace, f.serif]
    }
    expect(flags('F65')).toEqual([true, false, false, true]) // NimbusRomNo9L-Medi
    expect(flags('F67')).toEqual([false, false, false, true]) // NimbusRomNo9L-Regu
    expect(flags('F72')).toEqual([false, true, false, true]) // NimbusRomNo9L-ReguItal
    expect(flags('F30')).toEqual([false, false, true, true]) // SFTT1000
    // Not embedded: PyMuPDF falls back to Noto Serif Regular.
    expect(flags('arXivStAmP')).toEqual([false, false, false, true])
  })
})
