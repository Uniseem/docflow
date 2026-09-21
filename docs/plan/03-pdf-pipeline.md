# 03 PDF 流水线

> 本章是 4.0 的核心算法规格。所有阈值集中定义在 `src/shared/pdf-constants.ts`，代码里不得出现裸数字。坐标系统一用 **PDF 用户空间**（原点左下，单位 pt），pdf.js 与 pdf-lib 都是这个坐标系。

## 3.1 总览与数据类型

```
source.pdf
  │ inspect   (worker: analyze)   → PdfInspection            3–9 %
  │ analyze   (worker: analyze)   → AnalysisResult           10–29 %
  │ translate (主进程, 04 章)      → TranslationResult        30–79 %
  │ raster    (隐藏窗口)           → 每个占位符的 PNG          80–82 %
  │ compose   (worker: compose)   → output/mono.pdf, dual.pdf 83–89 %
  │ verify    (worker: analyze)   → VerifyResult             90–93 %
  └ archive   (主进程)            → manifest 更新、work 清理   94–100 %
```

`src/shared/pdf-types.ts`（zod schema + 推导类型；worker 消息也用它们校验）：

```ts
export const Rect = z.tuple([z.number(), z.number(), z.number(), z.number()]) // [x0, y0, x1, y1]，x0<x1, y0<y1

export const PdfInspection = z.object({
  pages: z.number().int().positive(),
  pageSizes: z.array(z.tuple([z.number(), z.number()])),  // [width, height]，已按 /Rotate 归一（旋转 90/270 时交换）
  rotations: z.array(z.number()),                          // 每页 /Rotate
  textChars: z.number(),                                   // 抽样页的字符总数
  hasTextLayer: z.boolean(),
  encrypted: z.literal(false),                             // 加密在 inspect 里直接抛错，不进入结果
  producer: z.string().optional(),
  title: z.string().optional(),                            // 元数据标题（用作默认标题的候选）
})

export const TextItem = z.object({
  page: z.number().int(),
  str: z.string(),
  x: z.number(), y: z.number(),          // 基线起点
  width: z.number(), fontSize: z.number(),
  ascent: z.number(), descent: z.number(), // 相对字号的比例，默认 0.8 / -0.2
  fontName: z.string(),                  // pdf.js 的资源名 g_d0_f1
  fontFamily: z.string(),                // 真实字体名，如 CMMI10、NimbusRomNo9L-Regu；取不到时 ''
  bold: z.boolean(), italic: z.boolean(),
  rotated: z.boolean(),                  // 变换矩阵不是纯缩放（旋转/斜切）
  vertical: z.boolean(),
  color: z.tuple([z.number(), z.number(), z.number()]).optional(), // 0–1 RGB，取不到时 undefined
})

export const Line = z.object({
  page: z.number().int(),
  bbox: Rect,
  baseline: z.number(),
  fontSize: z.number(),                  // 行内最大字号
  items: z.array(TextItem),
  text: z.string(),                      // 已按 3.4 规则拼接，公式片段已替换为 {vN}
})

export const Placeholder = z.object({
  id: z.number().int(),                  // 段落内从 1 开始
  bbox: Rect,                            // 原页上的包围盒（多个 item 的并集）
  baselineOffset: z.number(),            // 片段基线相对所在行基线的偏移（用于上下标贴图垂直位置）
  fontSize: z.number(),
  text: z.string(),                      // 原始文本（调试与日志用，不送模型）
})

export const Paragraph = z.object({
  id: z.string(),                        // `${page}-${index}`，稳定，用作译文缓存与事件的键
  page: z.number().int(),
  bbox: Rect,
  lines: z.array(z.object({ bbox: Rect, baseline: z.number() })),
  fontSize: z.number(),                  // 段落主字号（行字号中位数）
  lineHeight: z.number(),                // 相邻基线距离中位数；单行段落 = fontSize * 1.2
  bold: z.boolean(),
  align: z.enum(['left', 'justify', 'center', 'right']),
  color: z.tuple([z.number(), z.number(), z.number()]),
  role: z.enum(['body', 'heading', 'caption', 'listItem', 'footnote', 'headerFooter', 'other']),
  text: z.string(),                      // 待翻译文本，含 {vN}
  placeholders: z.array(Placeholder),
  translatable: z.boolean(),
  skipReason: z.string().optional(),     // 不翻译的原因（日志与调试）
})

export const AnalysisResult = z.object({
  version: z.literal(1),
  pages: z.number().int(),
  pageSizes: z.array(z.tuple([z.number(), z.number()])),
  paragraphs: z.array(Paragraph),
  stats: z.object({ items: z.number(), lines: z.number(), paragraphs: z.number(), translatable: z.number(), placeholders: z.number() }),
})

export const TranslatedParagraph = z.object({
  id: z.string(),
  text: z.string(),                      // 译文，含 {vN}，已通过校验
  kept: z.boolean(),                     // true = 翻译失败保留原文（compose 时不覆盖）
})

export const ComposeRequest = z.object({
  sourcePath: z.string(),
  monoPath: z.string(),
  dualPath: z.string(),
  analysis: AnalysisResult,
  translations: z.array(TranslatedParagraph),
  rasters: z.record(z.string(), z.string()),   // `${paragraphId}#${placeholderId}` → PNG 文件路径
  fonts: z.object({ regular: z.string(), bold: z.string() }),
  options: z.object({ coverPadding: z.number(), minFontScale: z.number(), lineHeightFactor: z.number() }),
})

export const ComposeResult = z.object({
  monoBytes: z.number(), dualBytes: z.number(),
  paragraphsWritten: z.number(), paragraphsKept: z.number(),
  warnings: z.array(z.object({ paragraphId: z.string(), message: z.string() })),
})

export const VerifyResult = z.object({
  monoPages: z.number(), dualPages: z.number(),
  sizeMismatches: z.number(),
  translatedPagesWithoutCjk: z.array(z.number()),
})
```

## 3.2 inspect（检查 PDF）

`src/main/pdf/inspect.ts`，在 analyze worker 里执行（同一个 worker 处理 `inspect`、`analyze`、`verify` 三种消息）。

1. `pdfjs.getDocument({ data, useSystemFonts: false, disableFontFace: true, isEvalSupported: false, standardFontDataUrl, cMapUrl, cMapPacked: true, verbosity: 0 })`。`standardFontDataUrl` 与 `cMapUrl` 指向 `node_modules/pdfjs-dist/standard_fonts/` 与 `cmaps/`（打包后在 `app.asar.unpacked` 或 `extraResources`，见 07 章）。
2. 失败映射为错误码（`src/shared/errors.ts`，全部 `PermanentError`，用户可见中文）：
   - `PasswordException` → `pdf_encrypted`：`这个 PDF 已加密，请先用其他工具去除密码再翻译。`
   - `InvalidPDFException` / 头部不是 `%PDF` → `pdf_invalid`：`文件不是有效的 PDF。`
   - 其他 → `pdf_open`：`无法打开 PDF：<原因>`。
3. `numPages === 0` → `pdf_empty`：`PDF 没有页面。`；`numPages > MAX_PAGES (600)` → `pdf_too_long`：`PDF 超过 600 页，请拆分后再翻译。`
4. 每页 `getViewport({scale:1})` 取宽高（已含 /Rotate），记录 `rotate`。任一页宽或高 < 50 pt 或 > 14400 pt → `page_geometry`。
5. 文本层检测：抽样页 = 前 3 页 + 均匀取样共最多 8 页；对每页 `getTextContent()`，统计非空白字符数。总数 < `MIN_TEXT_CHARS_SAMPLE (200)` 且平均每页 < 25 → `scanned_pdf`：`这个 PDF 没有文本层（可能是扫描件），DocFlow 4.0 不支持 OCR。`
6. 元数据 `getMetadata()` 取 `info.Title`（去空白，长度 3–300 且不像文件名/`untitled` 时作为标题候选）。

超时：整个 inspect 60 s（主进程侧 `worker-host` 计时，超时 → terminate → `pdf_inspect_timeout`，属于可重试错误）。

## 3.3 提取文本项

`src/main/pdf/analyze/text-items.ts`

对每页：`page.getTextContent({ includeMarkedContent: false, disableNormalization: true })`。对每个 item（跳过 `str === ''` 且 `hasEOL` 之外的空项；`hasEOL` 只作为行分隔提示，不单独成项）：

- `t = item.transform`；`fontSize = Math.hypot(t[2], t[3])`；`rotated = Math.abs(t[1]) > 1e-3 || Math.abs(t[2]) > 1e-3`（考虑 pdf.js 已把 viewport 旋转吸收：用 `viewport.transform` 反算到用户空间——直接用 `page.getTextContent()` 返回的坐标即用户空间，不乘 viewport）。
- `x = t[4]`, `y = t[5]`（基线起点），`width = item.width`（用户空间 pt，pdf.js 已按字号缩放），`height = item.height`。
- 字体：`style = textContent.styles[item.fontName]` → `ascent = style.ascent ?? 0.8`、`descent = style.descent ?? -0.2`、`vertical = style.vertical === true`。真实字体名：`const f = page.commonObjs.has(item.fontName) ? page.commonObjs.get(item.fontName) : null; fontFamily = f?.name ?? style.fontFamily ?? ''`；`bold = /bold|black|heavy|semibold/i.test(fontFamily) || /,Bold|-Bold|BX|BoldMT/.test(fontFamily)`；`italic = /italic|oblique|-It$|MI\d|CMTI|Slanted/i.test(fontFamily)`。
- 颜色：pdf.js `getTextContent` 不给颜色。取法：`page.getOperatorList()` 一次，遍历 `OPS.setFillRGBColor / setFillGray / setFillCMYKColor / setFillColorSpace+setFillColorN` 维护当前填充色，遇到 `OPS.showText / showSpacedText` 时把当前色记入按顺序的数组；文本项与 showText 的顺序在绝大多数 PDF 中一致，按顺序对齐；数量不一致时全部回退为黑色 `[0,0,0]`。这一步允许失败（try/catch → 黑色），不影响其他。
- 生成 `TextItem`。同时记录页面的图片区域：遍历 operator list 的 `OPS.paintImageXObject / paintImageXObjectRepeat / paintInlineImageXObject`，用当前 CTM（维护 `transform`/`save`/`restore` 栈）算出 1×1 单位方块映射后的包围盒 → `imageRects: Rect[]`；同样允许失败。

pdf.js 在 Node 里用假 worker（无需 `GlobalWorkerOptions.workerSrc`）；如果 6.x 要求设置，指向 `pdfjs-dist/legacy/build/pdf.worker.mjs` 的绝对路径。

## 3.4 行合并

`src/main/pdf/analyze/lines.ts`

1. 丢弃 `vertical` 项；`rotated` 项单独成行并标记 `rotated`（最终不翻译）。
2. 按页分组；组内按 `y` 降序（页面上方在前）再 `x` 升序排序。
3. 相邻项合并进同一行的条件（全部满足）：`|y_a − y_b| ≤ 0.35 × min(fontSize_a, fontSize_b)`（上下标另有处理，见 3.7），`x_b ≥ x_a_end − 0.5 × fontSize`（允许轻微重叠），`x_b − x_a_end ≤ 2.5 × fontSize`（超过视为同一基线上的另一栏/表格单元，分行）。
4. 行内文本拼接：两项之间 `gap = x_b − x_a_end`；`gap > 0.12 × fontSize` 插入空格；否则直接拼接。两项本身的 `str` 首尾空白保留原样，最后 `collapse` 连续空白为一个。
5. 行 bbox：`x0 = min(x)`, `x1 = max(x+width)`, `y0 = baseline + descent×fontSize`（取最小），`y1 = baseline + ascent×fontSize`（取最大）；`fontSize` = 行内按宽度加权的众数（简单做法：最大字号，但若最大字号的项总宽 < 行宽 20% 则取中位数）。

## 3.5 栏与阅读顺序

`src/main/pdf/analyze/columns.ts`

1. 对每页，取 `role` 未定的正文候选行（字号在页面正文字号 ±25% 内，正文字号 = 该页所有行按字符数加权的字号中位数）。
2. 构造行左边界 `x0` 的直方图（bin 10 pt）。若存在两个峰，峰间距 ≥ 0.35 × pageWidth，且两峰各自覆盖 ≥ 30% 的候选行 → 两栏，分界 = 两峰之间行覆盖最少的 x；否则单栏。三栏以上不专门处理（按两栏逻辑通常退化为单栏，效果可接受）。
3. 行归栏：行中心 x 在分界左 → 左栏；右 → 右栏；跨越分界且宽度 > 0.6 × pageWidth → `span`（标题、摘要、通栏图表说明），单独作为一栏序列，按 y 插到正确位置：`span` 行把页面切成上下两段，每段内先左栏后右栏。
4. 阅读顺序：段（由 span 切分）→ 栏（左→右）→ y 降序。

## 3.6 段落合并

`src/main/pdf/analyze/paragraphs.ts`。在同一栏序列内，对相邻行 `prev`、`cur` 判断是否同段（全部满足则合并）：

- 垂直间距：`prev.baseline − cur.baseline ≤ 1.75 × lineHeightEstimate`，其中 `lineHeightEstimate` = 当前段已有行的基线间距中位数，段只有一行时 = `1.3 × fontSize`。
- 字号：`|cur.fontSize − para.fontSize| ≤ 0.15 × para.fontSize`。
- 水平：`cur.bbox` 与段 bbox 的 x 区间重叠 ≥ 50% 的较窄者宽度。
- 不是新段的信号（任一成立则**开新段**）：
  - `cur.x0 − para.x0 > 1.0 × fontSize`（首行缩进）且 `prev` 的右端比栏右边界短 `> 2 × fontSize`（上一行未撑满）；
  - `prev.text` 以 `.`、`。`、`?`、`!`、`:` 结尾且 `prev` 右端短于栏右边界 `> 3 × fontSize`，且 `cur.text` 以大写字母、数字编号（`^\d+(\.\d+)*\s`）、`•`/`-`/`–` 开头；
  - `cur.text` 匹配标题模式 `^(\d+(\.\d+)*\.?\s+\S|[IVX]+\.\s+\S|Abstract|References|Acknowledg|Appendix)` 且 `cur.fontSize ≥ 1.05 × bodyFontSize` 或 `cur.bold && !para.bold`；
  - `cur` 是 `rotated` 行。
- 段落属性：
  - `fontSize` = 行字号中位数；`lineHeight` = 基线间距中位数（单行 = `1.2 × fontSize`）；`bold` = 加粗字符占比 > 60%；`color` = 首行首项颜色。
  - `align`：所有行左边界方差 < 1 pt 且右边界方差 < 1 pt 且行数 ≥ 2 → `justify`；仅左对齐 → `left`；行中心与栏中心差 < 2 pt 且左右都不齐 → `center`；否则 `left`。
  - `role`：
    - `headerFooter`：bbox 完全在页面顶部 6% 或底部 6% 区域内，且单行、字数 < 120；
    - `heading`：单行或双行，`fontSize ≥ 1.15 × bodyFontSize` 或（`bold` 且匹配标题模式）；
    - `caption`：以 `^(Figure|Fig\.|Table|Algorithm|Listing)\s*\d+` 开头；
    - `listItem`：以 `^([•\-–▪◦]|\(\w{1,3}\)|\w{1,3}[.)])\s` 开头且首行缩进；
    - `footnote`：`fontSize ≤ 0.85 × bodyFontSize` 且位于页面下 30% 且以 `^\d{1,2}\s|^[*†‡]` 开头；
    - 其他 → `body`；`bodyFontSize` 无法确定（页面文字极少）时 → `other`。

## 3.7 公式与不可翻译片段 → 占位符

`src/main/pdf/analyze/formula.ts`，在行合并阶段对每个 `TextItem` 判定 `isFormulaLike`，再在行内把连续的公式项合并为一个占位符：

判定为公式项（任一）：

1. 字体名匹配 `FORMULA_FONT_RE = /(^|[-_,])(CM(SY|MI|EX|BX|MIB|BSY)|MS[AB]M|rsfs|wasy|stmary|txsy|pxsy|esint|eufm|eufb|eurm|euex|LMMath|LMMathSymbols|STIX|XITS|CambriaMath|Cambria-Math|Symbol|MathematicalPi|Euler|LatinModernMath|TeX-|Mathematica|AMS|MTEX|MTMI|MTSY|Asana|Fira-?Math)/i`（来自 pdf2zh 的经验列表并扩充）。
2. `str` 中数学字符占比 ≥ 50%：数学字符 = Unicode 块 `∀-⋿`（数学运算符）、`⟀-⟯`、`⦀-⧿`、`⨀-⫿`、`ᵀ0-ᵿF`（数学字母数字）、`Ͱ-Ͽ`（希腊，仅当字体斜体或项长度 ≤ 3）、`←-⇿`（箭头）、`±×÷∞`、上下标数字 `⁰-₟`。
3. 上下标：项字号 `≤ 0.8 ×` 行主字号且基线偏移 `|Δy| ≥ 0.15 ×` 行主字号；**但**若该项紧跟在 `[`/`(`/字母之后且内容是纯数字/逗号（如引用标记 `[12]`、脚注号），则不是公式（保留为文字随译文一起走，模型会照抄数字）。
4. 单字符项且字体斜体且是拉丁字母（变量名 `x`、`n`）且左右相邻项也是公式项或运算符。

合并：同一行内相邻（gap ≤ 1.0 × fontSize）的公式项合并为一个占位符；占位符 bbox = 并集；`baselineOffset` = 各项基线偏移的加权平均。占位符在行文本里写成 ` {vN} `（前后各一个空格，最后 collapse 空白），`N` 在**段落内**从 1 递增。

行级判定（display math，整行不翻译）：行内公式项宽度占行宽 ≥ 70%，或行文本去掉占位符后不含任何 ≥ 3 个字母的拉丁单词 → 整行标记 `formulaLine`，段落合并时这类行单独成段且 `translatable=false, skipReason='display_math'`；紧跟其后的行若只是 `(3)` 式编号也归入。

## 3.8 可翻译判定

段落 `translatable = true` 需全部满足，否则 `false` 并给 `skipReason`：

| 条件 | skipReason |
| --- | --- |
| `role !== 'headerFooter'`（页眉页脚不翻，避免页码/期刊名被改） | `header_footer` |
| 去掉占位符与空白后长度 ≥ `MIN_PARAGRAPH_CHARS (2)` 且含有 ≥ 2 个拉丁字母 | `no_letters` |
| 不匹配纯 URL / DOI / 邮箱 / 纯数字与符号：`^(https?://|doi:|www\.)\S+$`、`^[\w.+-]+@[\w-]+\.[\w.]+$`、`^[\d\s.,;:%()\-–/]+$` | `non_text` |
| 不与任何 `imageRect` 重叠面积 > 30% 的段落 bbox（图内文字） | `inside_image` |
| 短段落（去占位符后 < `SHORT_PARAGRAPH_CHARS (40)`）必须满足：`role ∈ {heading, caption, listItem}`，或宽度 ≥ 0.5 × 栏宽，或位于正文流中（上下 2 × lineHeight 内有可翻译的 body 段落） | `short_isolated`（典型：图表坐标轴标签、图例、表格单元格） |
| 不是 `rotated` | `rotated` |
| `role !== 'other'` 或段落字数 ≥ 40 | `unknown_role` |

**表格**：没有表格检测；表格单元格通常是短段落被 `short_isolated` 跳过；多行长单元格会被翻译并覆盖，可能盖住表格线——已知限制，记录在 3.15。

## 3.9 文本规整

`src/main/pdf/analyze/normalize.ts`，对每个可翻译段落的 `text`：

1. 行连接：上一行以 `-` 结尾且下一行以小写字母开头 → 去掉 `-` 直接连接（连字符断词）；以 `-` 结尾但下一行大写 → 保留 `-` 不加空格（复合词）；其他情况用一个空格连接。
2. 连字：`ﬁ→fi ﬂ→fl ﬀ→ff ﬃ→ffi ﬄ→ffl`（pdf.js 通常已还原，仍做一遍）；` ` → 空格；去掉 `​﻿`。
3. 引号、破折号保持原样（交给模型）。
4. 连续空白折叠为一个空格；首尾空白去掉。
5. 占位符前后保证单个空格：` {v1} `，句首/句尾则只一侧。

## 3.10 翻译接口

`translate` 阶段把 `AnalysisResult.paragraphs.filter(translatable)` 映射为 `Segment { id: paragraph.id, text: paragraph.text }`，调用 04 章的 `translateDocument()`，得到 `TranslatedParagraph[]`。**PDF 模式的占位符校验**（04 章 4.9）保证译文里 `{vN}` 集合、次序与原文一致。译文失败保留原文的段落 `kept=true`。

进度：翻译阶段占 30–79，`progress = 30 + 49 × done / total`，每完成一个批次上报一次（节流 250 ms）。

## 3.11 raster（公式贴图）

`src/main/raster/raster-window.ts` + `src/raster/main.ts`：

1. 主进程按需创建隐藏 `BrowserWindow`（首次需要时创建，5 分钟无请求后关闭）。加载 `raster.html`；页面用 `pdfjs-dist` web build（Vite 打包，worker 用 `pdfjs-dist/build/pdf.worker.mjs?url`）。
2. 协议（IPC，`raster:*` 通道只在栅格窗口的 `webContents` 上注册）：
   - 主进程 → 页面：`raster:load { docId, bytes: ArrayBuffer }`（一次一份文档；用 `postMessage` 传 ArrayBuffer 避免拷贝）；`raster:render { page, scale, rects: {key, rect}[] }`；`raster:unload`。
   - 页面 → 主进程：`raster:result { page, images: {key, png: ArrayBuffer, width, height}[] }` 或 `raster:error`。
3. 页面实现：`pdf.getPage(page)`，`viewport = page.getViewport({ scale })`，渲染到 `OffscreenCanvas`（或普通 canvas）；对每个 rect：把用户空间矩形通过 `viewport.convertToViewportRectangle` 转成像素矩形，外扩 1 pt × scale，`ctx.getImageData` 裁剪到新 canvas，`canvas.convertToBlob({type:'image/png'})` → ArrayBuffer。
4. 主进程把 PNG 写到 `work/raster/<paragraphId>#<placeholderId>.png`，路径填入 `ComposeRequest.rasters`。
5. 只为 `translatable && !kept` 段落的占位符出图；`scale = DOCFLOW_RASTER_SCALE ?? settings.pdf.rasterScale (默认 4)`。
6. 超时：每页 30 s；窗口崩溃（`render-process-gone`）→ 重建窗口重试一次 → 仍失败则该阶段错误 `raster_failed`（可重试）。

## 3.12 compose（写回）

`src/main/workers/compose.ts` → `src/main/pdf/compose/*.ts`。

### 3.12.1 准备

1. `PDFDocument.load(sourceBytes, { ignoreEncryption: false, updateMetadata: false })`。
2. `doc.registerFontkit(fontkit)`；`regular = await doc.embedFont(regularBytes, { subset: true })`，`bold` 同理（只在有加粗段落时嵌入）。若 `embedFont` 抛错（fontkit 对该 OTF 子集化失败），回退 `subset: false` 并记 warning；再失败则整个阶段错误 `font_embed_failed`（永久性，提示重装应用）。
3. 按页分组待写段落：`translatable && !kept` 的段落。

### 3.12.2 覆盖

对每个段落：`cover = expand(paragraph.bbox, options.coverPadding /* 1.0 pt */)`，但不超出页面 MediaBox；再从 cover 中**扣除**该段落所有 `formulaLine` 邻居？——不需要，display math 不在段落内。`page.drawRectangle({ x, y, width, height, color: rgb(1,1,1), borderWidth: 0 })`。

背景不是白色时会留白块：4.0 接受。若 `page` 的 `imageRects` 与 cover 重叠 > 10%（图片上的文字段落已在 3.8 跳过，这里只是双保险）→ 不覆盖、不写，记 warning `over_image`。

### 3.12.3 排版译文

`src/main/pdf/compose/layout.ts`，纯函数 `layoutParagraph(text, placeholders, box, style, measure) → LaidOutLine[]`：

- 分词：把译文切成 token：占位符 `{vN}`（宽 = `placeholder.bbox` 宽 × `fontScale`，高同理）、连续拉丁/数字串（`[A-Za-z0-9@#$%&*+\-=/<>'"_.,:;!?()\[\]]+` 不可拆，除非超过行宽）、单个 CJK 字符、单个中文标点、空格。
- 换行：贪心填充，行宽 = `box.width`；避头尾：行首不能是 `，。、；：？！）】》」』〕〉…—`，行尾不能是 `（【《「『〔〈`——违反时把前一个 token 挪到下一行；连续标点挤压：行尾溢出 ≤ 0.5 em 且溢出部分是标点时允许溢出。
- 字号：从 `paragraph.fontSize` 开始；`lineHeight = fontSize × options.lineHeightFactor (1.25)`；若总高度 > `box.height + 0.5 × lineHeight`，字号 `−0.5 pt` 重排，直到 `fontSize ≥ minFontScale (0.6) × 原字号`；仍装不下 → 允许高度溢出到 `box.height + 2 × lineHeight`（下方通常是段间距）；再不行 → 截断不发生，改为**按行数比例压缩行高到 1.05**；最后仍溢出 → 记 warning `overflow` 但照常绘制（宁可略压下一段也不丢译文）。
- 对齐：`justify` → 除末行外把剩余宽度平均加到 token 间距（CJK 字符之间也可加）；`center`/`right` 相应处理；`left` 不处理。
- 首行：不缩进（中文论文译文通常不需要，且原文缩进已由 bbox 体现）。

### 3.12.4 绘制

- 文本：`page.drawText(run, { x, y: baseline, size, font, color: rgb(...paragraph.color) })`；每行拆成若干 run（占位符前后分开）。
- 占位符：`png = await doc.embedPng(bytes)`；目标框宽高 = 原 bbox 尺寸 × `fontScale`（`fontScale = 最终字号 / 原字号`）；垂直位置：`y = baseline + placeholder.baselineOffset × fontScale − (原 bbox 中基线以下部分) × fontScale`，即保持公式相对基线的位置；`page.drawImage(png, { x, y, width, height })`。同一 PNG 只 `embedPng` 一次（按 key 缓存）。
- 段落级 try/catch：任一异常 → 该段落回滚（无法真正回滚已画的矩形，因此顺序是：先排版计算，全部成功后再画矩形与文字；计算失败就整段跳过、不覆盖、warning `layout_failed`）。

### 3.12.5 保存

`monoBytes = await doc.save({ useObjectStreams: true, addDefaultPage: false })` → 写 `work/mono.pdf`（先写临时文件再 rename）。

### 3.12.6 双语

`dual = await PDFDocument.create()`；`orig = await PDFDocument.load(sourceBytes)`；`mono = await PDFDocument.load(monoBytes)`；对 i in pages：`[o] = await dual.copyPages(orig, [i]); dual.addPage(o); [m] = await dual.copyPages(mono, [i]); dual.addPage(m)`。保存到 `work/dual.pdf`。文档元数据：标题 = 原标题 + `（中文）`/`（双语）`。

内存：300 页 PDF 三份文档同时在内存中可能到 1–2 GB；compose worker 用 `resourceLimits: { maxOldGenerationSizeMb: 4096 }`；超过 `MAX_PAGES_SINGLE_PASS (200)` 页时双语版分块生成（每 50 页一批 `copyPages`）并在最后 `save`——pdf-lib 无法流式写，所以只是减少峰值。

超时：compose 阶段 `max(120 s, pages × 2 s)`。

## 3.13 verify

在 analyze worker 里：分别打开 `mono.pdf`、`dual.pdf`：

- `mono.numPages === pages`，`dual.numPages === 2 × pages`；
- 每页尺寸与源页差 ≤ 1 pt；
- 对每个有写入段落的页（从 ComposeResult 得知），`getTextContent` 含至少一个 CJK 字符（`一-鿿`）；不满足的页记入 `translatedPagesWithoutCjk`，> 0 时阶段失败 `verify_failed`（可重试，重试时 compose 会重新执行）。
- 文件大小 > 1 KiB。

## 3.14 worker 协议、超时与错误码

`src/main/pdf/worker-host.ts`：

```ts
type WorkerRequest =
  | { id: number; kind: 'inspect'; path: string }
  | { id: number; kind: 'analyze'; path: string; inspection: PdfInspection }
  | { id: number; kind: 'verify'; monoPath: string; dualPath: string; pages: number; writtenPages: number[] }
  | { id: number; kind: 'compose'; request: ComposeRequest }
type WorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { code: string; message: string; stack?: string } }
  | { id: number; progress: { current: number; total: number } }
```

- 每个文档任务独占一个 analyze worker 与一个 compose worker（按需创建，任务结束 `terminate()`）；取消 = `terminate()`。
- 超时由主进程计时：`inspect 60 s`、`analyze max(120 s, pages × 3 s)`、`compose max(120 s, pages × 2 s)`、`verify 120 s`。超时 → terminate → 错误码 `<stage>_timeout`（可重试，最多 3 次；第 3 次仍超时 → 永久失败，提示「这个 PDF 结构异常，请到 GitHub 提交问题并附上文件」）。
- worker 内所有异常都带 `stack` 回传并写入日志（3.x 的教训：不要隐藏原始异常）。

错误码表（`src/shared/errors.ts`）：

| code | 类型 | 用户提示 |
| --- | --- | --- |
| `pdf_encrypted` | 永久 | 这个 PDF 已加密，请先用其他工具去除密码再翻译。 |
| `pdf_invalid` | 永久 | 文件不是有效的 PDF。 |
| `pdf_empty` | 永久 | PDF 没有页面。 |
| `pdf_too_long` | 永久 | PDF 超过 600 页，请拆分后再翻译。 |
| `page_geometry` | 永久 | PDF 页面尺寸异常，无法处理。 |
| `scanned_pdf` | 永久 | 这个 PDF 没有文本层（可能是扫描件），DocFlow 不支持 OCR。 |
| `no_paragraphs` | 永久 | 没有识别到可翻译的段落。 |
| `font_embed_failed` | 永久 | 内置中文字体无法使用，请重新安装 DocFlow。 |
| `inspect_timeout` / `analyze_timeout` / `compose_timeout` / `verify_timeout` | 可重试 | 处理超时，稍后自动重试。 |
| `raster_failed` | 可重试 | 公式渲染失败，稍后自动重试。 |
| `verify_failed` | 可重试 | 生成的 PDF 未通过校验，稍后自动重试。 |
| `worker_crashed` | 可重试 | 处理进程意外退出，稍后自动重试。 |
| `mostly_untranslated` | 永久 | 有 N 个字符（约占全文 X%）无法翻译，已停止处理。请换一个翻译服务或模型后重新处理。 |

## 3.15 参数表与已知限制

`src/shared/pdf-constants.ts`：

```ts
export const PDF = {
  MAX_PAGES: 600, MIN_TEXT_CHARS_SAMPLE: 200, SAMPLE_PAGES: 8,
  LINE_Y_TOLERANCE: 0.35, LINE_GAP_MAX: 2.5, LINE_SPACE_GAP: 0.12,
  COLUMN_BIN: 10, COLUMN_MIN_SEPARATION: 0.35, COLUMN_MIN_COVERAGE: 0.3, SPAN_MIN_WIDTH: 0.6,
  PARA_GAP_FACTOR: 1.75, PARA_FONT_TOLERANCE: 0.15, PARA_X_OVERLAP: 0.5, PARA_INDENT: 1.0,
  HEADING_FONT_RATIO: 1.15, FOOTNOTE_FONT_RATIO: 0.85, HEADER_FOOTER_BAND: 0.06,
  FORMULA_MATH_CHAR_RATIO: 0.5, SUBSCRIPT_SIZE_RATIO: 0.8, SUBSCRIPT_OFFSET: 0.15, FORMULA_MERGE_GAP: 1.0, DISPLAY_MATH_WIDTH_RATIO: 0.7,
  MIN_PARAGRAPH_CHARS: 2, SHORT_PARAGRAPH_CHARS: 40, IMAGE_OVERLAP_SKIP: 0.3,
  COVER_PADDING: 1.0, LINE_HEIGHT_FACTOR: 1.25, MIN_FONT_SCALE: 0.6, MIN_LINE_HEIGHT_FACTOR: 1.05,
  RASTER_SCALE: 4, RASTER_PAD_PT: 1,
  MAX_PAGES_SINGLE_PASS: 200,
  TIMEOUT_INSPECT_MS: 60_000, TIMEOUT_ANALYZE_BASE_MS: 120_000, TIMEOUT_ANALYZE_PER_PAGE_MS: 3_000,
  TIMEOUT_COMPOSE_BASE_MS: 120_000, TIMEOUT_COMPOSE_PER_PAGE_MS: 2_000, TIMEOUT_VERIFY_MS: 120_000, TIMEOUT_RASTER_PAGE_MS: 30_000,
} as const
```

已知限制（写进 README「已知问题」）：

1. 彩色/图案背景上的段落会出现白色色块。
2. 表格内的长单元格被翻译后可能盖住表格线；短单元格不翻译。
3. 行内公式是位图，放大查看有锯齿。
4. 三栏及以上、复杂浮动排版的阅读顺序可能错乱（只影响翻译上下文，不影响位置）。
5. 页眉页脚、图表轴标签、图例不翻译。
6. 没有 OCR；竖排、从右到左文字不支持。
