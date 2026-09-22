import { z } from 'zod'

export const Rect = z.tuple([z.number(), z.number(), z.number(), z.number()])
export type Rect = z.infer<typeof Rect>

export const Matrix = z.tuple([
  z.number(),
  z.number(),
  z.number(),
  z.number(),
  z.number(),
  z.number(),
])
export type Matrix = z.infer<typeof Matrix>

export const PdfInspection = z.object({
  pages: z.number().int().positive(),
  pageSizes: z.array(z.tuple([z.number(), z.number()])),
  rotations: z.array(z.number()),
  textChars: z.number(),
  visibleTextChars: z.number(),
  hasTextLayer: z.boolean(),
  title: z.string().optional(),
})
export type PdfInspection = z.infer<typeof PdfInspection>

export const Glyph = z.object({
  page: z.number().int(),
  opSeq: z.number().int(),
  formPath: z.string(),
  code: z.number().int(),
  unicode: z.string(),
  fontKey: z.string(),
  fontFamily: z.string(),
  composite: z.boolean(),
  codeBytes: z.number().int(),
  bold: z.boolean(),
  italic: z.boolean(),
  type3: z.boolean(),
  trm: Matrix,
  x: z.number(),
  y: z.number(),
  size: z.number(),
  adv: z.number(),
  width: z.number(),
  ascent: z.number(),
  descent: z.number(),
  rotated: z.boolean(),
  vertical: z.boolean(),
  renderMode: z.number().int(),
  color: z.tuple([z.number(), z.number(), z.number()]),
  isSpace: z.boolean(),
})
export type Glyph = z.infer<typeof Glyph>

export const FormulaRun = z.object({
  id: z.number().int(),
  glyphs: z.array(Glyph),
  bbox: Rect,
  baselineOffset: z.number(),
  width: z.number(),
  text: z.string(),
})
export type FormulaRun = z.infer<typeof FormulaRun>

export const Line = z.object({
  page: z.number().int(),
  bbox: Rect,
  baseline: z.number(),
  size: z.number(),
  glyphs: z.array(Glyph),
  runs: z.array(FormulaRun),
  text: z.string(),
  opSeqs: z.array(z.number()),
  column: z.number().int(),
  formulaLine: z.boolean(),
})
export type Line = z.infer<typeof Line>

export const Paragraph = z.object({
  id: z.string(),
  page: z.number().int(),
  bbox: Rect,
  lines: z.array(z.object({ bbox: Rect, baseline: z.number(), opSeqs: z.array(z.number()) })),
  size: z.number(),
  lineHeight: z.number(),
  bold: z.boolean(),
  align: z.enum(['left', 'justify', 'center', 'right']),
  color: z.tuple([z.number(), z.number(), z.number()]),
  role: z.enum(['body', 'heading', 'caption', 'listItem', 'footnote', 'headerFooter', 'other']),
  text: z.string(),
  runs: z.array(FormulaRun),
  formPath: z.string(),
  translatable: z.boolean(),
  skipReason: z.string().optional(),
})
export type Paragraph = z.infer<typeof Paragraph>

export const AnalysisResult = z.object({
  version: z.literal(2),
  pages: z.number().int(),
  pageSizes: z.array(z.tuple([z.number(), z.number()])),
  paragraphs: z.array(Paragraph),
  fontMap: z.record(
    z.string(),
    z.object({
      family: z.string(),
      composite: z.boolean(),
      codeBytes: z.number(),
      type3: z.boolean(),
    }),
  ),
  forms: z.array(
    z.object({ page: z.number(), formPath: z.string(), shared: z.boolean(), glyphs: z.number() }),
  ),
  stats: z.object({
    glyphs: z.number(),
    lines: z.number(),
    paragraphs: z.number(),
    translatable: z.number(),
    runs: z.number(),
  }),
})
export type AnalysisResult = z.infer<typeof AnalysisResult>

export const TranslatedParagraph = z.object({
  id: z.string(),
  text: z.string(),
  kept: z.boolean(),
})
export type TranslatedParagraph = z.infer<typeof TranslatedParagraph>

export const ComposeRequest = z.object({
  sourcePath: z.string(),
  monoPath: z.string(),
  dualPath: z.string().nullable(),
  analysis: AnalysisResult,
  translations: z.array(TranslatedParagraph),
  fonts: z.object({ regular: z.string(), bold: z.string() }),
  options: z.object({
    minFontScale: z.number(),
    lineHeightFactor: z.number(),
    minLineHeightFactor: z.number(),
  }),
})
export type ComposeRequest = z.infer<typeof ComposeRequest>

export const ComposeResult = z.object({
  monoBytes: z.number(),
  dualBytes: z.number().nullable(),
  paragraphsWritten: z.number(),
  paragraphsKept: z.number(),
  opsRemoved: z.number(),
  runsRedrawn: z.number(),
  warnings: z.array(
    z.object({
      paragraphId: z.string().optional(),
      page: z.number().optional(),
      code: z.string(),
      message: z.string(),
    }),
  ),
})
export type ComposeResult = z.infer<typeof ComposeResult>

export const VerifyResult = z.object({
  monoPages: z.number(),
  dualPages: z.number().nullable(),
  sizeMismatches: z.number(),
  translatedPagesWithoutCjk: z.array(z.number()),
})
export type VerifyResult = z.infer<typeof VerifyResult>
