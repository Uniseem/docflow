import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { PDFDocument } from '@cantoo/pdf-lib'
import { extractPageGraphics } from '../analyze/glyphs'
import { openPdfDocument } from '../pdfjs'
import { walkTextOps } from './content-walker'
import { loadPageGraph } from './resources'
import { PDF } from '../../../shared/pdf-constants'

const dir = join(process.cwd(), 'tests/fixtures')

describe('walkTextOps', () => {
  test('single-column first show-text matches first glyph', async () => {
    const path = join(dir, 'single-column.pdf')
    const bytes = await readFile(path)
    const doc = await openPdfDocument(bytes)
    const page = await doc.getPage(1)
    const graphics = await extractPageGraphics(page, 0)
    const pdf = await PDFDocument.load(bytes)
    const graph = loadPageGraph(pdf, pdf.getPages()[0]!)
    const ops = walkTextOps(graph.content, { getForm: graph.getForm })
    expect(ops.length).toBeGreaterThan(0)
    const first = graphics.glyphs[0]!
    const hit = ops.some(
      (op) =>
        op.formPath === first.formPath &&
        Math.hypot(op.start[0] - first.x, op.start[1] - first.y) <= PDF.OP_MATCH_TOLERANCE,
    )
    expect(hit).toBe(true)
    page.cleanup()
    await doc.cleanup()
  })

  test('each show-text start matches the first glyph of that operator', async () => {
    for (const name of [
      'single-column.pdf',
      'tj-arrays.pdf',
      'form-wrapped.pdf',
      'two-column.pdf',
    ]) {
      const bytes = await readFile(join(dir, name))
      const js = await openPdfDocument(bytes)
      const pdf = await PDFDocument.load(bytes)
      const pages = Math.min(js.numPages, 1)
      for (let i = 0; i < pages; i += 1) {
        const page = await js.getPage(i + 1)
        const { glyphs } = await extractPageGraphics(page, i)
        const graph = loadPageGraph(pdf, pdf.getPages()[i]!)
        const ops = walkTextOps(graph.content, {
          getForm: graph.getForm,
          onForm: (path, form) => {
            void path
            void form
          },
        })
        const firsts = new Map<string, (typeof glyphs)[number]>()
        for (const glyph of glyphs) {
          const key = `${glyph.formPath}:${glyph.opSeq}`
          if (!firsts.has(key)) firsts.set(key, glyph)
        }
        for (const glyph of firsts.values()) {
          const hit = ops.some(
            (op) =>
              op.formPath === glyph.formPath &&
              Math.hypot(op.start[0] - glyph.x, op.start[1] - glyph.y) <= PDF.OP_MATCH_TOLERANCE,
          )
          expect(hit, `${name} opSeq ${glyph.opSeq} at ${glyph.x},${glyph.y}`).toBe(true)
        }
        page.cleanup()
      }
      await js.cleanup()
    }
  })

  test('records token ranges covering operands', () => {
    const bytes = Buffer.from('BT /F1 12 Tf 1 0 0 1 72 720 Tm (Hello) Tj ET', 'latin1')
    const ops = walkTextOps(bytes)
    expect(ops).toHaveLength(1)
    const slice = bytes.subarray(ops[0]!.tokenRange[0], ops[0]!.tokenRange[1]).toString('latin1')
    expect(slice).toBe('(Hello) Tj')
    expect(ops[0]!.fontName).toBe('F1')
  })

  test('Td moves in text space under a scaled Tm and CTM', () => {
    const bytes = Buffer.from(
      'q 0.5 0 0 0.5 0 0 cm BT /F1 1 Tf 20 0 0 20 144 1440 Tm (Hello) Tj ' +
        '0 -1.5 Td (Scaled) Tj 2 0 Td [(A) -500 (B)] TJ 3 TL T* (Next) Tj ET Q',
      'latin1',
    )
    const starts = walkTextOps(bytes).map((op) => op.start.map((v) => Math.round(v * 100) / 100))
    expect(starts).toEqual([
      [72, 720],
      [72, 705],
      [92, 705],
      [92, 675],
    ])
  })

  test('skips shared forms', async () => {
    const bytes = await readFile(join(dir, 'shared-form.pdf'))
    const pdf = await PDFDocument.load(bytes)
    const graph = loadPageGraph(pdf, pdf.getPages()[0]!)
    const all = walkTextOps(graph.content, { getForm: graph.getForm })
    const skipped = walkTextOps(graph.content, { getForm: graph.getForm, shared: new Set(['1']) })
    expect(skipped.length).toBeLessThanOrEqual(all.length)
    expect(skipped.every((op) => op.formPath !== '1')).toBe(true)
  })
})
