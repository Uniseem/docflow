import {
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFString,
  degrees,
  type PDFObject,
} from '@cantoo/pdf-lib'
import { describe, expect, test } from 'vitest'
import { buildDualPdf, keepPages, type DualOptions } from './dual'
import { readOutline, type OutlineItem } from './outline'
import { contentBytesOf } from './streams'

type Row = { title: string; depth: number; dest: Array<number | string> | null }

function value(obj: PDFObject): number | string {
  if (obj instanceof PDFNumber) return obj.asNumber()
  if (obj instanceof PDFName) return obj.decodeText()
  return String(obj)
}

/** Title, depth and destination (page index first) of every outline item, depth first. */
function outlineOf(doc: PDFDocument): Row[] {
  const out: Row[] = []
  const walk = (items: readonly OutlineItem[], depth: number) => {
    for (const item of items) {
      out.push({
        title: item.title,
        depth,
        dest: item.page === null ? null : [item.page, ...item.params.map(value)],
      })
      walk(item.children, depth + 1)
    }
  }
  walk(readOutline(doc), 0)
  return out
}

/**
 * Three 600 × 800 pages marked orig-<i> (the third optionally /Rotate 90) and the outline
 * Chapter 1 → p0 (explicit XYZ), Chapter 2 → p1 (named destination) › Section 2.1 → p2
 * (GoTo action, FitH).
 */
async function source(options: { rotateLast?: boolean } = {}): Promise<PDFDocument> {
  const doc = await PDFDocument.create()
  for (let i = 0; i < 3; i += 1) {
    doc.addPage([600, 800]).node.set(PDFName.of('DocFlowTest'), PDFString.of(`orig-${i}`))
  }
  if (options.rotateLast) doc.getPage(2).setRotation(degrees(90))
  const [p0, p1, p2] = doc.getPages().map((page) => page.ref)
  const ctx = doc.context
  doc.catalog.set(PDFName.of('Dests'), ctx.obj({ ch2: [p1!, 'XYZ', 10, 780, null] }))
  const [root, c1, c2, s21] = [ctx.nextRef(), ctx.nextRef(), ctx.nextRef(), ctx.nextRef()]
  const title = (text: string) => PDFHexString.fromText(text)
  ctx.assign(
    c1,
    ctx.obj({ Title: title('Chapter 1'), Parent: root, Next: c2, Dest: [p0!, 'XYZ', 50, 700, 0] }),
  )
  ctx.assign(
    c2,
    ctx.obj({
      Title: title('Chapter 2'),
      Parent: root,
      Prev: c1,
      First: s21,
      Last: s21,
      Count: 1,
      Dest: 'ch2',
    }),
  )
  ctx.assign(
    s21,
    ctx.obj({ Title: title('Section 2.1'), Parent: c2, A: { S: 'GoTo', D: [p2!, 'FitH', 400] } }),
  )
  ctx.assign(root, ctx.obj({ Type: 'Outlines', First: c1, Last: c2, Count: 3 }))
  doc.catalog.set(PDFName.of('Outlines'), root)
  return doc
}

function marks(doc: PDFDocument): string[] {
  return doc.getPages().map((page) => {
    const mark = page.node.get(PDFName.of('DocFlowTest'))
    return mark instanceof PDFString ? mark.decodeText() : '?'
  })
}

/** buildDualPdf with a "translation" of the same pages marked mono-<i>, trimmed like compose. */
async function dual(src: PDFDocument, options: Partial<DualOptions> = {}): Promise<PDFDocument> {
  const mono = await PDFDocument.load(await src.save())
  mono.getPages().forEach((page, i) => {
    page.node.set(PDFName.of('DocFlowTest'), PDFString.of(`mono-${i}`))
  })
  if (options.keep) keepPages(mono, options.keep)
  const bytes = await buildDualPdf(await src.save(), await mono.save(), {
    mode: 'side-by-side',
    translateFirst: false,
    keep: null,
    ...options,
  })
  return PDFDocument.load(bytes)
}

const FULL: Row[] = [
  { title: 'Chapter 1', depth: 0, dest: [0, 'XYZ', 50, 700, 0] },
  { title: 'Chapter 2', depth: 0, dest: [1, 'XYZ', 10, 780, 'null'] },
  { title: 'Section 2.1', depth: 1, dest: [2, 'FitH', 400] },
]

describe('readOutline (get_toc)', () => {
  test('explicit, named and GoTo destinations, nested', async () => {
    expect(outlineOf(await source())).toEqual(FULL)
  })
})

describe('side by side (create_side_by_side_dual_pdf)', () => {
  test('one page per source page as wide as both; bookmarks kept', async () => {
    const doc = await dual(await source(), { title: 'Paper' })
    expect(doc.getPages().map((p) => [p.getWidth(), p.getHeight()])).toEqual([
      [1200, 800],
      [1200, 800],
      [1200, 800],
    ])
    // The original is on the left at x 0: destinations keep their coordinates.
    expect(outlineOf(doc)).toEqual(FULL)
    expect(doc.getTitle()).toBe('Paper（双语）')
  })

  test('both sides are drawn as form XObjects, the original first', async () => {
    const src = await PDFDocument.create()
    src.addPage([600, 800]).drawRectangle({ x: 10, y: 10, width: 50, height: 50 })
    const doc = await dual(src)
    const content = Buffer.from(contentBytesOf(doc.getPage(0))).toString('latin1')
    // show_pdf_page at x 0 (original) and x 600 (translation), scale 1.
    expect(content).toMatch(/1 0 0 1 0 0 cm\s+\/O\S* Do[\s\S]*1 0 0 1 600 0 cm\s+\/T\S* Do/)
  })

  test('translation first: the original moves right and destinations follow it', async () => {
    const doc = await dual(await source(), { translateFirst: true })
    expect(outlineOf(doc)[0]?.dest).toEqual([0, 'XYZ', 650, 700, 0])
    expect(outlineOf(doc)[2]?.dest).toEqual([2, 'FitH', 400])
  })

  test('a /Rotate 90 page is shown upright and its bookmark fits the page', async () => {
    const doc = await dual(await source({ rotateLast: true }))
    const last = doc.getPage(2)
    expect([last.getWidth(), last.getHeight()]).toEqual([1600, 600])
    expect(outlineOf(doc)[2]?.dest).toEqual([2, 'Fit'])
  })

  test('only the kept pages, renumbered; bookmarks to dropped pages go', async () => {
    const doc = await dual(await source(), { keep: [1, 2] })
    expect(doc.getPageCount()).toBe(2)
    expect(outlineOf(doc)).toEqual([
      { title: 'Chapter 2', depth: 0, dest: [0, 'XYZ', 10, 780, 'null'] },
      { title: 'Section 2.1', depth: 1, dest: [1, 'FitH', 400] },
    ])
  })
})

describe('alternating (create_alternating_pages_dual_pdf)', () => {
  test('original then translation, the outline pointing at the originals', async () => {
    const doc = await dual(await source(), { mode: 'alternating' })
    expect(marks(doc)).toEqual(['orig-0', 'mono-0', 'orig-1', 'mono-1', 'orig-2', 'mono-2'])
    expect(outlineOf(doc).map((row) => row.dest?.[0])).toEqual([0, 2, 4])
  })

  test('translation first swaps each pair', async () => {
    const doc = await dual(await source(), { mode: 'alternating', translateFirst: true })
    expect(marks(doc)).toEqual(['mono-0', 'orig-0', 'mono-1', 'orig-1', 'mono-2', 'orig-2'])
    expect(outlineOf(doc).map((row) => row.dest?.[0])).toEqual([1, 3, 5])
  })

  test('only the kept pages', async () => {
    const doc = await dual(await source(), { mode: 'alternating', keep: [2] })
    expect(marks(doc)).toEqual(['orig-2', 'mono-2'])
    expect(outlineOf(doc)).toEqual([{ title: 'Section 2.1', depth: 0, dest: [0, 'FitH', 400] }])
  })
})

describe('keepPages (only_include_translated_page)', () => {
  test('drops the other pages; children of a dropped bookmark move up', async () => {
    const doc = await source()
    keepPages(doc, [0, 2])
    expect(marks(doc)).toEqual(['orig-0', 'orig-2'])
    expect(outlineOf(doc)).toEqual([
      { title: 'Chapter 1', depth: 0, dest: [0, 'XYZ', 50, 700, 0] },
      { title: 'Section 2.1', depth: 0, dest: [1, 'FitH', 400] },
    ])
  })

  test('a document without an outline stays without one', async () => {
    const doc = await PDFDocument.create()
    for (let i = 0; i < 3; i += 1) doc.addPage([600, 800])
    keepPages(doc, [1])
    expect(doc.getPageCount()).toBe(1)
    expect(doc.catalog.get(PDFName.of('Outlines'))).toBeUndefined()
  })
})
