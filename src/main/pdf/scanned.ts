// BabelDOC 0.6.4 midend/detect_scanned_file.py (DetectScannedFile): a page counts as scanned
// when taking its text away barely changes how it looks (the SSIM of the two 72 dpi renders is
// above 0.95), which is what an OCR'd scan with an invisible text layer does. The document is
// scanned when at least 80% of the pages to translate are.
//
// One condition is ours (ADR-0018): images must cover at least half of the page. A page with a
// few lines of ordinary text also stays above 0.95 without them (one paragraph on a Letter page
// scores 0.964), which is the "Scanned PDF detected" pdf2zh-next reports for sparse documents.
import { readFile } from 'node:fs/promises'
import type { ScanResult } from '../../shared/pdf-types'
import { loadPdfLib } from './load-pdf-lib'
import { loadMupdf } from './pdf2zh/font-flags'
import { interpretPage } from './pdf2zh/interp'
import { pageSource } from './pdf2zh/pages'

type MuPDF = Awaited<ReturnType<typeof loadMupdf>>
type MuPage = ReturnType<InstanceType<MuPDF['PDFDocument']>['loadPage']>

/** raster_geometry.DEFAULT_MAX_PIXELS */
const MAX_PIXELS = 12_000_000
const SIMILAR = 0.95
const MIN_IMAGE_COVERAGE = 0.5
/** Cells per side of the grid image coverage is measured on. */
const COVERAGE_GRID = 64

export type PageCheck = {
  /** Share of the page covered by images, 0 to 1. */
  coverage: number
  /** SSIM without the text; null when not measured (too little image) or not measurable. */
  similarity: number | null
}

export async function detectScanned(
  path: string,
  pages: readonly number[] | null,
  onPage?: (index: number, check: PageCheck) => void,
): Promise<ScanResult> {
  const bytes = await readFile(path)
  const mupdf = await loadMupdf()
  const doc = new mupdf.PDFDocument(bytes)
  const lib = await loadPdfLib(bytes)
  const libPages = lib.getPages()
  const list = pages ? [...pages] : libPages.map((_, i) => i)
  const total = list.length
  const threshold = Math.max(0.8 * total, 1)
  const nonScannedThreshold = total - threshold
  let scanned = 0
  let nonScanned = 0
  let checked = 0
  try {
    for (const index of list) {
      // Only continue detection while neither count settles the answer.
      if (scanned < threshold && nonScanned < nonScannedThreshold) {
        checked += 1
        const check = checkPage(mupdf, doc, lib, libPages, index)
        onPage?.(index, check)
        if (check.similarity !== null && check.similarity > SIMILAR) scanned += 1
        else nonScanned += 1
      } else {
        nonScanned += 1
      }
    }
  } finally {
    doc.destroy()
  }
  return { scanned: scanned >= threshold, scannedPages: scanned, checkedPages: checked, total }
}

/**
 * detect_page_is_scanned's SSIM, measured only on a page mostly covered by images. A page that
 * cannot be rendered or rewritten is not scanned.
 */
function checkPage(
  mupdf: MuPDF,
  doc: InstanceType<MuPDF['PDFDocument']>,
  lib: Awaited<ReturnType<typeof loadPdfLib>>,
  libPages: ReturnType<Awaited<ReturnType<typeof loadPdfLib>>['getPages']>,
  index: number,
): PageCheck {
  const libPage = libPages[index]
  if (!libPage) return { coverage: 0, similarity: null }
  let coverage = 0
  try {
    coverage = imageCoverage(doc, index)
    if (coverage < MIN_IMAGE_COVERAGE) return { coverage, similarity: null }
    const before = withPixelBudget(mupdf, doc, index)
    // update_page_content_stream(skip_char=True): the page and the forms it draws keep
    // everything but their text, the `q {ops_base}Q` compose writes before the translation.
    const source = pageSource(lib, libPage)
    const interp = interpretPage(
      source.content,
      source.ctm,
      source.width,
      source.getForm,
      source.resources,
    )
    for (const unit of interp.units) {
      const content = concat('q ', unit.opsBase, 'Q')
      if (!unit.formPath) {
        doc.findPage(index).put('Contents', doc.addStream(content, {}))
        continue
      }
      const record = unit.handle ? source.forms.get(unit.handle) : undefined
      if (!record) continue
      const form = doc.newIndirect(record.ref.objectNumber)
      if (form.resolve().isStream()) form.writeStream(content)
    }
    const after = render(mupdf, doc, index, before.dpi)
    return { coverage, similarity: ssim(before.gray, after.gray, before.width, before.height) }
  } catch {
    return { coverage, similarity: null }
  }
}

/** Share of the page's grid cells whose centre lies in an image the page draws. */
function imageCoverage(doc: InstanceType<MuPDF['PDFDocument']>, index: number): number {
  const page: MuPage = doc.loadPage(index)
  try {
    const [x0, y0, x1, y1] = page.getBounds()
    const boxes: number[][] = []
    const text = page.toStructuredText('preserve-images')
    try {
      text.walk({ onImageBlock: (bbox) => void boxes.push([...bbox]) })
    } finally {
      text.destroy()
    }
    if (boxes.length === 0) return 0
    const cw = (x1 - x0) / COVERAGE_GRID
    const ch = (y1 - y0) / COVERAGE_GRID
    let covered = 0
    for (let row = 0; row < COVERAGE_GRID; row += 1) {
      const y = y0 + (row + 0.5) * ch
      for (let col = 0; col < COVERAGE_GRID; col += 1) {
        const x = x0 + (col + 0.5) * cw
        if (
          boxes.some(([bx0, by0, bx1, by1]) => x >= bx0! && x <= bx1! && y >= by0! && y <= by1!)
        ) {
          covered += 1
        }
      }
    }
    return covered / COVERAGE_GRID ** 2
  } finally {
    page.destroy()
  }
}

type GrayImage = { gray: Uint8Array; width: number; height: number; dpi: number }

/** raster_geometry.with_pixel_budget(page, 72, normalize_rotation=False) */
function withPixelBudget(
  mupdf: MuPDF,
  doc: InstanceType<MuPDF['PDFDocument']>,
  index: number,
): GrayImage {
  const page = doc.loadPage(index)
  let width: number
  let height: number
  try {
    const [x0, y0, x1, y1] = page.getBounds()
    width = x1 - x0
    height = y1 - y0
  } finally {
    page.destroy()
  }
  const initial = Math.floor(Math.sqrt((MAX_PIXELS * 72 ** 2) / (width * height)))
  let dpi = Math.max(1, Math.min(72, initial))
  for (;;) {
    const image = render(mupdf, doc, index, dpi)
    if (image.width * image.height <= MAX_PIXELS || dpi === 1) return image
    dpi -= 1
  }
}

/**
 * page.get_pixmap(dpi=dpi) (RGB, annotations drawn), flipped to BGR by `[:, :, ::-1]` and then
 * converted with cv2.COLOR_RGB2GRAY: OpenCV's fixed-point weights land on swapped channels.
 */
function render(
  mupdf: MuPDF,
  doc: InstanceType<MuPDF['PDFDocument']>,
  index: number,
  dpi: number,
): GrayImage {
  const page: MuPage = doc.loadPage(index)
  try {
    const zoom = dpi / 72
    const pix = page.toPixmap(
      mupdf.Matrix.scale(zoom, zoom),
      mupdf.ColorSpace.DeviceRGB,
      false,
      true,
    )
    try {
      const width = pix.getWidth()
      const height = pix.getHeight()
      const stride = pix.getStride()
      const samples = pix.getPixels()
      const gray = new Uint8Array(width * height)
      for (let y = 0; y < height; y += 1) {
        let src = y * stride
        let dst = y * width
        for (let x = 0; x < width; x += 1) {
          const r = samples[src]!
          const g = samples[src + 1]!
          const b = samples[src + 2]!
          gray[dst] = (b * 4899 + g * 9617 + r * 1868 + 8192) >> 14
          src += 3
          dst += 1
        }
      }
      return { gray, width, height, dpi }
    } finally {
      pix.destroy()
    }
  } finally {
    page.destroy()
  }
}

/**
 * skimage.metrics.structural_similarity for two uint8 images with its defaults: a 7 × 7
 * uniform window, K1 0.01, K2 0.03, data range 255, sample covariance, and the mean over the
 * image without its 3-pixel border (where the window would leave the image).
 */
export function ssim(a: Uint8Array, b: Uint8Array, width: number, height: number): number {
  const win = 7
  const pad = (win - 1) / 2
  if (width < win || height < win) throw new Error('image smaller than the SSIM window')
  const np = win * win
  const covNorm = np / (np - 1)
  const c1 = (0.01 * 255) ** 2
  const c2 = (0.03 * 255) ** 2
  // Column sums over the current 7 rows, updated as the window moves down.
  const sx = new Float64Array(width)
  const sy = new Float64Array(width)
  const sxx = new Float64Array(width)
  const syy = new Float64Array(width)
  const sxy = new Float64Array(width)
  const addRow = (row: number, sign: number) => {
    const base = row * width
    for (let x = 0; x < width; x += 1) {
      const va = a[base + x]!
      const vb = b[base + x]!
      sx[x]! += sign * va
      sy[x]! += sign * vb
      sxx[x]! += sign * va * va
      syy[x]! += sign * vb * vb
      sxy[x]! += sign * va * vb
    }
  }
  for (let row = 0; row < win - 1; row += 1) addRow(row, 1)
  let total = 0
  for (let y = pad; y < height - pad; y += 1) {
    addRow(y + pad, 1)
    let wx = 0
    let wy = 0
    let wxx = 0
    let wyy = 0
    let wxy = 0
    for (let x = 0; x < win - 1; x += 1) {
      wx += sx[x]!
      wy += sy[x]!
      wxx += sxx[x]!
      wyy += syy[x]!
      wxy += sxy[x]!
    }
    for (let x = pad; x < width - pad; x += 1) {
      const right = x + pad
      wx += sx[right]!
      wy += sy[right]!
      wxx += sxx[right]!
      wyy += syy[right]!
      wxy += sxy[right]!
      const ux = wx / np
      const uy = wy / np
      const vx = covNorm * (wxx / np - ux * ux)
      const vy = covNorm * (wyy / np - uy * uy)
      const vxy = covNorm * (wxy / np - ux * uy)
      const numerator = (2 * ux * uy + c1) * (2 * vxy + c2)
      const denominator = (ux * ux + uy * uy + c1) * (vx + vy + c2)
      total += numerator / denominator
      const left = x - pad
      wx -= sx[left]!
      wy -= sy[left]!
      wxx -= sxx[left]!
      wyy -= syy[left]!
      wxy -= sxy[left]!
    }
    addRow(y - pad, -1)
  }
  return total / ((width - 2 * pad) * (height - 2 * pad))
}

function concat(...parts: Array<string | Uint8Array>): Uint8Array {
  const chunks = parts.map((part) =>
    typeof part === 'string' ? Buffer.from(part, 'latin1') : part,
  )
  const out = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}
