// Debug: layout detection + pdf2zh paragraph parsing of one PDF.
// Writes <stem>.analysis.json and <stem>.debug.pdf (layout boxes, paragraph boxes, formulas).
// usage: npm run analyze -- <pdf>
import { PDFDocument, rgb } from '@cantoo/pdf-lib'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { analyzePdf } from '../src/main/pdf/analyze.ts'
import { inspectPdf } from '../src/main/pdf/inspect.ts'
import { detectPage } from '../src/main/pdf/pdf2zh/detect.ts'
import { needsTranslation } from '../src/main/pdf/pdf2zh/segments.ts'
import { bundledModel } from '../src/main/pipeline/run.ts'

const pdfPath = process.argv[2]
if (!pdfPath) {
  process.stderr.write('usage: npm run analyze -- <pdf>\n')
  process.exit(1)
}

const inspection = await inspectPdf(pdfPath)
const layouts = []
for (let i = 0; i < inspection.pages; i += 1)
  layouts.push(await detectPage(pdfPath, i, bundledModel()))
const analysis = await analyzePdf(pdfPath, layouts)
const dir = dirname(pdfPath)
const stem = basename(pdfPath).replace(/\.pdf$/i, '')
const jsonPath = join(dir, `${stem}.analysis.json`)
await writeFile(jsonPath, `${JSON.stringify({ layouts, analysis }, null, 2)}\n`)

const doc = await PDFDocument.load(await readFile(pdfPath), { ignoreEncryption: true })
const pages = doc.getPages()
layouts.forEach((layout, index) => {
  const page = pages[index]
  if (!page) return
  const crop = page.getCropBox()
  // Model boxes are in pixmap pixels (top-left origin) of the crop box.
  for (const box of layout.boxes) {
    const [x0, y0, x1, y1] = box.xyxy
    page.drawRectangle({
      x: crop.x + x0,
      y: crop.y + layout.height - y1,
      width: Math.max(1, x1 - x0),
      height: Math.max(1, y1 - y0),
      borderColor: rgb(0.2, 0.4, 0.9),
      borderWidth: 0.5,
    })
    page.drawText(`${box.name} ${box.conf.toFixed(2)}`, {
      x: crop.x + x0,
      y: crop.y + layout.height - y0 + 1,
      size: 5,
      color: rgb(0.2, 0.4, 0.9),
    })
  }
})
for (const unit of analysis.units) {
  const page = pages[unit.page]
  if (!page) continue
  const crop = page.getCropBox()
  unit.paragraphs.forEach((para, index) => {
    const color = needsTranslation(unit.texts[index] ?? '')
      ? rgb(0.1, 0.7, 0.2)
      : rgb(0.5, 0.5, 0.5)
    page.drawRectangle({
      x: crop.x + para.x0,
      y: crop.y + para.y0,
      width: Math.max(1, para.x1 - para.x0),
      height: Math.max(1, para.y1 - para.y0),
      borderColor: color,
      borderWidth: 0.6,
    })
  })
  for (const formula of unit.formulas) {
    for (const char of formula.chars) {
      page.drawRectangle({
        x: crop.x + char.x0,
        y: crop.y + char.y0,
        width: Math.max(0.5, char.x1 - char.x0),
        height: Math.max(0.5, char.y1 - char.y0),
        borderColor: rgb(0.85, 0.1, 0.1),
        borderWidth: 0.3,
      })
    }
  }
}
const debugPath = join(dir, `${stem}.debug.pdf`)
await writeFile(debugPath, await doc.save())
process.stdout.write(
  `${jsonPath}\n${debugPath}\npages=${analysis.pages} paragraphs=${analysis.stats.paragraphs} translatable=${analysis.stats.translatable} formulas=${analysis.stats.formulas}\n`,
)
