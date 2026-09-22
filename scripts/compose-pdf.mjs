import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyzePdf } from '../src/main/pdf/analyze.ts'
import { composePdf, defaultComposeOptions } from '../src/main/pdf/compose/index.ts'
import { inspectPdf } from '../src/main/pdf/inspect.ts'

const pdfPath = process.argv[2]
if (!pdfPath) {
  process.stderr.write('usage: tsx scripts/compose-pdf.mjs <pdf>\n')
  process.exit(1)
}

const inspection = await inspectPdf(pdfPath)
const analysis = await analyzePdf(pdfPath)
const translations = analysis.paragraphs.map((para) => ({
  id: para.id,
  text: para.translatable ? `译${para.text}` : para.text,
  kept: !para.translatable,
}))
const dir = await mkdtemp(join(tmpdir(), 'docflow-compose-'))
const monoPath = join(dir, 'mono.pdf')
const dualPath = join(dir, 'dual.pdf')
const fonts = {
  regular: join(process.cwd(), 'resources/fonts/NotoSansSC-Regular.otf'),
  bold: join(process.cwd(), 'resources/fonts/NotoSansSC-Bold.otf'),
}
const result = await composePdf({
  sourcePath: pdfPath,
  monoPath,
  dualPath,
  analysis,
  translations,
  fonts,
  options: defaultComposeOptions(),
})
const outDir = join(process.cwd(), 'tmp')
await mkdir(outDir, { recursive: true })
const report = join(outDir, 'compose-report.json')
await writeFile(
  report,
  `${JSON.stringify({ inspection: inspection.pages, analysis: analysis.stats, result, monoPath, dualPath }, null, 2)}\n`,
)
process.stdout.write(
  `${monoPath}\n${dualPath}\npages=${analysis.pages} written=${result.paragraphsWritten} kept=${result.paragraphsKept} removed=${result.opsRemoved} warnings=${result.warnings.length}\n`,
)
for (const warning of result.warnings) {
  process.stdout.write(`${warning.code} page=${warning.page ?? ''} ${warning.message}\n`)
}
process.stdout.write(`${report}\n`)
