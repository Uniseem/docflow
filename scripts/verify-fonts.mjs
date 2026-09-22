import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const expected = {
  'NotoSansSC-Regular.otf': 'faa6c9df652116dde789d351359f3d7e5d2285a2b2a1f04a2d7244df706d5ea9',
  'NotoSansSC-Bold.otf': 'c6cb5a93abaa9edc8ee7463b7ebb7f42d618d40e6ed2f7a5371c97b0b64767c0',
}

const fontsDir = join(dirname(fileURLToPath(import.meta.url)), '../resources/fonts')

let failed = false
for (const [name, hash] of Object.entries(expected)) {
  const bytes = await readFile(join(fontsDir, name))
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== hash) {
    console.error(`${name} SHA-256 mismatch\n  expected ${hash}\n  actual   ${actual}`)
    failed = true
  }
}

if (failed) {
  process.exit(1)
}
