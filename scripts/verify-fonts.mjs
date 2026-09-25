// Checks the fonts the app embeds (src/main/pdf/babeldoc/fonts.json) against BabelDOC's
// SHA3-256. SourceHanSerifCN-Regular.ttf is committed; the others come from `npm run assets`.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fonts = JSON.parse(await readFile(join(root, 'src/main/pdf/babeldoc/fonts.json'), 'utf8'))

let failed = false
for (const font of fonts) {
  let bytes
  try {
    bytes = await readFile(join(root, 'resources/fonts', font.file))
  } catch {
    console.error(`${font.file} is missing: run npm run assets`)
    failed = true
    continue
  }
  const actual = createHash('sha3-256').update(bytes).digest('hex')
  if (actual !== font.sha3_256) {
    console.error(
      `${font.file} SHA3-256 mismatch\n  expected ${font.sha3_256}\n  actual   ${actual}`,
    )
    failed = true
  }
}

if (failed) {
  process.exit(1)
}
