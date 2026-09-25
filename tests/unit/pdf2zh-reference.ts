// Reference results of PDFMathTranslate 1.9.11 on tests/fixtures (tests/fixtures/pdf2zh/*.json):
// the DocLayout-YOLO boxes it detected and the paragraph strings (sstk) receive_layout built.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PageLayout } from '../../src/shared/pdf-types'

export type ReferenceUnit = {
  kind: 'page' | 'figure'
  name: string | null
  sstk: string[]
  formulas: number
}

export type Reference = {
  pages: Array<{ layout: PageLayout; units: ReferenceUnit[] }>
}

export const fixturesDir = join(process.cwd(), 'tests/fixtures')

export function fixture(name: string): string {
  return join(fixturesDir, `${name}.pdf`)
}

export function reference(name: string): Reference {
  return JSON.parse(readFileSync(join(fixturesDir, 'pdf2zh', `${name}.json`), 'utf8')) as Reference
}

export function referenceLayouts(name: string): PageLayout[] {
  return reference(name).pages.map((page) => page.layout)
}

export const NOTO_FONT = join(process.cwd(), 'resources/fonts/SourceHanSerifCN-Regular.ttf')
/** The bundled fonts (npm run assets). */
export const FONTS_DIR = join(process.cwd(), 'resources/fonts')
export const LAYOUT_MODEL = join(
  process.cwd(),
  'resources/models/doclayout_yolo_docstructbench_imgsz1024.onnx',
)
