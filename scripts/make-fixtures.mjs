import { mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import fontkit from '@cantoo/fontkit'
import {
  PDFDocument,
  PDFName,
  PDFOperator,
  PDFOperatorNames,
  StandardFonts,
  TextRenderingMode,
  beginText,
  drawObject,
  endText,
  rgb,
  setFontAndSize,
  setLineHeight,
  setTextMatrix,
  setTextRenderingMode,
  setTextRise,
  setCharacterSpacing,
  setWordSpacing,
  setCharacterSqueeze,
  showText,
} from '@cantoo/pdf-lib'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'tests/fixtures')
const PAGE = [612, 792]
const MAX_BYTES = 200 * 1024

const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FAP5IDvfQyd/DAAAAAElFTkSuQmCC',
  'base64',
)

const P1 =
  'Transformer models have become the default architecture for large-scale language processing. Residual connections and layer normalization stabilize training at depth.'
const P2 =
  'Attention computes a weighted combination of values. Scaled dot-product attention remains the most common building block in encoder and decoder stacks.'
const P3 =
  'Positional encodings inject order information that self-attention cannot recover from the input tokens alone. Relative variants later improved length generalization.'
const P4 =
  'Empirical results on translation and language modeling established the recipe used by later large language models. The same block appears in vision and speech systems.'

function wrapLines(font, text, size, maxWidth) {
  const words = text.split(/\s+/)
  const lines = []
  let current = ''
  for (const word of words) {
    const next = current ? `${current} ${word}` : word
    if (font.widthOfTextAtSize(next, size) <= maxWidth || !current) {
      current = next
    } else {
      lines.push(current)
      current = word
    }
  }
  if (current) lines.push(current)
  return lines
}

function drawWrapped(page, font, text, x, y, size, maxWidth, lineHeight, color) {
  const lines = wrapLines(font, text, size, maxWidth)
  lines.forEach((line, i) => {
    page.drawText(line, { x, y: y - i * lineHeight, size, font, color })
  })
  return lines.length * lineHeight
}

async function save(name, bytes) {
  const path = join(outDir, name)
  await writeFile(path, bytes)
  const info = await stat(path)
  if (info.size >= MAX_BYTES) {
    throw new Error(`${name} is ${info.size} bytes (>= 200 KB)`)
  }
  process.stdout.write(`${name}\t${info.size}\n`)
}

async function singleColumn() {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.TimesRoman)
  const paragraphs = [P1, P2, P3, P4]
  for (let pageNo = 1; pageNo <= 3; pageNo += 1) {
    const page = doc.addPage(PAGE)
    page.drawText(`Header · page ${pageNo}`, {
      x: 72,
      y: 760,
      size: 9,
      font,
      color: rgb(0.4, 0.4, 0.4),
    })
    let y = 720
    paragraphs.forEach((text, i) => {
      const used = drawWrapped(
        page,
        font,
        `${text} Paragraph ${pageNo}.${i + 1} continues with a second sentence about attention.`,
        72,
        y,
        10,
        468,
        14,
      )
      y -= used + 18
    })
    page.drawText(String(pageNo), { x: 300, y: 36, size: 9, font })
  }
  await save('single-column.pdf', await doc.save())
}

async function twoColumn() {
  const doc = await PDFDocument.create()
  const roman = await doc.embedFont(StandardFonts.TimesRoman)
  const bold = await doc.embedFont(StandardFonts.TimesRomanBold)
  const colW = 220
  const leftX = 72
  const rightX = 320

  function bodyLines(seed) {
    return wrapLines(roman, `${P1} ${P2} Seed ${seed}.`, 10, colW)
  }

  for (let pageNo = 0; pageNo < 4; pageNo += 1) {
    const page = doc.addPage(PAGE)
    if (pageNo === 0) {
      page.drawText('A Two-Column Paper Title', { x: 72, y: 740, size: 16, font: bold })
      drawWrapped(
        page,
        roman,
        'Abstract. This fixture uses a full-width abstract followed by two columns of body text for column detection and reading order.',
        72,
        712,
        10,
        468,
        13,
      )
    } else {
      page.drawText(`Continuation ${pageNo + 1}`, { x: 72, y: 760, size: 9, font: roman })
    }
    const startY = pageNo === 0 ? 620 : 720
    page.drawText(pageNo === 0 ? '1 Introduction' : `1.${pageNo} Setup`, {
      x: leftX,
      y: startY,
      size: 12,
      font: bold,
    })
    page.drawText(pageNo === 0 ? '2 Method' : `2.${pageNo} Analysis`, {
      x: rightX,
      y: startY,
      size: 12,
      font: bold,
    })
    bodyLines(pageNo * 2).forEach((line, i) => {
      page.drawText(line, { x: leftX, y: startY - 20 - i * 13, size: 10, font: roman })
    })
    bodyLines(pageNo * 2 + 1).forEach((line, i) => {
      page.drawText(line, { x: rightX, y: startY - 20 - i * 13, size: 10, font: roman })
    })
    if (pageNo === 3) {
      page.drawText('References', { x: leftX, y: 180, size: 12, font: bold })
      page.drawText('[1] Vaswani et al. Attention is All You Need.', {
        x: leftX,
        y: 160,
        size: 10,
        font: roman,
      })
    }
  }
  await save('two-column.pdf', await doc.save())
}

async function inlineFormula() {
  const doc = await PDFDocument.create()
  const roman = await doc.embedFont(StandardFonts.TimesRoman)
  const italic = await doc.embedFont(StandardFonts.TimesRomanItalic)
  const symbol = await doc.embedFont(StandardFonts.Symbol)
  const page = doc.addPage(PAGE)
  page.drawText('Let ', { x: 72, y: 700, size: 11, font: roman })
  page.drawText('x', { x: 94, y: 700, size: 11, font: italic })
  page.drawText(' ', { x: 102, y: 700, size: 11, font: roman })
  page.drawText('\u00A3', { x: 108, y: 700, size: 11, font: symbol })
  page.drawText(' 1 and Greek ', { x: 122, y: 700, size: 11, font: roman })
  page.drawText('a', { x: 210, y: 700, size: 11, font: symbol })
  page.drawText(' with a subscripted index.', { x: 222, y: 700, size: 11, font: roman })
  page.drawText('Then ', { x: 72, y: 660, size: 11, font: roman })
  page.drawText('x', { x: 102, y: 660, size: 11, font: italic })
  page.drawText('i', { x: 108, y: 666, size: 7, font: italic })
  page.drawText(' is a coordinate.', { x: 114, y: 660, size: 11, font: roman })
  await save('inline-formula.pdf', await doc.save())
}

async function displayMath() {
  const doc = await PDFDocument.create()
  const roman = await doc.embedFont(StandardFonts.TimesRoman)
  const italic = await doc.embedFont(StandardFonts.TimesRomanItalic)
  const page = doc.addPage(PAGE)
  page.drawText('The loss is defined as follows.', { x: 72, y: 720, size: 11, font: roman })
  page.drawText('E = mc', { x: 220, y: 640, size: 14, font: italic })
  page.drawText('2', { x: 268, y: 648, size: 10, font: italic })
  page.drawText('(3)', { x: 500, y: 640, size: 11, font: roman })
  page.drawText('We then optimize this objective.', { x: 72, y: 560, size: 11, font: roman })
  await save('display-math.pdf', await doc.save())
}

async function figureCaption() {
  const doc = await PDFDocument.create()
  const roman = await doc.embedFont(StandardFonts.TimesRoman)
  const image = await doc.embedPng(PIXEL_PNG)
  const page = doc.addPage(PAGE)
  page.drawImage(image, { x: 200, y: 500, width: 200, height: 160 })
  page.drawText('OCR inside figure', { x: 240, y: 560, size: 10, font: roman })
  page.drawText('Figure 1: A tiny diagram of the pipeline.', {
    x: 180,
    y: 480,
    size: 10,
    font: roman,
  })
  await save('figure-caption.pdf', await doc.save())
}

async function hyphenation() {
  const doc = await PDFDocument.create()
  const roman = await doc.embedFont(StandardFonts.TimesRoman)
  const page = doc.addPage(PAGE)
  page.drawText('The transfor-', { x: 400, y: 700, size: 11, font: roman })
  page.drawText('mation uses the ﬁ ligature in later lines.', {
    x: 72,
    y: 684,
    size: 11,
    font: roman,
  })
  await save('hyphenation.pdf', await doc.save())
}

async function longDoc() {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.TimesRoman)
  for (let i = 1; i <= 60; i += 1) {
    const page = doc.addPage(PAGE)
    page.drawText(`Page ${i}.`, { x: 72, y: 760, size: 9, font, color: rgb(0.4, 0.4, 0.4) })
    drawWrapped(
      page,
      font,
      `${P1} ${P2} This is page ${i} of the long fixture.`,
      72,
      720,
      10,
      468,
      13,
    )
    page.drawText(String(i), { x: 300, y: 36, size: 9, font })
  }
  await save('long.pdf', await doc.save())
}

async function encrypted() {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.TimesRoman)
  const page = doc.addPage(PAGE)
  page.drawText('This file is encrypted.', { x: 72, y: 720, size: 12, font })
  doc.encrypt({ userPassword: 'secret', ownerPassword: 'owner' })
  await save('encrypted.pdf', await doc.save())
}

async function scanned() {
  const doc = await PDFDocument.create()
  const image = await doc.embedPng(PIXEL_PNG)
  const page = doc.addPage(PAGE)
  page.drawImage(image, { x: 0, y: 0, width: 612, height: 792 })
  await save('scanned.pdf', await doc.save())
}

async function empty() {
  const objs = [
    '1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n',
    '2 0 obj<< /Type /Pages /Count 0 /Kids [] >>endobj\n',
  ]
  let body = '%PDF-1.4\n'
  const offsets = [0]
  for (const obj of objs) {
    offsets.push(Buffer.byteLength(body, 'latin1'))
    body += obj
  }
  const startxref = Buffer.byteLength(body, 'latin1')
  let xref = `xref\n0 3\n0000000000 65535 f \n`
  xref += `${String(offsets[1]).padStart(10, '0')} 00000 n \n`
  xref += `${String(offsets[2]).padStart(10, '0')} 00000 n \n`
  body += `${xref}trailer<< /Size 3 /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`
  await save('empty.pdf', Buffer.from(body, 'latin1'))
}

async function coloredText() {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.TimesRoman)
  const page = doc.addPage(PAGE)
  page.drawText('Red heading', { x: 72, y: 720, size: 16, font, color: rgb(0.8, 0.1, 0.1) })
  page.drawText('Blue body paragraph about methods.', {
    x: 72,
    y: 680,
    size: 11,
    font,
    color: rgb(0.1, 0.2, 0.7),
  })
  await save('colored-text.pdf', await doc.save())
}

async function tjArrays() {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.TimesRoman)
  const page = doc.addPage(PAGE)
  page.node.setFontDictionary(PDFName.of('F1'), font.ref)
  const tj = doc.context.obj([font.encodeText('Kerning'), -180, font.encodeText(' via TJ arrays.')])
  page.pushOperators(
    beginText(),
    setFontAndSize('F1', 11),
    setTextMatrix(1, 0, 0, 1, 72, 720),
    setCharacterSpacing(0.2),
    setWordSpacing(1.5),
    setCharacterSqueeze(98),
    setTextRise(0),
    PDFOperator.of(PDFOperatorNames.ShowTextAdjusted, [tj]),
    setLineHeight(16),
    PDFOperator.of(PDFOperatorNames.ShowTextLine, [font.encodeText('Apostrophe operator line.')]),
    PDFOperator.of(PDFOperatorNames.ShowTextLineAndSpace, [
      doc.context.obj(8),
      doc.context.obj(2),
      font.encodeText('Quote operator line.'),
    ]),
    endText(),
  )
  await save('tj-arrays.pdf', await doc.save())
}

async function cidFont() {
  const doc = await PDFDocument.create()
  doc.registerFontkit(fontkit)
  const bytes = await readFile(join(root, 'resources/fonts/SourceHanSerifCN-Regular.ttf'))
  const font = await doc.embedFont(bytes, { subset: true })
  const italic = await doc.embedFont(StandardFonts.TimesRomanItalic)
  const page = doc.addPage(PAGE)
  page.drawText('CID subset 中文段落与公式', { x: 72, y: 720, size: 12, font })
  page.drawText('x', { x: 72, y: 690, size: 12, font: italic })
  page.drawText(' 是变量。', { x: 82, y: 690, size: 12, font })
  page.drawText('Embedded CIDFont glyphs must remain selectable after rewrite.', {
    x: 72,
    y: 660,
    size: 12,
    font,
  })
  await save('cid-font.pdf', await doc.save())
}

function formOperators(font, text, x, y, size) {
  return [
    beginText(),
    setFontAndSize('F1', size),
    setTextMatrix(1, 0, 0, 1, x, y),
    showText(font.encodeText(text)),
    endText(),
  ]
}

async function formWrapped() {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.TimesRoman)
  const page = doc.addPage(PAGE)
  const form = doc.context.formXObject(
    formOperators(font, 'Text inside a form XObject.', 72, 720, 12),
    {
      BBox: [0, 0, 612, 792],
      Matrix: [1, 0, 0, 1, 0, 0],
      Resources: { Font: { F1: font.ref } },
    },
  )
  const formRef = doc.context.register(form)
  page.node.setXObject(PDFName.of('Fm1'), formRef)
  page.pushOperators(drawObject('Fm1'))
  await save('form-wrapped.pdf', await doc.save())
}

async function sharedForm() {
  const doc = await PDFDocument.create()
  const roman = await doc.embedFont(StandardFonts.TimesRoman)
  const logo = await doc.embedFont(StandardFonts.Helvetica)
  const form = doc.context.formXObject(formOperators(logo, 'LOGO', 8, 12, 14), {
    BBox: [0, 0, 120, 24],
    Matrix: [1, 0, 0, 1, 0, 0],
    Resources: { Font: { F1: logo.ref } },
  })
  const formRef = doc.context.register(form)
  for (let i = 0; i < 2; i += 1) {
    const page = doc.addPage(PAGE)
    page.node.setXObject(PDFName.of('Logo'), formRef)
    page.pushOperators(
      PDFOperator.of(PDFOperatorNames.PushGraphicsState),
      PDFOperator.of(PDFOperatorNames.ConcatTransformationMatrix, [
        doc.context.obj(1),
        doc.context.obj(0),
        doc.context.obj(0),
        doc.context.obj(1),
        doc.context.obj(72),
        doc.context.obj(750),
      ]),
      drawObject('Logo'),
      PDFOperator.of(PDFOperatorNames.PopGraphicsState),
    )
    page.drawText(`Body of page ${i + 1}. ${P1}`, {
      x: 72,
      y: 700,
      size: 11,
      font: roman,
      maxWidth: 468,
      lineHeight: 14,
    })
  }
  await save('shared-form.pdf', await doc.save())
}

async function italicSentence() {
  const doc = await PDFDocument.create()
  const italic = await doc.embedFont(StandardFonts.TimesRomanItalic)
  const roman = await doc.embedFont(StandardFonts.TimesRoman)
  const page = doc.addPage(PAGE)
  page.drawText('This entire sentence is italic and should be treated as prose.', {
    x: 72,
    y: 720,
    size: 11,
    font: italic,
    maxWidth: 468,
  })
  page.drawText('A single variable ', { x: 72, y: 680, size: 11, font: roman })
  page.drawText('x', { x: 168, y: 680, size: 11, font: italic })
  page.drawText(' remains.', { x: 178, y: 680, size: 11, font: roman })
  await save('italic-sentence.pdf', await doc.save())
}

async function invisibleText() {
  const doc = await PDFDocument.create()
  const image = await doc.embedPng(PIXEL_PNG)
  const font = await doc.embedFont(StandardFonts.TimesRoman)
  const page = doc.addPage(PAGE)
  page.drawImage(image, { x: 0, y: 0, width: 612, height: 792 })
  page.pushOperators(setTextRenderingMode(TextRenderingMode.Invisible))
  page.drawText('Hidden OCR layer that must not count as visible text.', {
    x: 72,
    y: 720,
    size: 11,
    font,
  })
  await save('invisible-text.pdf', await doc.save())
}

/** Three single-column pages; `draw(page, text, y)` draws a paragraph and returns its height. */
function textPages(doc, draw) {
  for (let pageNo = 1; pageNo <= 3; pageNo += 1) {
    const page = doc.addPage(PAGE)
    let y = 720
    ;[P1, P2, P3].forEach((text, i) => {
      y -= draw(page, `${text} Paragraph ${pageNo}.${i + 1} of the scanned report.`, y) + 18
    })
  }
}

/** An OCR'd scan: each page is a grey 72 dpi picture of text plus an invisible text layer. */
async function ocrScan() {
  const mupdf = await import('mupdf')
  const clean = await PDFDocument.create()
  const cleanFont = await clean.embedFont(StandardFonts.TimesRoman)
  textPages(clean, (page, text, y) => drawWrapped(page, cleanFont, text, 72, y, 11, 468, 15))
  const rendered = mupdf.Document.openDocument(await clean.save(), 'application/pdf')
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.TimesRoman)
  const images = []
  for (let i = 0; i < rendered.countPages(); i += 1) {
    const pix = rendered
      .loadPage(i)
      .toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, false, true)
    images.push(await doc.embedPng(pix.asPNG()))
  }
  let index = 0
  textPages(doc, (page, text, y) => {
    if (y === 720) {
      page.drawImage(images[index], { x: 0, y: 0, width: 612, height: 792 })
      index += 1
      page.pushOperators(setTextRenderingMode(TextRenderingMode.Invisible))
    }
    return drawWrapped(page, font, text, 72, y, 11, 468, 15)
  })
  await save('ocr-scan.pdf', await doc.save())
}

const GENERATORS = {
  'single-column.pdf': singleColumn,
  'two-column.pdf': twoColumn,
  'inline-formula.pdf': inlineFormula,
  'display-math.pdf': displayMath,
  'figure-caption.pdf': figureCaption,
  'hyphenation.pdf': hyphenation,
  'long.pdf': longDoc,
  'encrypted.pdf': encrypted,
  'scanned.pdf': scanned,
  'empty.pdf': empty,
  'colored-text.pdf': coloredText,
  'tj-arrays.pdf': tjArrays,
  'cid-font.pdf': cidFont,
  'form-wrapped.pdf': formWrapped,
  'shared-form.pdf': sharedForm,
  'italic-sentence.pdf': italicSentence,
  'invisible-text.pdf': invisibleText,
  'ocr-scan.pdf': ocrScan,
}

// `npm run fixtures -- ocr-scan.pdf` regenerates only the named files.
async function main(names) {
  await mkdir(outDir, { recursive: true })
  for (const name of names.length > 0 ? names : Object.keys(GENERATORS)) {
    const generate = GENERATORS[name]
    if (!generate) throw new Error(`unknown fixture ${name}`)
    await generate()
  }
}

await main(process.argv.slice(2))
