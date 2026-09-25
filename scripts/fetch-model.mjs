// Downloads the DocLayout-YOLO model pdf2zh uses into resources/models/ (packaged with the app;
// not committed: 75 MB). Skips the download when the file is already there with the right hash.
// Mirrors in the order BabelDOC tries them; set DOCFLOW_MODEL_URL to use another source.
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const FILE = 'doclayout_yolo_docstructbench_imgsz1024.onnx'
const SHA3_256 = '60be061226930524958b5465c8c04af3d7c03bcb0beb66454f5da9f792e3cf2a'
const SOURCES = [
  `https://huggingface.co/wybxc/DocLayout-YOLO-DocStructBench-onnx/resolve/main/${FILE}?download=true`,
  `https://hf-mirror.com/wybxc/DocLayout-YOLO-DocStructBench-onnx/resolve/main/${FILE}?download=true`,
  `https://www.modelscope.cn/models/AI-ModelScope/DocLayout-YOLO-DocStructBench-onnx/resolve/master/${FILE}`,
]

const target = join(dirname(fileURLToPath(import.meta.url)), '../resources/models', FILE)

function sha3(bytes) {
  return createHash('sha3-256').update(bytes).digest('hex')
}

async function existingOk() {
  try {
    return sha3(await readFile(target)) === SHA3_256
  } catch {
    return false
  }
}

if (await existingOk()) {
  process.stdout.write(`${FILE}: ok\n`)
  process.exit(0)
}

await mkdir(dirname(target), { recursive: true })
const sources = process.env.DOCFLOW_MODEL_URL ? [process.env.DOCFLOW_MODEL_URL] : SOURCES
for (const url of sources) {
  try {
    process.stdout.write(`${FILE}: downloading ${new URL(url).host}\n`)
    const response = await fetch(url, { signal: AbortSignal.timeout(600_000) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (sha3(bytes) !== SHA3_256) throw new Error('SHA3-256 mismatch')
    const partial = `${target}.partial`
    await writeFile(partial, bytes)
    await rename(partial, target)
    process.stdout.write(`${FILE}: ok (${bytes.length} bytes)\n`)
    process.exit(0)
  } catch (error) {
    console.warn(`${FILE}: ${error instanceof Error ? error.message : String(error)}`)
    await rm(`${target}.partial`, { force: true })
  }
}
console.error(`${FILE}: every source failed`)
process.exit(1)
