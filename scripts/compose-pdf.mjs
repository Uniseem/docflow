// Debug: the whole PDF pipeline with a fake translation (每段译为「译」+ 原文).
// usage: npm run compose -- <pdf>
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyzePdf } from '../src/main/pdf/analyze.ts'
import { composePdf } from '../src/main/pdf/compose/index.ts'
import { inspectPdf } from '../src/main/pdf/inspect.ts'
import { detectPage } from '../src/main/pdf/pdf2zh/detect.ts'
import { segmentsOf } from '../src/main/pdf/pdf2zh/segments.ts'
import { bundledFonts, bundledModel } from '../src/main/pipeline/run.ts'

const pdfPath = process.argv[2]
if (!pdfPath) {
  process.stderr.write('usage: npm run compose -- <pdf>\n')
  process.exit(1)
}

const inspection = await inspectPdf(pdfPath)
const layouts = []
for (let i = 0; i < inspection.pages; i += 1)
  layouts.push(await detectPage(pdfPath, i, bundledModel()))
const analysis = await analyzePdf(pdfPath, layouts)
const translations = segmentsOf(analysis).map((segment) => ({
  id: segment.id,
  text: `译${segment.text}`,
  kept: false,
}))
const dir = await mkdtemp(join(tmpdir(), 'docflow-compose-'))
const monoPath = join(dir, 'mono.pdf')
const dualPath = join(dir, 'dual.pdf')
const result = await composePdf({
  sourcePath: pdfPath,
  monoPath,
  dualPath,
  analysis,
  translations,
  fonts: bundledFonts(),
})
const outDir = join(process.cwd(), 'tmp')
await mkdir(outDir, { recursive: true })
const report = join(outDir, 'compose-report.json')
await writeFile(
  report,
  `${JSON.stringify({ pages: inspection.pages, analysis: analysis.stats, result, monoPath, dualPath }, null, 2)}\n`,
)
process.stdout.write(
  `${monoPath}\n${dualPath}\npages=${analysis.pages} written=${result.paragraphsWritten} kept=${result.paragraphsKept} removed=${result.opsRemoved} warnings=${result.warnings.length}\n`,
)
for (const warning of result.warnings) {
  process.stdout.write(`${warning.code} page=${warning.page ?? ''} ${warning.message}\n`)
}
process.stdout.write(`${report}\n`)
