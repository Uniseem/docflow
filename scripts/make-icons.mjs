import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import png2icons from 'png2icons'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const input = readFileSync(join(root, 'build/icon.png'))

const icns = png2icons.createICNS(input, png2icons.BILINEAR, 0)
if (!icns) {
  console.error('failed to create ICNS from build/icon.png')
  process.exit(1)
}
writeFileSync(join(root, 'build/icon.icns'), icns)

const ico = png2icons.createICO(input, png2icons.BILINEAR, 0, true)
if (!ico) {
  console.error('failed to create ICO from build/icon.png')
  process.exit(1)
}
writeFileSync(join(root, 'build/icon.ico'), ico)
