import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { extractPageGraphics } from './glyphs'
import { openPdfDocument } from '../pdfjs'

const dir = join(process.cwd(), 'tests/fixtures')
const SKIP = new Set(['encrypted.pdf', 'empty.pdf', 'README.md'])

async function fixtures(): Promise<string[]> {
  const names = await readdir(dir)
  return names.filter(
    (name) => name.endsWith('.pdf') && !SKIP.has(name) && !name.startsWith('arxiv-'),
  )
}

describe('extractPageGraphics', () => {
  test('glyph origins match getTextContent within 0.05 pt', async () => {
    for (const name of await fixtures()) {
      const doc = await openPdfDocument(
        await (await import('node:fs/promises')).readFile(join(dir, name)),
      )
      const pages = Math.min(doc.numPages, name === 'long.pdf' ? 1 : 2)
      for (let i = 1; i <= pages; i += 1) {
        const page = await doc.getPage(i)
        const graphics = await extractPageGraphics(page, i - 1)
        const content = await page.getTextContent()
        for (const item of content.items) {
          if (!('str' in item) || !item.str.trim() || !item.transform) continue
          const x = Number(item.transform[4])
          const y = Number(item.transform[5])
          const hit = graphics.glyphs.some(
            (g) => Math.abs(g.x - x) <= 0.05 && Math.abs(g.y - y) <= 0.05,
          )
          expect(hit, `${name} p${i} item "${item.str.slice(0, 24)}" at ${x},${y}`).toBe(true)
        }
        page.cleanup()
      }
      await doc.cleanup()
    }
  })

  test('cid font is composite with 2-byte codes', async () => {
    const { readFile } = await import('node:fs/promises')
    const doc = await openPdfDocument(await readFile(join(dir, 'cid-font.pdf')))
    const page = await doc.getPage(1)
    const { glyphs } = await extractPageGraphics(page, 0)
    expect(glyphs.some((g) => g.composite && g.codeBytes === 2)).toBe(true)
    page.cleanup()
    await doc.cleanup()
  })

  test('invisible text uses render mode 3', async () => {
    const { readFile } = await import('node:fs/promises')
    const doc = await openPdfDocument(await readFile(join(dir, 'invisible-text.pdf')))
    const page = await doc.getPage(1)
    const { glyphs, imageRects } = await extractPageGraphics(page, 0)
    expect(glyphs.length).toBeGreaterThan(0)
    expect(glyphs.every((g) => g.renderMode === 3)).toBe(true)
    expect(imageRects.length).toBeGreaterThan(0)
    page.cleanup()
    await doc.cleanup()
  })

  test('colored text keeps rgb', async () => {
    const { readFile } = await import('node:fs/promises')
    const doc = await openPdfDocument(await readFile(join(dir, 'colored-text.pdf')))
    const page = await doc.getPage(1)
    const { glyphs } = await extractPageGraphics(page, 0)
    const red = glyphs.find((g) => g.unicode === 'R')
    expect(red).toBeTruthy()
    expect(red!.color[0]).toBeGreaterThan(0.7)
    expect(red!.color[1]).toBeLessThan(0.2)
    page.cleanup()
    await doc.cleanup()
  })

  test('form-wrapped glyphs have a form path', async () => {
    const { readFile } = await import('node:fs/promises')
    const doc = await openPdfDocument(await readFile(join(dir, 'form-wrapped.pdf')))
    const page = await doc.getPage(1)
    const { glyphs } = await extractPageGraphics(page, 0)
    expect(glyphs.length).toBeGreaterThan(0)
    expect(glyphs.every((g) => g.formPath === '1')).toBe(true)
    page.cleanup()
    await doc.cleanup()
  })
})
