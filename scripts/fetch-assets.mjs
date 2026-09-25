// Downloads what the app ships but git does not hold (ADR-0016, ADR-0018): the DocLayout-YOLO
// model into resources/models/ and BabelDOC's fonts into resources/fonts/, each checked against
// its SHA3-256. Files already present with the right hash are skipped. Mirrors are tried in
// order; DOCFLOW_MODEL_URL (the model file's URL) and DOCFLOW_FONTS_URL (a base URL ending in /,
// followed by each font's file name) replace them.
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const MODEL = 'doclayout_yolo_docstructbench_imgsz1024.onnx'
const fonts = JSON.parse(await readFile(join(root, 'src/main/pdf/babeldoc/fonts.json'), 'utf8'))

const assets = [
  {
    file: MODEL,
    dir: 'resources/models',
    sha3: '60be061226930524958b5465c8c04af3d7c03bcb0beb66454f5da9f792e3cf2a',
    sources: process.env.DOCFLOW_MODEL_URL
      ? [process.env.DOCFLOW_MODEL_URL]
      : [
          `https://huggingface.co/wybxc/DocLayout-YOLO-DocStructBench-onnx/resolve/main/${MODEL}?download=true`,
          `https://hf-mirror.com/wybxc/DocLayout-YOLO-DocStructBench-onnx/resolve/main/${MODEL}?download=true`,
          `https://www.modelscope.cn/models/AI-ModelScope/DocLayout-YOLO-DocStructBench-onnx/resolve/master/${MODEL}`,
        ],
  },
  ...fonts.map((font) => ({
    file: font.file,
    dir: 'resources/fonts',
    sha3: font.sha3_256,
    // BabelDOC assets.FONT_URL_BY_UPSTREAM
    sources: process.env.DOCFLOW_FONTS_URL
      ? [`${process.env.DOCFLOW_FONTS_URL}${font.file}`]
      : [
          `https://raw.githubusercontent.com/funstory-ai/BabelDOC-Assets/refs/heads/main/fonts/${font.file}`,
          `https://huggingface.co/datasets/awwaawwa/BabelDOC-Assets/resolve/main/fonts/${font.file}?download=true`,
          `https://www.modelscope.cn/datasets/awwaawwa/BabelDOCAssets/resolve/master/fonts/${font.file}`,
        ],
  })),
]

function sha3(bytes) {
  return createHash('sha3-256').update(bytes).digest('hex')
}

async function present(target, hash) {
  try {
    return sha3(await readFile(target)) === hash
  } catch {
    return false
  }
}

async function fetchAsset(asset) {
  const target = join(root, asset.dir, asset.file)
  if (await present(target, asset.sha3)) return true
  await mkdir(dirname(target), { recursive: true })
  for (const url of asset.sources) {
    try {
      process.stdout.write(`${asset.file}: downloading ${new URL(url).host}\n`)
      const response = await fetch(url, { signal: AbortSignal.timeout(600_000) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (sha3(bytes) !== asset.sha3) throw new Error('SHA3-256 mismatch')
      const partial = `${target}.partial`
      await writeFile(partial, bytes)
      await rename(partial, target)
      process.stdout.write(`${asset.file}: ok (${bytes.length} bytes)\n`)
      return true
    } catch (error) {
      console.warn(`${asset.file}: ${error instanceof Error ? error.message : String(error)}`)
      await rm(`${target}.partial`, { force: true })
    }
  }
  console.error(`${asset.file}: every source failed`)
  return false
}

let failed = false
// A few at a time: the fonts are 0.5–25 MB each.
const queue = [...assets]
await Promise.all(
  Array.from({ length: 4 }, async () => {
    for (let asset = queue.shift(); asset; asset = queue.shift()) {
      if (!(await fetchAsset(asset))) failed = true
    }
  }),
)
if (failed) process.exit(1)
process.stdout.write(`assets: ${assets.length} files ok\n`)
