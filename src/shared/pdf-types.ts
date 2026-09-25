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
  // pdfminer LTChar corners in user space: text-space (0, 0) and (w0, 1) through trm.
  corners: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  fontName: z.string(), // BaseFont as the font dictionary names it
  ascent: z.number(),
  descent: z.number(),
  rotated: z.boolean(),
  vertical: z.boolean(),
  renderMode: z.number().int(),
  color: z.tuple([z.number(), z.number(), z.number()]),
  isSpace: z.boolean(),
})
export type Glyph = z.infer<typeof Glyph>

// pdfminer LTChar as pdf2zh sees it (descent forced to 0, so y0 is the baseline). Coordinates
// are page space relative to the crop box, like pdfminer after its page CTM.
export const LtChar = z.object({
  text: z.string(), // get_text(); '(cid:N)' when the font has no Unicode mapping
  x0: z.number(),
  y0: z.number(),
  x1: z.number(),
  y1: z.number(),
  size: z.number(), // BabelDOC: the box width for a vertical font or matrix[0] == 0, else its height
  vertical: z.boolean(), // matrix[0] == 0 and matrix[3] == 0
  angle: z.number(), // BabelDOC get_rotation_angle: degrees(atan2(matrix[1], matrix[0]))
  fontname: z.string(), // BaseFont
  font: z.string(), // resource name in the /Font dictionary of the stream that draws it
  code: z.number().int(),
  codeBytes: z.number().int(),
  // BabelDOC passthrough_per_char_instruction: colour and graphics-state operators in effect
  // when the glyph was shown, e.g. '/CS0 cs 0.2 0.3 0.4 sc'; '' when none were set.
  gstate: z.string(),
})
export type LtChar = z.infer<typeof LtChar>

// A stroked two-point horizontal black line (pdf2zh pdfinterp.do_S).
export const LtLine = z.object({
  x0: z.number(),
  y0: z.number(),
  pts: z.tuple([z.tuple([z.number(), z.number()]), z.tuple([z.number(), z.number()])]),
  linewidth: z.number(),
})
export type LtLine = z.infer<typeof LtLine>

// pdf2zh converter.Paragraph
export const Pdf2zhParagraph = z.object({
  y: z.number(),
  x: z.number(),
  x0: z.number(),
  x1: z.number(),
  y0: z.number(),
  y1: z.number(),
  size: z.number(),
  brk: z.boolean(),
  // BabelDOC _merge_styles over the paragraph's text characters: their common graphic state,
  // or null when they differ (the translation is then drawn in the default colour).
  gstate: z.string().nullable(),
})
export type Pdf2zhParagraph = z.infer<typeof Pdf2zhParagraph>

// One {vN}: var[N], varl[N], varf[N], vlen[N]
export const Pdf2zhFormula = z.object({
  chars: z.array(LtChar),
  lines: z.array(LtLine),
  fix: z.number(),
  len: z.number(),
})
export type Pdf2zhFormula = z.infer<typeof Pdf2zhFormula>

// DocLayout-YOLO output for one page (pixel coordinates, top-left origin, sorted by conf).
export const LayoutBox = z.object({ name: z.string(), conf: z.number(), xyxy: Rect })
export type LayoutBox = z.infer<typeof LayoutBox>
export const PageLayout = z.object({
  width: z.number().int(),
  height: z.number().int(),
  boxes: z.array(LayoutBox),
})
export type PageLayout = z.infer<typeof PageLayout>

// One receive_layout call: the page itself (formPath '') or one drawing of a form XObject.
export const LayoutUnit = z.object({
  id: z.string(),
  page: z.number().int(),
  formPath: z.string(),
  texts: z.array(z.string()), // sstk
  paragraphs: z.array(Pdf2zhParagraph), // pstk
  formulas: z.array(Pdf2zhFormula),
  lines: z.array(LtLine), // lstk
})
export type LayoutUnit = z.infer<typeof LayoutUnit>

export const AnalysisResult = z.object({
  version: z.literal(4),
  pages: z.number().int(),
  pageSizes: z.array(z.tuple([z.number(), z.number()])),
  units: z.array(LayoutUnit),
  stats: z.object({
    chars: z.number(),
    paragraphs: z.number(),
    translatable: z.number(),
    formulas: z.number(),
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
  fonts: z.object({ noto: z.string() }),
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
