# 03 PDF 流水线

> 本章是 4.0 的核心算法规格。处理思路参照 [PDFMathTranslate（pdf2zh 1.x）](https://github.com/PDFMathTranslate/PDFMathTranslate)：**不用白色矩形覆盖原文，而是改写页面内容流——删掉被翻译段落的文字绘制指令，保留其余全部图形指令，再把译文和搬动位置后的公式字形追加回去；公式用原 PDF 里的字体与字符编码原样重绘，图表、表格、页眉页脚里的文字一个字节都不动。** 与 pdf2zh 的逐项对照见 §3.17；pdf2zh 关键代码的笔记见 [docs/reference/pdfmathtranslate-notes.md](../reference/pdfmathtranslate-notes.md)。
>
> 所有阈值集中定义在 `src/shared/pdf-constants.ts`（§3.16），代码里不得出现裸数字。坐标统一用 **PDF 用户空间**（原点左下，单位 pt，不做 /Rotate 变换）；pdf.js 的算子流与 pdf-lib 都在这个坐标系里。

## 3.1 总览与数据流

```
source.pdf
  │ inspect   (worker: analyze)   → PdfInspection                          3–9 %
  │ analyze   (worker: analyze)   → AnalysisResult（字形→行→栏→段落→公式）   10–29 %
  │ translate (主进程, 04 章)      → TranslatedParagraph[]                   30–79 %
  │ compose   (worker: compose)   → work/mono.pdf, work/dual.pdf            80–89 %
  │ verify    (worker: analyze)   → VerifyResult                            90–93 %
  └ archive   (主进程)            → output/、manifest、清理 work/            94–100 %
```

与 pdf2zh 的分工对应：pdf2zh 用 pdfminer 解释内容流得到逐字符信息（`converter.py` `render_char`），我们用 pdf.js 的算子流（`getOperatorList`）自己解释文字状态得到逐字形信息（§3.4）；pdf2zh 用 DocLayout-YOLO 的框决定段落归属与保留区域，我们用几何规则（§3.5–3.9）；pdf2zh 在 `pdfinterp.py` 里重建去掉全部文字指令的 `ops_base`，我们只删除被翻译段落的文字指令（§3.12）；公式搬运、译文排版与 pdf2zh 同理（§3.8、§3.12）。

## 3.2 数据类型

`src/shared/pdf-types.ts`（zod schema + 推导类型；worker 消息也用它们校验）：

```ts
export const Rect = z.tuple([z.number(), z.number(), z.number(), z.number()]) // [x0, y0, x1, y1]
export const Matrix = z.tuple([
  z.number(),
  z.number(),
  z.number(),
  z.number(),
  z.number(),
  z.number(),
])

export const PdfInspection = z.object({
  pages: z.number().int().positive(),
  pageSizes: z.array(z.tuple([z.number(), z.number()])), // MediaBox 宽高（未按 /Rotate 交换）
  rotations: z.array(z.number()),
  textChars: z.number(),
  visibleTextChars: z.number(), // 抽样页字符数；visible 排除 Tr 3/7
  hasTextLayer: z.boolean(),
  title: z.string().optional(),
})

// 一个字形 = 内容流里画出来的一个字符
export const Glyph = z.object({
  page: z.number().int(),
  opSeq: z.number().int(), // 该页第几个 show-text 算子（执行顺序，含内联的 Form XObject），同一算子的字形永远同行同段
  formPath: z.string(), // '' = 页面本身；'3' = 页面第 3 次 Do 进入的表单；'3/1' = 其中第 1 次 Do 的嵌套表单
  code: z.number().int(), // 内容流里的字符编码（pdf.js glyph.originalCharCode）
  unicode: z.string(), // 可能为空串（无 ToUnicode）
  fontKey: z.string(), // pdf.js 的 loadedName（g_d0_f1），§3.12 映射回资源名
  fontFamily: z.string(), // 去掉子集前缀的 BaseFont，如 CMMI10、NimbusRomNo9L-Regu
  composite: z.boolean(),
  codeBytes: z.number().int(), // 编码字节数 1–4（§3.4）
  bold: z.boolean(),
  italic: z.boolean(),
  type3: z.boolean(),
  trm: Matrix, // 文字渲染矩阵：[size·Th, 0, 0, size, 0, rise] × Tm × CTM
  x: z.number(),
  y: z.number(), // 字形原点（基线左端）用户空间坐标 = trm[4], trm[5]
  size: z.number(), // 视觉字号 = hypot(trm[2], trm[3])
  adv: z.number(), // 用户空间的水平前进量（含 Tc/Tw/Tz）
  width: z.number(), // 字形宽度（不含间距）用户空间
  ascent: z.number(),
  descent: z.number(), // 相对字号比例
  rotated: z.boolean(), // trm 不是纯缩放
  vertical: z.boolean(),
  renderMode: z.number().int(), // Tr
  color: z.tuple([z.number(), z.number(), z.number()]), // 填充色 0–1
  isSpace: z.boolean(),
})

export const FormulaRun = z.object({
  id: z.number().int(), // 段落内从 1 起，对应 {vN}
  glyphs: z.array(Glyph), // 按 x 排序
  bbox: Rect,
  baselineOffset: z.number(), // 首字形基线 − 所在行基线（上下标为正/负）
  width: z.number(), // max(x + width) − first.x
  text: z.string(), // unicode 拼接，只用于日志
})

export const Line = z.object({
  page: z.number().int(),
  bbox: Rect,
  baseline: z.number(), // 行主文字（非公式、非上下标）基线的中位数
  size: z.number(), // 行主字号
  glyphs: z.array(Glyph),
  runs: z.array(FormulaRun), // 该行的公式片段（编号在段落级重排）
  text: z.string(), // 已含 {vN} 的行文本
  opSeqs: z.array(z.number()),
  column: z.number().int(), // §3.6
  formulaLine: z.boolean(), // 整行是公式（display math）
})

export const Paragraph = z.object({
  id: z.string(), // `${page}-${index}`
  page: z.number().int(),
  bbox: Rect,
  lines: z.array(z.object({ bbox: Rect, baseline: z.number(), opSeqs: z.array(z.number()) })),
  size: z.number(),
  lineHeight: z.number(),
  bold: z.boolean(),
  align: z.enum(['left', 'justify', 'center', 'right']),
  color: z.tuple([z.number(), z.number(), z.number()]),
  role: z.enum(['body', 'heading', 'caption', 'listItem', 'footnote', 'headerFooter', 'other']),
  text: z.string(), // 待翻译文本，含 {vN}
  runs: z.array(FormulaRun), // 段落级编号 1..N
  formPath: z.string(),
  translatable: z.boolean(),
  skipReason: z.string().optional(),
})

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
  ), // fontKey → 信息
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

export const TranslatedParagraph = z.object({ id: z.string(), text: z.string(), kept: z.boolean() })

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
export const VerifyResult = z.object({
  monoPages: z.number(),
  dualPages: z.number().nullable(),
  sizeMismatches: z.number(),
  translatedPagesWithoutCjk: z.array(z.number()),
})
```

## 3.3 inspect（检查 PDF）

`src/main/pdf/inspect.ts`，在 analyze worker 里执行。

1. `pdfjs.getDocument({ data, useSystemFonts: false, disableFontFace: true, isEvalSupported: false, standardFontDataUrl, cMapUrl, cMapPacked: true, verbosity: 0 })`；`standardFontDataUrl`、`cMapUrl` 指向 `pdfjs-dist/standard_fonts/`、`cmaps/`（打包后在 `process.resourcesPath/pdfjs/…`，见 07 章），末尾带 `/`。
2. 失败映射（`src/shared/errors.ts`，均为永久错误）：`PasswordException` → `pdf_encrypted`；`InvalidPDFException` / 头部不是 `%PDF` → `pdf_invalid`；其他 → `pdf_open`。
3. `numPages === 0` → `pdf_empty`；`> MAX_PAGES (600)` → `pdf_too_long`。
4. 每页 `getViewport({ scale: 1, rotation: 0 })` 取 MediaBox 宽高与 `rotate`；宽或高 < 50 或 > 14400 pt → `page_geometry`。
5. 文本层：抽样页（前 3 页 + 均匀取样共最多 8 页）跑 §3.4 的字形提取（只统计，不建行），统计字形总数与 `renderMode ∉ {3, 7}` 的可见字形数。可见字形 < `MIN_TEXT_CHARS_SAMPLE (200)` 且平均每页 < 25 → `scanned_pdf`（含只有 OCR 隐藏文字层的扫描件）。
6. `getMetadata()` 的 `info.Title` 去空白后长度 3–300 且不像文件名（不含 `.pdf`、不全是数字）时作为标题候选。

超时 60 s（主进程侧计时，超时 terminate → `inspect_timeout`，可重试）。

## 3.4 字形提取：解释 pdf.js 算子流

`src/main/pdf/analyze/glyphs.ts`。pdf.js 的 `page.getOperatorList()` 返回 `{ fnArray, argsArray }`，算子常量在 `pdfjs.OPS`。pdf.js 已经做了归一化（`src/core/evaluator.js`）：`TJ` 变成带数字间距的 `showText`；`'` 变成 `nextLine + showText`；`"` 变成 `nextLine + setWordSpacing + setCharSpacing + showText`；`Tf` 的第一个参数是 pdf.js 内部的 `loadedName`（`g_d0_f1`），字体对象通过 `page.commonObjs.get(loadedName)` 拿到；Form XObject 被内联为 `paintFormXObjectBegin [matrix, bbox] … paintFormXObjectEnd`；填充色算子的参数被换算成 RGB（可能是 `[r,g,b]` 0–255 数组，也可能是 `'#rrggbb'` 字符串——两种都要处理）。

状态机（参照 pdf.js `src/display/canvas.js` 的 `showText`，与 PDF 32000 §9.4）：

| 算子                                                                                                                   | 处理                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `save` / `restore`                                                                                                     | CTM 与图形状态入栈/出栈                                                                                                                                                                                                                                                                                |
| `transform [a,b,c,d,e,f]`                                                                                              | `CTM = M × CTM`                                                                                                                                                                                                                                                                                        |
| `paintFormXObjectBegin [matrix, bbox]`                                                                                 | 入栈；`CTM = matrix × CTM`；`formPath` 追加本层 `Do` 计数；`formDepth++`                                                                                                                                                                                                                               |
| `paintFormXObjectEnd`                                                                                                  | 出栈                                                                                                                                                                                                                                                                                                   |
| `beginText`                                                                                                            | `Tm = Tlm = I`                                                                                                                                                                                                                                                                                         |
| `setFont [loadedName, size]`                                                                                           | 当前字体、字号；从 `commonObjs.get` 取 `font.fontMatrix`（默认 `[0.001,0,0,0.001,0,0]`）、`font.vertical`、`font.composite`、`font.name`、`font.ascent`/`descent`、`font.isType3Font`、`font.cMap`（复合字体，用它的 `codespaceRanges` 判断编码字节数：code 落在第 k 组范围里 → k 字节；判断不了 → 2） |
| `setCharSpacing` / `setWordSpacing` / `setHScale (百分数/100)` / `setLeading` / `setTextRise` / `setTextRenderingMode` | 更新文字状态                                                                                                                                                                                                                                                                                           |
| `moveText [tx, ty]`                                                                                                    | `Tlm = translate(tx, ty) × Tlm; Tm = Tlm`                                                                                                                                                                                                                                                              |
| `setTextMatrix`                                                                                                        | `Tm = Tlm = M`                                                                                                                                                                                                                                                                                         |
| `nextLine`                                                                                                             | `moveText(0, −leading)`                                                                                                                                                                                                                                                                                |
| `setFillRGBColor` 等填充色                                                                                             | 当前填充色（归一到 0–1）                                                                                                                                                                                                                                                                               |
| `paintImageXObject` / `paintImageXObjectRepeat` / `paintInlineImageXObject`                                            | 记录图片矩形：单位正方形经 CTM 变换后的包围盒 → `imageRects[page]`                                                                                                                                                                                                                                     |
| `showText [glyphs]`                                                                                                    | 见下                                                                                                                                                                                                                                                                                                   |

`showText` 的每个元素：数字 → `x −= n × size / 1000`（水平文字）；字形对象 `{ originalCharCode, unicode, width, isSpace, vmetric }` →

```
w0 = glyph.width × fontMatrix[0]                     // 文字空间字形宽（Type3 用其 fontMatrix）
spacing = charSpacing + (glyph.isSpace ? wordSpacing : 0)
trm = [size × Th, 0, 0, size, 0, rise] × Tm × CTM
origin = apply(trm-with-x, (x, 0))                   // 先把 x 平移进 Tm：Tm' = translate(x × Th, 0) × Tm
record Glyph { x: origin.x, y: origin.y, size: hypot(trm[2], trm[3]), width: w0 × size × Th × ctmScale, adv: (w0 × size + spacing) × Th × ctmScale, ... }
x += w0 × size + spacing                             // 文字空间累加，最后 Tm 平移 x × Th
```

`ctmScale = hypot(CTM[0], CTM[1])`；`rotated = |trm[1]| > 1e-3 || |trm[2]| > 1e-3`（用 trm 的旋转分量判断）；`ascent = font.ascent ?? 0.8`、`descent = font.descent ?? −0.2`（pdf.js 字体对象可能没有，缺省即可）；`unicode = glyph.unicode ?? ''`（`isInFont === false` 或 unicode 为空 → 视为未知字形，§3.8 当公式处理）；`fontFamily = font.name.split('+').pop()`；`bold = /bold|black|heavy|semibold|-BX|CMBX/i`、`italic = /italic|oblique|-It$|MI\d|CMTI|Slanted/i` 匹配 `fontFamily`。`opSeq` 每遇到一个 `showText` 加一（页内计数，含表单）。`renderMode` 取当前 Tr。

其余算子忽略。整个解释器要能在 300 页文档上跑完，`getOperatorList` 每页独立调用并在用完后 `page.cleanup()`。

**表单（Form XObject）**：分析结束后统计每个表单被多少页引用（用 pdf-lib 在 compose 阶段做也行，但判断需要在 analyze 阶段：用 pdf.js `page.getOperatorList` 无法拿到表单的对象号，因此用一个独立的 pdf-lib 扫描：遍历所有页 `/Resources /XObject`，递归表单自身的 `/Resources /XObject`，统计每个表单 ref 被引用的页数与在每页里的 `Do` 顺序，得到 `formPath → { ref, shared }`）。`shared === true`（被 ≥ 2 页引用）的表单里的字形一律排除（既不翻译也不删除）。

**图片矩形**同时用于 §3.9 的 `inside_image` 判定。

## 3.5 行合并

`src/main/pdf/analyze/lines.ts`。按页处理，先排除 `vertical`、`renderMode ∈ {3, 7}`、来自 shared 表单的字形（它们进入 `excluded` 计数，不参与后续任何步骤）。

按**内容流顺序**遍历字形，维护最近的 `OPEN_LINES (8)` 条未关闭行：

1. **算子不可拆**：若该字形的 `opSeq` 已属于某行 → 直接加入该行。
2. 否则找一条行满足：字形竖直范围 `[y + descent·size, y + ascent·size]` 与行竖直范围重叠 ≥ 50% 的字形高度，且 `rotated` 一致，且水平位置在 `[line.x1 − 0.5·size, line.x1 + LINE_GAP_MAX (2.5)·size]` 内（追加）或 `[line.x0 − 2.5·size, line.x0 + 0.5·size]` 内（前插）。找到 → 加入；否则新建行。
3. 行内字形最后按 `x` 排序。行 `baseline` = 行内「主文字」（§3.8 判定后非公式、非上下标）基线的中位数，若没有主文字则全部字形基线中位数；`size` = 主文字字号的众数（按宽度加权）；`bbox` = 字形包围盒并集。
4. 行文本拼接（§3.8 完成公式片段划分后）：相邻字形 `gap = next.x − (prev.x + prev.width)`；`gap > LINE_SPACE_GAP (0.15)·size` 或 `prev.isSpace` → 一个空格；否则直接拼接。公式片段写成 `{vN}`。连续空白折叠。

## 3.6 栏与阅读顺序

`src/main/pdf/analyze/columns.ts`。

1. 页面正文字号 `bodySize` = 所有行按字符数加权的 `size` 中位数。候选行 = `size ∈ [0.75, 1.25] × bodySize` 且非 `formulaLine`。
2. 候选行左边界 `x0` 的直方图（bin `COLUMN_BIN (10)` pt）。存在两个峰、峰距 ≥ `COLUMN_MIN_SEPARATION (0.35)` × 页宽、各覆盖 ≥ `COLUMN_MIN_COVERAGE (30%)` 候选行 → 两栏，分界 = 两峰之间覆盖最少的 x；否则单栏。
3. 行归栏：行中心在分界左 → 0；右 → 1；跨越分界且宽 > `SPAN_MIN_WIDTH (0.6)` × 页宽 → `span`（通栏），把页面按 y 切成若干段，每段内先左栏后右栏。
4. 阅读顺序：段 → 栏 → y 降序。

## 3.7 段落合并

`src/main/pdf/analyze/paragraphs.ts`。在同一栏序列内，`formulaLine` 单独成段（`translatable=false, skipReason='display_math'`）；紧随其后只含 `(3)`、`[12]` 之类编号的短行并入它。其余相邻行 `prev`、`cur` 同段需全部满足：

- `prev.baseline − cur.baseline ≤ PARA_GAP_FACTOR (1.75) × lineHeightEstimate`（段内已有行的基线间距中位数；单行时 `1.3 × size`）；
- `|cur.size − para.size| ≤ PARA_FONT_TOLERANCE (0.15) × para.size`；
- `cur.bbox` 与段 bbox 的 x 区间重叠 ≥ `PARA_X_OVERLAP (50%)` 较窄者宽度；
- 不触发「开新段」信号：首行缩进（`cur.x0 − para.x0 > PARA_INDENT (1.0) × size` 且 `prev` 右端比栏右边界短 > 2·size）；`prev` 以 `.。?!:` 结尾且右端短 > 3·size 且 `cur` 以大写/编号/项目符号开头；`cur` 匹配标题模式 `^(\d+(\.\d+)*\.?\s+\S|[IVX]+\.\s+\S|Abstract|References|Acknowledg|Appendix)` 且（`cur.size ≥ 1.05 × bodySize` 或 `cur` 加粗而段落不加粗）；`cur.rotated`。

段落属性：`size` = 行字号中位数；`lineHeight` = 基线间距中位数（单行 = `1.2 × size`）；`bold` = 加粗字形占比 > 60%；`color` = 首行首个主文字字形的颜色；`align`：左右边界方差都 < 1 pt 且 ≥ 2 行 → `justify`；仅左齐 → `left`；行中心与栏中心差 < 2 pt 且左右都不齐 → `center`；否则 `left`。`role`：`headerFooter`（bbox 完全在页面顶部或底部 `HEADER_FOOTER_BAND (6%)` 内且单行且 < 120 字）；`heading`（≤ 2 行且 `size ≥ HEADING_FONT_RATIO (1.15) × bodySize`，或加粗且匹配标题模式）；`caption`（`^(Figure|Fig\.|Table|Algorithm|Listing)\s*\d+`）；`listItem`（`^([•\-–▪◦]|\(\w{1,3}\)|\w{1,3}[.)])\s` 且首行缩进）；`footnote`（`size ≤ FOOTNOTE_FONT_RATIO (0.85) × bodySize` 且位于页面下 30% 且 `^\d{1,2}\s|^[*†‡]`）；其他 `body`；`bodySize` 无法确定 → `other`。

段落文本 = 各行文本按 §3.10 连接；公式片段在段落级重新编号 `{v1}…{vN}`（按阅读顺序）。

## 3.8 公式与保留片段 → `{vN}`

`src/main/pdf/analyze/formula.ts`。规则直接取自 pdf2zh `converter.py` `vflag()` 与 `receive_layout()` 的第 A 部分，并做了两处放宽（见末尾）。

**字形级判定** `isFormulaGlyph(g, line)`，任一成立：

1. 字体名规则：`fontFamily` 匹配 `FORMULA_FONT_RE = /^(CM[^R]|MS.M|XY|MT|BL|RM|EU|LA|RS|LINE|LCIRCLE|TeX-|rsfs|txsy|wasy|stmary|.*Mono|.*Code|.*Ital|.*Sym|.*Math)/`（pdf2zh 原表；`re.match` 语义 = 锚定开头）。
2. 字符规则：`unicode` 非空且不是普通空格，且首字符 Unicode 类别 ∈ {`Lm`, `Mn`, `Sk`, `Sm`, `Zl`, `Zp`, `Zs`}（JS：`/^[\p{Lm}\p{Mn}\p{Sk}\p{Sm}\p{Zl}\p{Zp}\p{Zs}]/u`）或码点在 `U+0370–U+03FF`（希腊字母）。
3. 未知字形：`unicode === ''`（pdf2zh 的 `(cid:` 情况）。
4. 上下标：`g.size < SUBSCRIPT_SIZE_RATIO (0.79) × line.size`，且行里在它之前已有 ≥ 2 个主文字字形（pdf2zh：`len(sstk[-1].strip()) > 1`，避免把首字下沉/大写首字母误判）。
5. 竖排或旋转：`g.vertical || g.rotated`。
6. 括号配对：前一个字形属于公式片段（中间无主文字）且当前是 `(` → 公式，`depth++`；`depth > 0` 且当前是 `)` → 公式，`depth--`。

**片段合并**：同一行内连续的公式字形合并为一个 `FormulaRun`；两个公式字形之间的水平间隔 > `FORMULA_MERGE_GAP (1.0) × size` 则断开成两个片段（pdf2zh 用 `vmax = 页宽/4` 只在跨行时断开；我们按行处理所以用更小的阈值即可）。`baselineOffset = run.glyphs[0].y − line.baseline`；`width = max(g.x + g.width) − glyphs[0].x`。

**整行公式**（display math）：行内公式片段宽度之和 ≥ `DISPLAY_MATH_WIDTH_RATIO (0.7)` × 行宽，或去掉公式后不含任何 ≥ 3 个字母的拉丁单词 → `formulaLine = true`。

**放宽**（pdf2zh 没有，我们加的）：

- `.*Ital` 规则命中的连续片段若含 ≥ `ITALIC_TEXT_MIN_WORDS (3)` 个由空格分隔、每个 ≥ 2 个字母的拉丁单词（如斜体的定理陈述、强调句），则不算公式，按正文翻译；其中真正的变量名会被规则 2/4 单独抓出来。
- 规则 2 里的 `Zs`（非普通空格的空白）单独出现时不成段：只有与其他公式字形相邻才计入片段，否则当空格。

## 3.9 可翻译判定

段落 `translatable = true` 需全部满足，否则 `false` 并给 `skipReason`：

| 条件                                                                                                                                                   | skipReason                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| 不是 `formulaLine` 段                                                                                                                                  | `display_math`                                   |
| `role !== 'headerFooter'`                                                                                                                              | `header_footer`                                  |
| 去掉 `{vN}` 与空白后 ≥ `MIN_PARAGRAPH_CHARS (2)` 字且含 ≥ 2 个拉丁字母                                                                                 | `no_letters`                                     |
| 不匹配纯 URL / DOI / 邮箱 / 纯数字符号                                                                                                                 | `non_text`                                       |
| 与任何 `imageRect` 的重叠面积 ≤ `IMAGE_OVERLAP_SKIP (30%)` 段落面积                                                                                    | `inside_image`                                   |
| 短段落（< `SHORT_PARAGRAPH_CHARS (40)` 字）须满足 `role ∈ {heading, caption, listItem}`，或宽 ≥ 0.5 × 栏宽，或上下 2 × lineHeight 内有可翻译的 body 段 | `short_isolated`（图表轴标签、图例、表格单元格） |
| 无 `rotated` 行                                                                                                                                        | `rotated`                                        |
| 所在页 `rotate === 0`                                                                                                                                  | `rotated_page`                                   |
| 不来自 shared 表单；表单深度 ≤ `MAX_FORM_DEPTH (4)`                                                                                                    | `shared_form` / `form_too_deep`                  |
| 所有字形 `renderMode ∈ {0, 2}`（填充）                                                                                                                 | `invisible_text`                                 |
| 所有公式片段的字体都能在 compose 阶段映射（§3.12.4；若映射失败则在 compose 里回退为 `kept`，事件 warning）                                             | —                                                |
| `role !== 'other'` 或字数 ≥ 40                                                                                                                         | `unknown_role`                                   |

不可翻译段落的文字指令**原封不动**留在内容流里（这就是 pdf2zh 里「保留区域字符原位重绘」的等价做法，但我们连重绘都省了）。

## 3.10 文本规整

`src/main/pdf/analyze/normalize.ts`，对可翻译段落的 `text`：

1. 行连接：上一行以 `-` 结尾且下一行以小写字母开头 → 去掉 `-` 直接连接；以 `-` 结尾但下一行大写 → 保留 `-` 不加空格；其他用一个空格。
2. 连字 `ﬁ ﬂ ﬀ ﬃ ﬄ` → 还原；` ` → 空格；去掉 `​﻿`。
3. 连续空白折叠；首尾去空白；`{vN}` 前后各保证一个空格（句首/句尾只一侧）。

## 3.11 翻译接口

`translate` 阶段把 `paragraphs.filter(translatable)` 映射为 `Segment { id, text }`，交给 04 章 `translateDocument()`；PDF 模式校验保证译文里 `{vN}` 集合与顺序不变。失败保留原文的段落 `kept = true`——compose 时视同不可翻译（不删指令）。进度 `30 + 49 × done / total`。

## 3.12 compose（内容流改写）

`src/main/workers/compose.ts` → `src/main/pdf/compose/*.ts`。全部用 `@cantoo/pdf-lib` 的低层 API（`PDFDocument.context`、`PDFRef`、`PDFDict`、`PDFRawStream`、`decodePDFRawStream`、`PDFContentStream`）。

### 3.12.1 内容流词法分析器（`content-lexer.ts`）

输入 `Uint8Array`，输出 token 数组，每个 token 带 `[start, end)` 字节范围以便**原样回写**。语法（PDF 32000 §7.2、§7.8）：

- 空白：`\0 \t \n \f \r 空格`；注释 `%` 到行尾。
- 数字 `[+-]?(\d+\.?\d*|\.\d+)`；名字 `/…`（`#xx` 转义）；字符串 `(...)`（括号嵌套、反斜杠转义、跨行）；十六进制串 `<…>`；数组 `[` `]`；字典 `<<` `>>`；算子 = 其余连续非分隔符字符。
- 内联图像：遇到算子 `BI` 后读到 `ID`，跳过一个空白字节，然后扫描到「空白 + `EI` + 空白或 EOF」为止，整段作为一个不透明 token（原样保留，永不删除）。

页面 `/Contents` 是数组时把各流解码后用 `\n` 连接（算子不会跨流边界，但操作数可能——罕见，出现时按连接后的整体解析）。

### 3.12.2 遍历器（`content-walker.ts`）

在 token 流上运行一个只关心定位的状态机（不需要字形宽度）：

- `q`/`Q`/`cm` 维护 CTM 栈；`BT` 置 `Tm = Tlm = I`；`Tf` 记录当前字体资源名与字号；`Td`/`TD`/`Tm`/`T*`/`TL`/`Ts` 按 §3.4 的规则更新；`'`/`"` 先做换行（`"` 再设 Tw/Tc）。
- 对每个 show-text 算子（`Tj` `TJ` `'` `"`）计算起点 `start = apply(translate(0, Ts) × Tm × CTM, (0, 0))`，产出 `TextOp { tokenRange（含操作数）, start, fontName, formPath, seq }`。
- `Do`：查该名字在当前资源里的 XObject；是表单且不是 shared 且深度 ≤ 4 → 递归进入其内容流（`CTM = /Matrix × CTM`，资源用表单自己的 `/Resources`，缺省用父级），`formPath` 追加计数；否则跳过（其内容保持原样）。

### 3.12.3 删除集合

对每页：被翻译段落集合 `T = { p | p.translatable && !kept(p) }`。一个 `TextOp` 属于删除集合当且仅当 `start` 落在某个 `p ∈ T` 的 `expand(p.bbox, REMOVE_PADDING (1.0))` 内且 `formPath` 相同。

一致性校验（防止分析与改写坐标不一致）：删除的 `TextOp` 数量应等于 `T` 中所有段落 `lines[].opSeqs` 的并集大小；不等时按 `start` 与字形记录（每个 `opSeq` 的首字形坐标）做 0.5 pt 容差的匹配，找出差异并写入 warning（`page`, `code: 'op_mismatch'`）；差异超过 10% 的页整页放弃改写（该页全部段落 `kept`，warning `page_skipped`），不让错误扩散。

**新内容流** = 原 token 序列去掉删除集合的 `tokenRange` 后原样拼接（不重新序列化其他任何 token）。表单流同理，各自写回各自的流对象（`context.assign(ref, newStream)`；保持原字典其余键，重新压缩用 `FlateDecode`）。对于因 shared 或深度而没进入的表单，不动。

### 3.12.4 字体资源

- 中文字体：`doc.registerFontkit(fontkit)`；`regular = await doc.embedFont(regularBytes, { subset: true })`，`bold` 只在有加粗段落时嵌入；`embedFont` 失败回退 `subset: false` 并 warning；再失败 → `font_embed_failed`（永久）。为每个改写的页面 `page.node.setFontDictionary('DFcjk', regular.ref)`（`DFcjkb` 加粗）。
- 原字体（公式重绘用）：从 §3.12.2 得到每个 `TextOp` 的 `fontName` 与所在资源字典；从分析结果得到每个 `opSeq` 的 `fontKey`。用「起点匹配」把 `fontKey → (资源字典 ref, 资源名)` 建表（同一页内多数算子都能匹配，取多数）；匹配不到的 `fontKey` 再用 BaseFont 名匹配（遍历页/表单 `/Font` 字典，比较去掉子集前缀的 `/BaseFont`）；仍找不到 → 用到该字体的公式片段所在段落 `kept`（warning `font_unmapped`）。把用到的原字体以 `DFo<n>` 的名字加入**页面**的 `/Font` 字典（值是原字典的 ref，来自表单的也一样）——所有新指令都追加在页面级内容流末尾，用页面用户空间坐标。

### 3.12.5 译文排版（`layout.ts`，纯函数）

`layoutParagraph(p, text, measure) → { lines: LaidOutLine[], fontSize, lineHeight, overflow }`：

- 分词：`{vN}`（宽 `run.width × fontScale`，高按 run bbox）、连续拉丁/数字串（`[A-Za-z0-9@#$%&*+\-=/<>'"_.,:;!?()\[\]]+`，不可拆，除非超过行宽）、单个 CJK 字符、单个中文标点、空格。
- 换行：贪心填充行宽 `p.bbox.x1 − p.bbox.x0`；避头尾：行首不能是 `，。、；：？！）】》」』〕〉…—`，行尾不能是 `（【《「『〔〈`；行尾溢出 ≤ 0.5 em 且是标点时允许。首行不缩进。
- 行高与字号：`fontSize = p.size`，`lineHeight = p.lineHeight`（多行段）或 `LINE_HEIGHT_FACTOR (1.3) × size`（单行段）。总高 = `lines × lineHeight`；若 > `p.bbox 高度 + 0.5 lineHeight`：先把行高每次减 `0.05 × size` 直到 `MIN_LINE_HEIGHT_FACTOR (1.05) × size`（pdf2zh 的做法）；仍溢出则字号每次减 0.5 pt 重排直到 `minFontScale (0.6) × p.size`；仍溢出 → 允许溢出（`overflow = true`，warning `overflow`），不截断。
- 对齐：`justify` 除末行外把剩余宽度平摊到 token 间；`center`/`right` 相应；`left` 不动。
- 基线：第一行基线 = `p.lines[0].baseline`；第 k 行 = 第一行 − k × lineHeight。

### 3.12.6 追加指令

页面新内容流 = `q\n<改写后的原内容>\nQ\n<新指令>`。新指令（全部十进制 3 位小数，颜色 `rg`）：

```
BT
0 Tc 0 Tw 100 Tz 0 Ts 0 Tr
r g b rg                                     % 段落颜色
/DFcjk 10.000 Tf 1 0 0 1 x y Tm <hex> Tj     % 每行的每个纯文字 run（占位符前后分开）
…
% 每个 {vN}：把原字形按原相对位置重绘
/DFo3 9.963 Tf a b c d x' y' Tm <codes> Tj   % 同字体同字号同颜色的连续字形合并成一个 Tj
ET
```

- 中文 run：`hex = regular.encodeText(str).toString()`（pdf-lib 返回 `PDFHexString`），宽度 `regular.widthOfTextAtSize(str, size)`。加粗段落用 `DFcjkb`。
- 公式片段重绘（pdf2zh `converter.py` 第 C 部分 `for vch in var[vid]` 的等价）：目标片段左端 `X`、基线 `Y = 行基线 + run.baselineOffset × fontScale`；每个字形 `g` 的新原点 = `(X + (g.x − first.x) × fontScale, Y + (g.y − first.y) × fontScale)`；`Tm = [g.trm[0..3] × fontScale, 新原点]`（保留原 trm 的缩放/斜切/上下标字号）；颜色 `g.color`；编码：`code` 按 `codeBytes` 写成大端十六进制（1 字节 `%02x`，2 字节 `%04x`，3/4 字节同理）；同一 Tj 里合并「同字体、同 trm 缩放、同颜色、且相邻字形的新原点差等于原 `adv × fontScale`（容差 0.05 pt）」的字形，否则拆成多个 Tj（各自带 Tm）。`fontScale = 最终字号 / p.size`。
- 段落级 try/catch：排版或编码异常 → 该段落 `kept`（其指令不删：因此删除集合要在排版全部成功后再确定——顺序是「先排版全部段落 → 确定删除集合 → 改写 → 追加」）。

### 3.12.7 保存与双语

`monoBytes = await doc.save({ useObjectStreams: true })` → 写 `work/mono.pdf`（先写临时文件再 rename）。

双语：`dual = PDFDocument.create()`；`orig = load(sourceBytes)`、`mono = load(monoBytes)`；逐页 `copyPages(orig,[i])`、`copyPages(mono,[i])` 交替 `addPage`。`settings.pdf.bilingual = false` 时跳过。文档元数据标题加 `（中文）`/`（双语）`。> `MAX_PAGES_SINGLE_PASS (200)` 页时按 50 页一批 `copyPages` 降低峰值内存；compose worker `resourceLimits.maxOldGenerationSizeMb = 4096`。

超时：`max(120 s, pages × 2 s)`。

## 3.13 verify

在 analyze worker 里：分别打开 `mono.pdf`（与 `dual.pdf`）：`mono.numPages === pages`，`dual.numPages === 2 × pages`；每页 MediaBox 与源页差 ≤ 1 pt；对每个写入过译文的页 `getTextContent` 含 ≥ 1 个 CJK 字符（`一-鿿`），不满足记入 `translatedPagesWithoutCjk`，> 0 → `verify_failed`（可重试）；文件 > 1 KiB；另外每个改写页的 `getOperatorList` 能成功执行（内容流语法未被改坏）。

## 3.14 worker 协议、超时与错误码

`src/main/pdf/worker-host.ts`：

```ts
type WorkerRequest =
  | { id: number; kind: 'inspect'; path: string }
  | { id: number; kind: 'analyze'; path: string; inspection: PdfInspection }
  | {
      id: number
      kind: 'verify'
      monoPath: string
      dualPath: string | null
      pages: number
      writtenPages: number[]
    }
  | { id: number; kind: 'compose'; request: ComposeRequest }
type WorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { code: string; message: string; stack?: string } }
  | { id: number; progress: { current: number; total: number } }
```

每个文档任务独占一个 analyze worker 与一个 compose worker（按需创建，任务结束 `terminate()`）；取消 = `terminate()`。超时由主进程计时：`inspect 60 s`、`analyze max(120 s, pages × 3 s)`、`compose max(120 s, pages × 2 s)`、`verify 120 s`；超时 → terminate → `<stage>_timeout`（可重试；第 3 次仍超时 → 永久失败，提示到 GitHub 提交问题并附文件）。worker 内所有异常带 `stack` 回传并写日志（3.x 的教训：不要隐藏原始异常）。

错误码表（`src/shared/errors.ts`）：

| code                                                                         | 类型   | 用户提示                                                                           |
| ---------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------- |
| `pdf_encrypted`                                                              | 永久   | 这个 PDF 已加密，请先用其他工具去除密码再翻译。                                    |
| `pdf_invalid`                                                                | 永久   | 文件不是有效的 PDF。                                                               |
| `pdf_empty`                                                                  | 永久   | PDF 没有页面。                                                                     |
| `pdf_too_long`                                                               | 永久   | PDF 超过 600 页，请拆分后再翻译。                                                  |
| `page_geometry`                                                              | 永久   | PDF 页面尺寸异常，无法处理。                                                       |
| `scanned_pdf`                                                                | 永久   | 这个 PDF 没有可见的文本层（可能是扫描件），DocFlow 不支持 OCR。                    |
| `no_paragraphs`                                                              | 永久   | 没有识别到可翻译的段落。                                                           |
| `font_embed_failed`                                                          | 永久   | 内置中文字体无法使用，请重新安装 DocFlow。                                         |
| `inspect_timeout` / `analyze_timeout` / `compose_timeout` / `verify_timeout` | 可重试 | 处理超时，稍后自动重试。                                                           |
| `verify_failed`                                                              | 可重试 | 生成的 PDF 未通过校验，稍后自动重试。                                              |
| `worker_crashed`                                                             | 可重试 | 处理进程意外退出，稍后自动重试。                                                   |
| `mostly_untranslated`                                                        | 永久   | 有 N 个字符（约占全文 X%）无法翻译，已停止处理。请换一个翻译服务或模型后重新处理。 |

compose 的 warning code（进处理记录，不中断）：`op_mismatch`、`page_skipped`、`font_unmapped`、`overflow`、`layout_failed`、`encode_failed`。

## 3.15 调试工具

`scripts/analyze-pdf.mjs <pdf>`：输出 `analysis.json`，并生成一份「调试 PDF」：用 pdf-lib 在原页上画段落框（可翻译绿、不可翻译灰并标 skipReason）、公式片段框（红）、行基线（蓝细线）。M2 验收靠它肉眼检查。`scripts/compose-pdf.mjs <pdf>` 用假翻译（每段前加「译」）跑完整改写，方便单独调试写回。

## 3.16 参数表

`src/shared/pdf-constants.ts`：

```ts
export const PDF = {
  MAX_PAGES: 600,
  MIN_TEXT_CHARS_SAMPLE: 200,
  SAMPLE_PAGES: 8,
  OPEN_LINES: 8,
  LINE_GAP_MAX: 2.5,
  LINE_SPACE_GAP: 0.15,
  LINE_OVERLAP_MIN: 0.5,
  COLUMN_BIN: 10,
  COLUMN_MIN_SEPARATION: 0.35,
  COLUMN_MIN_COVERAGE: 0.3,
  SPAN_MIN_WIDTH: 0.6,
  PARA_GAP_FACTOR: 1.75,
  PARA_FONT_TOLERANCE: 0.15,
  PARA_X_OVERLAP: 0.5,
  PARA_INDENT: 1.0,
  HEADING_FONT_RATIO: 1.15,
  FOOTNOTE_FONT_RATIO: 0.85,
  HEADER_FOOTER_BAND: 0.06,
  FORMULA_FONT_RE:
    /^(CM[^R]|MS.M|XY|MT|BL|RM|EU|LA|RS|LINE|LCIRCLE|TeX-|rsfs|txsy|wasy|stmary|.*Mono|.*Code|.*Ital|.*Sym|.*Math)/,
  SUBSCRIPT_SIZE_RATIO: 0.79,
  FORMULA_MERGE_GAP: 1.0,
  DISPLAY_MATH_WIDTH_RATIO: 0.7,
  ITALIC_TEXT_MIN_WORDS: 3,
  MIN_PARAGRAPH_CHARS: 2,
  SHORT_PARAGRAPH_CHARS: 40,
  IMAGE_OVERLAP_SKIP: 0.3,
  MAX_FORM_DEPTH: 4,
  REMOVE_PADDING: 1.0,
  OP_MATCH_TOLERANCE: 0.5,
  PAGE_SKIP_MISMATCH_RATIO: 0.1,
  LINE_HEIGHT_FACTOR: 1.3,
  MIN_LINE_HEIGHT_FACTOR: 1.05,
  MIN_FONT_SCALE: 0.6,
  LINE_HEIGHT_STEP: 0.05,
  FONT_SIZE_STEP: 0.5,
  MAX_PAGES_SINGLE_PASS: 200,
  TIMEOUT_INSPECT_MS: 60_000,
  TIMEOUT_ANALYZE_BASE_MS: 120_000,
  TIMEOUT_ANALYZE_PER_PAGE_MS: 3_000,
  TIMEOUT_COMPOSE_BASE_MS: 120_000,
  TIMEOUT_COMPOSE_PER_PAGE_MS: 2_000,
  TIMEOUT_VERIFY_MS: 120_000,
} as const
```

已知限制（写进 README「已知问题」）：

1. 没有版面模型：表格内的长单元格会被当作段落翻译，可能与表格线重叠；三栏及以上、复杂浮动排版的阅读顺序可能错乱。
2. 行内分式的横线（fraction bar）是路径而不是文字，公式搬动后横线留在原处（pdf2zh 会一起搬；我们留到 M7 之后）。
3. 斜体、等宽字体的短片段按 pdf2zh 规则视为公式保留原文；≥ 3 个单词的斜体句子才翻译。
4. 页眉页脚、图表轴标签、图例不翻译。
5. 译文超长时允许溢出到下一段的位置（不截断）。
6. `/Rotate` 非 0 的页面、竖排、从右到左文字、被多页共享的表单里的文字不翻译；没有 OCR。

## 3.17 与 PDFMathTranslate 的对照

| 环节         | pdf2zh 1.x                                                                                             | DocFlow 4.0                                                            | 原因                               |
| ------------ | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | ---------------------------------- |
| 解析         | pdfminer 逐字符（`LTChar`，附 `cid` 与字体对象）                                                       | pdf.js 算子流 + 自写文字状态机（§3.4）                                 | 纯 JS；pdf.js 的字体解码远好于自写 |
| 段落归属     | DocLayout-YOLO 框 + 内容顺序                                                                           | 行/栏/段几何规则（§3.5–3.7）                                           | 无模型、无原生依赖                 |
| 保留区域     | 模型的 figure/table/formula/abandon 框；其中字符以 `{v}` 原位重绘                                      | 图片矩形 + 短文本/页眉页脚等规则；不删除其指令                         | 等价效果，更省事                   |
| 公式判定     | `vflag`：字体正则 + Unicode 类别 + 希腊字母；上下标 0.79；竖排；括号配对                               | 同一套规则（§3.8）+ 斜体长句放宽                                       | 已验证有效                         |
| 公式重绘     | 用原字体资源名 + `cid` 逐字符 `Tj`，附带 `vfix` 纵向修正与分式横线                                     | 同（§3.12.6），横线暂不搬                                              | —                                  |
| 删除原文     | `PDFPageInterpreterEx.execute` 丢弃所有 `T*`、`'`、`"`、内联图像、marked content 算子，重建 `ops_base` | 词法分析后只删被翻译段落的 show-text 算子，其余字节原样保留（§3.12.3） | 不动的内容零风险；不用重新序列化   |
| 表单 XObject | 递归翻译，流内用逆矩阵回写                                                                             | 单页独占的表单递归删除指令，新指令统一在页面级追加；共享表单跳过       | 简化坐标处理                       |
| 译文字体     | Latin 用 Times（`tiro`），其他用 Noto                                                                  | 全部 Noto Sans SC（含 Latin）                                          | 少一个字体                         |
| 换行         | 只在原文有换行（`brk`）时换行；行高 1.4 逐步降到 1.0                                                   | 总是按框宽换行 + 避头尾；行高降到 1.05 后再缩字号到 0.6                | 更少溢出                           |
| 文字颜色     | 丢失（全部默认色）                                                                                     | 保留段落色与公式字形色                                                 | 视觉一致                           |
| 输出         | mono + dual（PyMuPDF `insert_page`）                                                                   | mono + dual（pdf-lib `copyPages`）                                     | —                                  |
