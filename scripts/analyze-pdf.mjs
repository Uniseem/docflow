import { PDFDocument, rgb } from '@cantoo/pdf-lib'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { analyzePdf } from '../src/main/pdf/analyze.ts'

const pdfPath = process.argv[2]
if (!pdfPath) {
  console.error('usage: node scripts/analyze-pdf.mjs <pdf>')
  process.exit(1)
}

const analysis = await analyzePdf(pdfPath)
const dir = dirname(pdfPath)
const stem = basename(pdfPath).replace(/\.pdf$/i, '')
const jsonPath = join(dir, `${stem}.analysis.json`)
await writeFile(jsonPath, `${JSON.stringify(analysis, null, 2)}\n`)

const bytes = await readFile(pdfPath)
const doc = await PDFDocument.load(bytes, { ignoreEncryption: true })
const pages = doc.getPages()
for (const para of analysis.paragraphs) {
  const page = pages[para.page]
  if (!page) continue
  const [x0, y0, x1, y1] = para.bbox
  const color = para.translatable ? rgb(0.1, 0.7, 0.2) : rgb(0.5, 0.5, 0.5)
  page.drawRectangle({
    x: x0,
    y: y0,
    width: Math.max(1, x1 - x0),
    height: Math.max(1, y1 - y0),
    borderColor: color,
    borderWidth: 0.6,
    color: undefined,
    opacity: 0,
  })
  if (!para.translatable && para.skipReason) {
    page.drawText(para.skipReason, {
      x: x0,
      y: y1 + 2,
      size: 6,
      color,
    })
  }
  for (const run of para.runs) {
    const [rx0, ry0, rx1, ry1] = run.bbox
    page.drawRectangle({
      x: rx0,
      y: ry0,
      width: Math.max(1, rx1 - rx0),
      height: Math.max(1, ry1 - ry0),
      borderColor: rgb(0.85, 0.1, 0.1),
      borderWidth: 0.5,
    })
  }
  for (const line of para.lines) {
    page.drawLine({
      start: { x: line.bbox[0], y: line.baseline },
      end: { x: line.bbox[2], y: line.baseline },
      thickness: 0.3,
      color: rgb(0.2, 0.4, 0.9),
    })
  }
}
const debugPath = join(dir, `${stem}.debug.pdf`)
await writeFile(debugPath, await doc.save())
process.stdout.write(
  `${jsonPath}\n${debugPath}\npages=${analysis.pages} paragraphs=${analysis.stats.paragraphs} translatable=${analysis.stats.translatable} runs=${analysis.stats.runs}\n`,
)
