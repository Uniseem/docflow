import { describe, expect, test } from 'vitest'
import { PDFDict, PDFDocument, PDFName, PDFRef, type PDFPage } from '@cantoo/pdf-lib'
import { mountFonts } from './resources'

function fontOf(page: PDFPage, name: string): unknown {
  const resources = page.node.Resources()
  const fonts = resources?.lookupMaybe(PDFName.of('Font'), PDFDict)
  return fonts?.get(PDFName.of(name))
}

describe('mountFonts', () => {
  test('pages sharing one /Resources object keep their own font aliases', async () => {
    const doc = await PDFDocument.create()
    const a = doc.addPage([200, 200])
    const b = doc.addPage([200, 200])
    const shared = doc.context.register(doc.context.obj({ Font: {} }))
    a.node.set(PDFName.of('Resources'), shared)
    b.node.set(PDFName.of('Resources'), shared)
    mountFonts(a, [['DFo1', PDFRef.of(101)]])
    mountFonts(b, [['DFo1', PDFRef.of(202)]])
    expect(fontOf(a, 'DFo1')).toBe(PDFRef.of(101))
    expect(fontOf(b, 'DFo1')).toBe(PDFRef.of(202))
    const original = doc.context.lookup(shared, PDFDict).lookupMaybe(PDFName.of('Font'), PDFDict)
    expect(original?.get(PDFName.of('DFo1'))).toBeUndefined()
  })

  test('pages inheriting /Resources from the page tree keep their own font aliases', async () => {
    const doc = await PDFDocument.create()
    const a = doc.addPage([200, 200])
    const b = doc.addPage([200, 200])
    a.node.delete(PDFName.of('Resources'))
    b.node.delete(PDFName.of('Resources'))
    doc.catalog.Pages().set(PDFName.of('Resources'), doc.context.obj({ Font: {} }))
    mountFonts(a, [['DFo1', PDFRef.of(101)]])
    mountFonts(b, [['DFo1', PDFRef.of(202)]])
    expect(fontOf(a, 'DFo1')).toBe(PDFRef.of(101))
    expect(fontOf(b, 'DFo1')).toBe(PDFRef.of(202))
  })

  test('keeps existing font entries of the page', async () => {
    const doc = await PDFDocument.create()
    const page = doc.addPage([200, 200])
    page.node.setFontDictionary(PDFName.of('F1'), PDFRef.of(7))
    mountFonts(page, [['DFcjk', PDFRef.of(8)]])
    expect(fontOf(page, 'F1')).toBe(PDFRef.of(7))
    expect(fontOf(page, 'DFcjk')).toBe(PDFRef.of(8))
  })
})
