import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const expected = {
  'SourceHanSerifCN-Regular.ttf':
    '8ba5ec09db04b1d1599edeff3fb5627ca11eaaf85e339e5c32684cb94e806993',
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
