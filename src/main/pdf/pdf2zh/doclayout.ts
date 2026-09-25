// Port of PDFMathTranslate 1.9.11 `pdf2zh/doclayout.py` OnnxModel (pre/post-processing of
// DocLayout-YOLO-DocStructBench) and the layout matrix built in `high_level.py`
// translate_patch. Inference itself runs elsewhere; these are pure functions.
import type { LayoutBox, PageLayout } from '../../../shared/pdf-types'

export const DOCLAYOUT_MODEL_FILE = 'doclayout_yolo_docstructbench_imgsz1024.onnx'

// ONNX metadata "names" and "stride" of doclayout_yolo_docstructbench_imgsz1024.onnx.
export const DOCLAYOUT_NAMES: Readonly<Record<number, string>> = {
  0: 'title',
  1: 'plain text',
  2: 'abandon',
  3: 'figure',
  4: 'figure_caption',
  5: 'table',
  6: 'table_caption',
  7: 'table_footnote',
  8: 'isolate_formula',
  9: 'formula_caption',
}
export const DOCLAYOUT_STRIDE = 32
export const CONF_THRESHOLD = 0.25
// vcls: characters inside these boxes are kept as they are (layout class 0).
export const PRESERVED_CLASSES = [
  'abandon',
  'figure',
  'table',
  'isolate_formula',
  'formula_caption',
]

/** Python round(): halves go to the even neighbour. */
export function pyRound(value: number): number {
  const floor = Math.floor(value)
  const diff = value - floor
  if (diff > 0.5) return floor + 1
  if (diff < 0.5) return floor
  return floor % 2 === 0 ? floor : floor + 1
}

/** translate_patch: `imgsz=int(pix.height / 32) * 32` */
export function imageSize(pixHeight: number): number {
  return Math.trunc(pixHeight / 32) * 32
}

export type ModelInput = {
  /** NCHW float32 in [0, 1]; channel order B, G, R (pdf2zh feeds the BGR array). */
  data: Float32Array
  width: number
  height: number
}

/**
 * resize_and_pad_image + the tensor conversion in predict(). `rgb` is the pixmap (RGB, row
 * major); pdf2zh reverses it to BGR before resizing.
 */
export function prepareInput(
  rgb: Uint8Array,
  width: number,
  height: number,
  imgsz: number,
  stride = DOCLAYOUT_STRIDE,
): ModelInput {
  const newH = imgsz
  const newW = imgsz
  const r = Math.min(newH / height, newW / width)
  const resizedH = Math.trunc(pyRound(height * r))
  const resizedW = Math.trunc(pyRound(width * r))
  const resized = resizeLinear(rgb, width, height, resizedW, resizedH)
  const padW = (((newW - resizedW) % stride) + stride) % stride
  const padH = (((newH - resizedH) % stride) + stride) % stride
  const top = Math.floor(padH / 2)
  const left = Math.floor(padW / 2)
  const outW = resizedW + padW
  const outH = resizedH + padH
  const plane = outW * outH
  const data = new Float32Array(3 * plane).fill(114 / 255)
  for (let y = 0; y < resizedH; y += 1) {
    for (let x = 0; x < resizedW; x += 1) {
      const src = (y * resizedW + x) * 3
      const dst = (y + top) * outW + (x + left)
      data[dst] = (resized[src + 2] ?? 0) / 255 // B
      data[plane + dst] = (resized[src + 1] ?? 0) / 255 // G
      data[2 * plane + dst] = (resized[src] ?? 0) / 255 // R
    }
  }
  return { data, width: outW, height: outH }
}

// cv2.resize(INTER_LINEAR) for 8-bit images: half-pixel centres and 11-bit fixed-point weights.
const COEF_BITS = 11
const COEF_SCALE = 1 << COEF_BITS

function axisWeights(src: number, dst: number): { index: Int32Array; weight: Int32Array } {
  const scale = src / dst
  const index = new Int32Array(dst)
  const weight = new Int32Array(dst)
  for (let d = 0; d < dst; d += 1) {
    let fx = (d + 0.5) * scale - 0.5
    let sx = Math.floor(fx)
    fx -= sx
    if (sx < 0) {
      fx = 0
      sx = 0
    }
    if (sx >= src - 1) {
      fx = 0
      sx = src - 1
    }
    index[d] = sx
    weight[d] = Math.round((1 - fx) * COEF_SCALE)
  }
  return { index, weight }
}

export function resizeLinear(
  rgb: Uint8Array,
  width: number,
  height: number,
  outW: number,
  outH: number,
): Uint8Array {
  const xs = axisWeights(width, outW)
  const ys = axisWeights(height, outH)
  const rows = new Int32Array(outW * 3 * height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < outW; x += 1) {
      const sx = xs.index[x]!
      const w0 = xs.weight[x]!
      const w1 = COEF_SCALE - w0
      const sx1 = Math.min(sx + 1, width - 1)
      for (let c = 0; c < 3; c += 1) {
        const a = rgb[(y * width + sx) * 3 + c] ?? 0
        const b = rgb[(y * width + sx1) * 3 + c] ?? 0
        rows[(y * outW + x) * 3 + c] = a * w0 + b * w1
      }
    }
  }
  const out = new Uint8Array(outW * outH * 3)
  const shift = COEF_BITS * 2
  const half = 1 << (shift - 1)
  for (let y = 0; y < outH; y += 1) {
    const sy = ys.index[y]!
    const w0 = ys.weight[y]!
    const w1 = COEF_SCALE - w0
    const sy1 = Math.min(sy + 1, height - 1)
    for (let i = 0; i < outW * 3; i += 1) {
      const v = (rows[sy * outW * 3 + i]! * w0 + rows[sy1 * outW * 3 + i]! * w1 + half) >> shift
      out[y * outW * 3 + i] = Math.min(255, Math.max(0, v))
    }
  }
  return out
}

/**
 * predict() post-processing: keep conf > 0.25, undo the padding and scaling (scale_boxes),
 * then YoloResult's sort by confidence (stable, highest first).
 * @param output rows of [x1, y1, x2, y2, conf, cls] (model output0 with shape [1, N, 6]).
 */
export function postprocess(
  output: Float32Array,
  rows: number,
  input: { width: number; height: number },
  orig: { width: number; height: number },
  names: Readonly<Record<number, string>> = DOCLAYOUT_NAMES,
): LayoutBox[] {
  const gain = Math.min(input.height / orig.height, input.width / orig.width)
  const padX = pyRound((input.width - orig.width * gain) / 2 - 0.1)
  const padY = pyRound((input.height - orig.height * gain) / 2 - 0.1)
  const boxes: LayoutBox[] = []
  for (let i = 0; i < rows; i += 1) {
    const row = output.subarray(i * 6, i * 6 + 6)
    const conf = row[4] ?? 0
    if (!(conf > CONF_THRESHOLD)) continue
    // numpy promotes to float64 for the arithmetic and stores back into the float32 array.
    const scale = (v: number, pad: number) => Math.fround((v - pad) / gain)
    boxes.push({
      name: names[Math.trunc(row[5] ?? 0)] ?? String(row[5]),
      conf,
      xyxy: [
        scale(row[0] ?? 0, padX),
        scale(row[1] ?? 0, padY),
        scale(row[2] ?? 0, padX),
        scale(row[3] ?? 0, padY),
      ],
    })
  }
  // list.sort is stable: equal confidences keep model order.
  return boxes
    .map((box, i) => ({ box, i }))
    .sort((a, b) => b.box.conf - a.box.conf || a.i - b.i)
    .map((row) => row.box)
}

export type LayoutMap = {
  width: number
  height: number
  /** Row-major; row y counts from the bottom of the page like pdfminer coordinates. */
  cls: Int32Array
  /** The boxes behind the classes: class i + 2 is boxes[i]. */
  boxes?: readonly LayoutBox[]
}

/** high_level.translate_patch: `box = np.ones((h, w))`, text boxes i + 2, preserved boxes 0. */
export function buildLayoutMap(page: PageLayout): LayoutMap {
  const { width: w, height: h } = page
  const cls = new Int32Array(w * h).fill(1)
  const clip = (v: number, max: number) => Math.min(Math.max(v, 0), max)
  const fill = (box: LayoutBox, value: number) => {
    const [bx0, by0, bx1, by1] = box.xyxy
    const x0 = clip(Math.trunc(bx0 - 1), w - 1)
    const y0 = clip(Math.trunc(h - by1 - 1), h - 1)
    const x1 = clip(Math.trunc(bx1 + 1), w - 1)
    const y1 = clip(Math.trunc(h - by0 + 1), h - 1)
    for (let y = y0; y < y1; y += 1) cls.fill(value, y * w + x0, y * w + Math.max(x0, x1))
  }
  page.boxes.forEach((box, i) => {
    if (!PRESERVED_CLASSES.includes(box.name)) fill(box, i + 2)
  })
  page.boxes.forEach((box) => {
    if (PRESERVED_CLASSES.includes(box.name)) fill(box, 0)
  })
  return { width: w, height: h, cls, boxes: page.boxes }
}
