# 03 PDF 流水线

> 本章是 4.x 的 PDF 处理规格。**处理逻辑逐函数照搬 [PDFMathTranslate（pdf2zh）1.9.11](https://github.com/PDFMathTranslate/PDFMathTranslate)**（`pdf2zh/high_level.py`、`converter.py`、`pdfinterp.py`、`doclayout.py`、`translator.py`）及其依赖的 pdfminer.six 20250416，移植成 TypeScript，放在 `src/main/pdf/pdf2zh/`。决定与原因见 [ADR-0016](../adr/0016-port-pdfmathtranslate.md)；4.0.0 里自写的行、栏、段规则和「只删被翻译段落」的做法已经废弃（ADR-0008、ADR-0015）。
>
> **修改本章涉及的代码时，先看 pdf2zh 的对应函数，照它改，不加自己的规则。** pdf2zh 做不到或不适用的地方写在 §3.13，改动前先问维护者。
>
> 坐标统一用 pdfminer 的页面空间：以裁剪框左下角为原点（页面 CTM 见 §3.5），单位 pt。

## 3.1 总览与数据流

```
source.pdf
  │ inspect  (worker: analyze)   → PdfInspection                            3–9 %
  │ layout   (worker: analyze)   → PageLayout[]  每页一个 detect 请求          10–25 %
  │ analyze  (worker: analyze)   → AnalysisResult（每个 LTPage/LTFigure 的 sstk 等） 26–29 %
  │ translate(主进程, 04 章)      → TranslatedParagraph[]                     30–79 %
  │ compose  (worker: compose)   → work/mono.pdf, work/dual.pdf              80–89 %
  │ verify   (worker: analyze)   → VerifyResult                              90–93 %
  └ archive  (主进程)             → output/、manifest、清理 work/              94–100 %
```

layout 与 analyze 在界面上都属于「分析」阶段（`stage = 'analyze'`，05 章）。检查点：`work/inspection.json`、`work/layout.json`、`work/analysis.json`（`{ sourceSha256, data }`；读回时再用 zod 校验，旧版本写的检查点形状不对就重新计算，05 章 §5.7）。

与 pdf2zh `translate_stream` / `translate_patch` 的对应：

| pdf2zh                                                        | DocFlow                                                                     |
| ------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `doc_zh[i].get_pixmap()` + `model.predict()` + 版面矩阵 `box` | `pdf2zh/render.ts` + `detect.ts` + `doclayout.ts`（§3.4）                   |
| pdfminer 解释内容流得到 `LTChar` / `LTLine`                   | pdf.js 字形（`analyze/glyphs.ts`）+ `chars.ts` + `unicode.ts`（§3.5、§3.6） |
| `PDFPageInterpreterEx.execute`：`ops_base`、`do_S`、`do_Do`   | `pdf2zh/interp.ts` + `pages.ts`（§3.6）                                     |
| `receive_layout` A 部分（段落与公式）                         | `pdf2zh/parse.ts`（§3.7）                                                   |
| `receive_layout` B 部分（逐段翻译）                           | `pdf2zh/segments.ts` + 04 章                                                |
| `receive_layout` C 部分（排版）+ `obj_patch` 写回             | `pdf2zh/typeset.ts` + `compose/index.ts`（§3.9）                            |
| `doc_en.insert_file(doc_zh)` 交替插页                         | `compose/dual.ts`                                                           |

## 3.2 数据类型

`src/shared/pdf-types.ts`（zod schema + 推导类型）：

```ts
// pdfminer LTChar（descent 视为 0，y0 即基线）
LtChar = { text, x0, y0, x1, y1, size, vertical, fontname, font, code, codeBytes }
//   text: to_unichr 的结果，查不到为 '(cid:N)'；fontname: BaseFont；font: Tf 的资源名
// do_S 交出的独立水平黑线
LtLine = { x0, y0, pts: [[x, y], [x, y]], linewidth }
// converter.Paragraph（pstk 的元素）
Pdf2zhParagraph = { y, x, x0, x1, y0, y1, size, brk }
// 一个 {vN}：var[N]、varl[N]、varf[N]、vlen[N]
Pdf2zhFormula = { chars: LtChar[], lines: LtLine[], fix, len }
// 一页的模型输出（像素坐标，左上原点，按置信度降序）
PageLayout = { width, height, boxes: { name, conf, xyxy }[] }
// 一次 receive_layout：页面本身（formPath ''）或一次表单绘制
LayoutUnit = { id, page, formPath, texts /* sstk */, paragraphs, formulas, lines /* lstk */ }
AnalysisResult = { version: 3, pages, pageSizes, units: LayoutUnit[],
                   stats: { chars, paragraphs, translatable, formulas } }
TranslatedParagraph = { id /* `${unit.id}#${index}` */, text, kept }
ComposeRequest = { sourcePath, monoPath, dualPath, analysis, translations, fonts: { noto } }
ComposeResult = { monoBytes, dualBytes, paragraphsWritten, paragraphsKept,
                  opsRemoved /* 删除的 Tj/TJ/'/" 数 */, runsRedrawn /* 公式数 */, warnings }
```

`LayoutUnit.id`：页面为 `"<页号>"`，表单为 `"<页号>/<formPath>"`；`formPath` 按绘制顺序编号（`'1'`、`'1/2'`），与 pdf.js 的 `paintFormXObjectBegin` 顺序一致。

## 3.3 inspect（检查 PDF）

`src/main/pdf/inspect.ts`（DocFlow 自有，pdf2zh 没有这一步），在 analyze worker 里执行。

1. pdf.js 由 `src/main/pdf/pdfjs.ts` 加载：Node 下用 `pdfjs-dist/legacy/build/pdf.mjs`；加载前 `import './dom-matrix'` 补上 `DOMMatrix`（[ADR-0010](../adr/0010-exclude-pdfjs-native-canvas.md)）。
2. 文件前 5 字节不是 `%PDF-` → `pdf_invalid`；`PasswordException` → `pdf_encrypted`；`InvalidPDFException` → `pdf_invalid`；其他 → `pdf_open`。
3. `numPages === 0` → `pdf_empty`；`> 600` → `pdf_too_long`；页宽或页高 < 50 或 > 14400 pt → `page_geometry`。
4. 抽样页（前 3 页 + 均匀取样，最多 8 页）统计 `renderMode ∉ {3, 7}` 的可见字形，< 200 且平均每页 < 25 → `scanned_pdf`。
5. `info.Title` 去空白后长 3–300、不像文件名时作为标题候选。

超时 60 s → `inspect_timeout`（可重试）。

## 3.4 版面检测（`translate_patch` 前半段）

每页一个 worker 请求 `{ kind: 'detect', path, index, modelPath }`（`pipeline/stages/layout.ts` 逐页发，每页超时 120 s，完成一页报一次进度 `版面检测 i / N 页`）。worker 里：

1. **渲染**（`pdf2zh/render.ts`）：MuPDF.js（`mupdf` 1.3.6，MuPDF 1.25.6 内核，WebAssembly）`page.toPixmap(Matrix.identity, DeviceRGB, alpha = false, showExtras = true)`，与 PyMuPDF `get_pixmap()` 默认参数相同（72 dpi、RGB、白底、画注释）。同一文件在 worker 里只打开一次。
2. **预处理**（`doclayout.ts` `prepareInput`，照 `OnnxModel.resize_and_pad_image` + `predict`）：`imgsz = int(pix.height / 32) × 32`；RGB 反成 BGR（pdf2zh 的 `[:, :, ::-1]`）；`r = min(imgsz/h, imgsz/w)`，`round()` 按 Python 的四舍六入五成双；OpenCV `INTER_LINEAR`（半像素中心、11 位定点）缩放；补边只补到 stride（32）的倍数，值 114，上下左右各一半；转 NCHW、除以 255。
3. **推理**（`detect.ts`）：onnxruntime-web 1.30 的 wasm 后端，`numThreads = min(16, 核数)`，会话在 worker 里缓存；模型 `doclayout_yolo_docstructbench_imgsz1024.onnx`（输入 `images`，输出 `output0` 形状 `[1, 300, 6]` = `x1 y1 x2 y2 conf cls`）。
4. **后处理**（`postprocess`，照 `predict` + `scale_boxes` + `YoloResult`）：保留 `conf > 0.25`（不做 NMS）；`gain = min(新高/原高, 新宽/原宽)`，`pad = round((新 − 原 × gain)/2 − 0.1)`，`(xyxy − pad) / gain` 按 numpy 规则（float64 计算后存回 float32）；按置信度降序稳定排序。类别名（ONNX 元数据）：0 title、1 plain text、2 abandon、3 figure、4 figure_caption、5 table、6 table_caption、7 table_footnote、8 isolate_formula、9 formula_caption。
5. **版面矩阵**（`buildLayoutMap`，照 `translate_patch`）：`w × h` 的整数图全部填 1；非保留类的框按排序后的序号 `i` 填 `i + 2`，保留类（`abandon`、`figure`、`table`、`isolate_formula`、`formula_caption`）随后填 0；框的像素范围 `x0 = clip(int(x0 − 1))`、`y0 = clip(int(h − y1 − 1))`、`x1 = clip(int(x1 + 1))`、`y1 = clip(int(h − y0 + 1))`，切片右开。行号从下往上数，与 pdfminer 坐标一致。

模型文件缺失 → `layout_model_missing`（永久，「版面分析模型缺失，请重新安装 DocFlow。」）。

## 3.5 字符：pdf.js 字形 → pdfminer `LTChar`

pdfminer 的逐字符信息由两部分拼成：

- **字形**（`analyze/glyphs.ts`）：解释 pdf.js 的算子流（`getOperatorList`），按文字状态机得到每个字形的 `trm`（`CTM × Tm × [字号·Th, 0, 0, 字号, 0, rise]`）、编码、字节数、`corners` = `trm` 映射的 `(0,0)` 与 `(w0, 1)` 两点（即 pdfminer 的 `(0, rise)`–`(adv, rise + fontsize)`），以及所在算子序号 `opSeq`、表单路径。
- **转成 `LTChar`**（`chars.ts` `toLtChar`）：两点经页面 CTM 映射后取包围框；`size` = 框高（竖排字体取框宽，pdfminer 20250416 `LTChar`）；`vertical` = 字符矩阵（`trm × 页面 CTM`）的 `a == 0 && d == 0`（pdf2zh 的「垂直字体」判定）；`font` = 该算子 `Tf` 的资源名；`text` 见下。

页面 CTM（`pageCtm`，照 `process_page`）：`/Rotate` 0 → `(1,0,0,1,−x0,−y0)`；90 → `(0,−1,1,0,−y0,x1)`；180 → `(−1,0,0,−1,x1,y1)`；270 → `(0,1,−1,0,y1,−x0)`（裁剪框 `x0 y0 x1 y1`）。LTPage 宽 = 裁剪框两角经 CTM 后的横向距离。

**文字**（`unicode.ts`，照 pdfminer `to_unichr`）：

- 简单字体（Type1、TrueType、Type3）：先查 `/ToUnicode`（`CMapParser` 的 bfchar、bfrange、cidchar、cidrange；UTF-16BE 解码并忽略错误；同一编码已是空格时不被 U+00A0 覆盖），再查编码表：`/Encoding` 为名字时用对应表，为字典时 `BaseEncoding`（默认 StandardEncoding）+ `Differences`，没有 `/Encoding` 时用 StandardEncoding；Type1、TrueType 字体若不在 pdfminer 的度量表（标准 14 字体等），且没有 `/Encoding`、有 `/FontFile`，改用内嵌字体明文头里的 `dup <code> /<name> put`。字形名 → Unicode 用 pdfminer 的 `name2unicode`（Adobe Glyph List、`uniXXXX`、`uXXXX`、`_` 连写、`.` 后缀）。数据表由 pdfminer 生成：`pdf2zh/pdfminer-tables.ts`。
- CID 字体（Type0）：有 `/ToUnicode` 流时按它；`/ToUnicode` 是名字且含 Identity 时按码点；没有 `/ToUnicode` 且 `Adobe-Identity`/`Adobe-UCS`：有 `FontFile2` 时 pdfminer 用 TrueType cmap，我们用 pdf.js 的结果，没有就查不到；其他注册表（Adobe-GB1 等）沿用 pdf.js 的结果（同一套 Adobe 映射）。
- 查不到 → `(cid:N)`（pdf2zh 视为公式）。

**对齐**（`alignTextOps`）：字形的 `opSeq`（pdf.js 算子序号）与原始内容流解释器（§3.6）数到的画字算子，按执行顺序一一对应；数量一致、表单路径一致且 95% 以上的算子起点对得上（紧前没有定位算子的只比基线）时直接采用，否则同一表单内按起点顺序配对。对不上的字形仍参与分段，但没有资源名（公式里不重画，§3.9）。

## 3.6 内容流解释（`pdfinterp.PDFPageInterpreterEx`）

`pdf2zh/interp.ts` 按 pdfminer 的执行语义解释原始内容流（`compose/content-lexer.ts` 分词），分析与写回用同一份代码，结果一致：

- **`ops_base`**（`execute`）：已知算子（pdfminer 有 `do_*` 的）中，去掉所有以 `T` 开头的、`'`、`"`、`EI`（内联图片整体）、`MP`、`DP`、`BMC`、`BDC`、`EMC`；其余保留，且只保留算子实际弹出的操作数（`SC/SCN/sc/scn` 保留全部操作数，`q` 等无参算子只写算子）；未知算子与参数不足的算子跳过。保留的内容照抄原字节，后跟一个空格。
- **`do_S`**：当前路径恰为 `m`、`l` 两段，两点经 CTM 后 y 完全相等，且描边色为黑色时，交给转换器一条 `LTLine`，并在 `ops_base` 里写 `n S`（路径不画）。黑色的判定照 pdfminer：`G 0`、`RG 0 0 0` 算黑；`K 0 0 0 1`（和为 1）、`SC/SCN` 设的颜色（pdf2zh 存的是列表）、从未设置描边色都不算。`s`、`f`、`B`、`b`、`n` 等清空路径。线宽只来自 `w`。
- **状态**：`q/Q` 保存 CTM、线宽、描边色、文字状态；`cm` 为 `mult_matrix(cm, ctm)`。画字算子（`Tj`、`TJ`、`'`、`"`）记下序号、`Tf` 资源名、起点（含 `TJ` 开头的字距数字）。
- **`do_Do`**：表单 XObject 有 `/BBox` 时用新状态递归解释（CTM = `Matrix × CTM`，资源 = 表单自己的 `/Resources`，没有时沿用调用方的），形成一个单元（`LTFigure`，宽度按 pdfminer 把 BBox 当 `(x, y, w, h)` 算）；没有 `/BBox` 时 pdfminer 不解释，我们只数其中的画字算子以便对齐，不产生单元；`Do` 本身留在 `ops_base`。最多嵌套 12 层。

## 3.7 逐字符分段（`receive_layout` A 部分）

`pdf2zh/parse.ts` `parseLayout(items, layoutMap, width)`，items 为一个单元里按内容流顺序排列的 `LTChar` 与 `LTLine`：

- 字符类别 `cls = layout[int(y0)][int(x0)]`（截断、夹在图内）；`•` 强制为 0。
- **公式**（`cur_v`）：`cls == 0`；或同段且已有 > 1 个非空白字符且字号 < 段落字号 × 0.79；或 `vflag`（字体名去掉 `+` 前缀后匹配 `^(CM[^R]|MS.M|XY|MT|BL|RM|EU|LA|RS|LINE|LCIRCLE|TeX-|rsfs|txsy|wasy|stmary|.*Mono|.*Code|.*Ital|.*Sym|.*Math)`，或文字以 `(cid:` 开头，或首字符类别为 Lm/Mn/Sk/Sm/Zl/Zp/Zs（空格除外）或属于 U+0370–U+03FF）；或竖排。公式进行中遇到 `(` 也算公式并计数，计数未清零时的 `)` 算公式并减一。
- **公式结束**：当前字符不是公式、类别变化、或段落已有文字且与上一字符横向距离 > 单元宽度的 1/4。结束时 `sstk` 追加 `{vN}`；若段落此时还是空串（纯公式段），令上一字符类别为 −1，阻止后续字符并入。`vfix`：公式首字符与左侧同段文字的基线差，或公式后第一个同段文字右移时公式首字符与它的基线差。
- **段落**：类别与上一字符不同时开新段 `Paragraph(y0, x0, x0, x0, y0, y1, size, brk=False)`；同段时，`x0 > 上一字符 x1 + 1` 补空格，`x1 < 上一字符 x0` 补空格并标记 `brk`。字号更大的字符、或段落第二个非空白字符（首字母放大）会更新段落字号，并把 `y` 上移字号之差。段落框随每个字符扩展。
- **线条**：公式进行中且类别相同 → 公式线条（随公式搬动），否则 → 全局线条（原位重画）。
- `vlen`（公式宽）= 字符最大 `x1` − 首字符 `x0`。

## 3.8 翻译接口

`pdf2zh/segments.ts`：每个单元的每个 `sstk` 字符串，除空白串与 `^\{v\d+\}$`（纯公式）外都送翻译（converter `worker`），id 为 `${unit.id}#${index}`。请求与提示词见 04 章。未送或翻译失败的段按原文排版。

## 3.9 写回（`receive_layout` C 部分 + `obj_patch`）

`compose/index.ts`（compose worker）：

1. 嵌入字体：`tiro` = pdf-lib 标准字体 Times-Roman（WinAnsiEncoding，不嵌入）；`noto` = 思源宋体（`resources/fonts/SourceHanSerifCN-Regular.ttf`，子集嵌入，失败时完整嵌入，再失败 `font_embed_failed`）。
2. 每页重新跑 §3.6 的解释器，按单元写回：
   - `ops_new` = `pdf2zh/typeset.ts` `typesetUnit`（照 C 部分）：从段落 `(x, y)` 起逐字符前进；字符在 pdfminer 的 Times-Roman WinAnsi 表里映射回自身（0x20–0x7E、0xA1–0xAC、0xAE–0xFF）用 `tiro`（宽 = AFM 宽 × 字号），否则用 `noto`；字体变化、遇到 `{vN}` 或 `x + adv > x1 + 0.1 × 字号` 时把缓冲区写成一段 `/f 字号 Tf 1 0 0 1 x y Tm [<hex>] TJ`；只有 `brk` 为真时才回到 `x0` 换行；行首空格丢弃；`{vN}` 按 `vlen` 前进，公式字符以原资源名、原 `size`、原编码写在 `x + (vch.x0 − 首字符 x0)`、`fix + (vch.y0 − 首字符 y0)`（段首公式不加 `fix`），线宽 < 5 的公式线条一起搬（`ET q 1 0 0 1 x y cm [] 0 d 0 J w w 0 0 m dx dy l S Q BT`）；末尾修饰符类字符（Lm/Mn/Sk）减去其宽度；越界的 `{vN}` 跳过。行高从 1.4（`zh`）起，`(行数) × 字号 × 行高 > 段高` 且行高 ≥ 1 时减 0.05；每段 y = `dy + y − 行号 × 字号 × 行高`。全局线条（线宽 < 5）原位重画。整体 `BT … ET `，数字 6 位小数。
   - 页面：`/Contents` 换成一个新流 `q {ops_base}Q 1 0 0 1 {x0} {y0} cm {ops_new}`（x0、y0 为裁剪框左下角）；页面 `/Resources/Font` 挂上 `tiro`、`noto`。
   - 表单：流内容换成 `q {ops_base}Q {逆 CTM 的 a b c d e f} cm {ops_new}`，字典保留；同一表单被多次绘制时最后一次写入生效；表单自己的 `/Resources/Font` 也挂上两个字体。
3. 标题加「（中文）」保存 `mono.pdf`；需要双语时 `dual.ts` 把原文页与译文页交替合并（标题加「（双语）」）。
4. `writtenPages` = 有段落写入了译文的页（verify 在这些页上找中文）。

warning：`font_unmapped`（公式字符没有资源名，未重画）。

## 3.10 verify

`src/main/pdf/verify.ts`（DocFlow 自有），在 analyze worker 里，输入 `{ monoPath, dualPath, pages, writtenPages }`：页数与原文相同；`writtenPages` 各页 `getOperatorList` 能执行且 `getTextContent` 含 CJK 字符；双语 PDF 为 2 倍页数，逐对比较页面尺寸（只计数）；`mono.pdf` > 1 KiB。否则 `verify_failed`（可重试），文案 `生成的 PDF 未通过校验（<中文原因>），稍后自动重试。`

## 3.11 worker 协议、超时与错误码

`src/main/pdf/worker-host.ts`：

```ts
type WorkerJob =
  | { kind: 'inspect'; path: string }
  | { kind: 'detect'; path: string; index: number; modelPath: string } // → PageLayout
  | { kind: 'analyze'; path: string; layouts: PageLayout[] } // → AnalysisResult
  | {
      kind: 'verify'
      monoPath: string
      dualPath: string | null
      pages: number
      writtenPages: number[]
    }
  | { kind: 'compose'; request: ComposeRequest }
```

analyze、compose 各一个共用线程，空闲 15 s 退出（[ADR-0014](../adr/0014-pdf-workers-exit-when-idle.md)）；取消即终止线程，同线程其他请求在新线程上重发。超时：inspect 60 s、detect 每页 120 s、analyze `max(120 s, 页数 × 3 s)`、compose `max(120 s, 页数 × 2 s)`、verify 120 s，超时 → `<kind>_timeout`（可重试）。

错误码（`src/shared/errors.ts`）：永久——`pdf_encrypted`、`pdf_invalid`、`pdf_empty`、`pdf_too_long`、`page_geometry`、`scanned_pdf`、`no_paragraphs`、`pdf_open`、`font_embed_failed`、`layout_model_missing`、`mostly_untranslated`；可重试——`*_timeout`（含 `detect_timeout`）、`verify_failed`、`worker_crashed`。文案见 05 章。

## 3.12 调试工具

- `npm run analyze -- <pdf>`：版面检测 + 分段，输出 `<名>.analysis.json`（版面框与分析结果）和 `<名>.debug.pdf`（蓝色 = 模型框及类别、绿色 = 待翻译段落、灰色 = 不翻译、红色 = 公式字符）。
- `npm run compose -- <pdf>`：整条流水线，译文用「译」+ 原文，报告写到 `tmp/compose-report.json`。
- 与 pdf2zh 对照：`tests/fixtures/pdf2zh/*.json` 是 pdf2zh 1.9.11 在各样例上的版面框与每个单元的 sstk（由 pdf2zh 实跑导出），单测逐页比对（08 章）。

## 3.13 与 pdf2zh 的差异（只有实现层面，逻辑相同）

| 环节                 | pdf2zh 1.9.11                  | DocFlow                            | 原因                                                      |
| -------------------- | ------------------------------ | ---------------------------------- | --------------------------------------------------------- |
| 页面渲染             | PyMuPDF 1.25.2（MuPDF 1.25.2） | MuPDF.js 1.3.6（MuPDF 1.25.6）     | 最接近的 WebAssembly 版；维护者论文 61 页中 60 页结果相同 |
| 模型推理             | onnxruntime（原生）            | onnxruntime-web（wasm）            | 不引入原生模块；同一输入的输出相同                        |
| 字形                 | pdfminer 解码                  | pdf.js 算子流 + 移植的 `to_unichr` | 复用已有的 pdf.js 解析；矩阵为 float32，坐标约差 1e-5     |
| `"` 算子             | pdfminer 不换行（缺陷）        | 按规范换行                         | 不照搬依赖库的缺陷                                        |
| `ops_base`           | 按 Python `str()` 重新序列化   | 原字节                             | 内容等价，精度不丢                                        |
| 缺资源名的公式字符   | 不会发生                       | 不重画，记 `font_unmapped`         | 避免写出非法算子                                          |
| 表单有资源无 `/Font` | 不挂字体（字画不出）           | 新建 `/Font` 挂上                  | 避免译文不显示                                            |
| 字体子集             | PyMuPDF `subset_fonts`         | pdf-lib 子集                       | 字形编号不同，显示相同                                    |
| 模型与字体获取       | 首次使用时下载                 | 打进安装包                         | 维护者决定，离线可用                                      |

## 3.14 已知问题（pdf2zh 本身的行为）

1. 译文与重画的公式都是默认黑色，原文的彩色标题、链接颜色丢失。
2. 段落只有在原文有换行时才换行：单行的标题、图注译文比原文长时向右溢出。
3. 行高最多降到 1.0 左右，不缩小字号：译文比原文长很多时会压到下面的内容。
4. 空格用了很小字号的字体（例如 6.4 pt 的 `dummy-space`）时，空格被角标规则判成公式，译文词间出现空隙。
5. 斜体、等宽等字体名匹配公式正则的整段文字（如 `Times-Italic`）被当成公式，不翻译。
6. 版面模型判为 figure、table、abandon（页眉页脚）、公式的区域不翻译；模型框不准时段落会被合并或拆开。
7. 内联图片（`BI … EI`）被删除；旋转页、竖排文字全部当公式按正立方向重画。
8. 不可见文字（`Tr 3`，如 OCR 文字层）会被重画成可见；扫描件在 inspect 阶段就被拒绝。

## 3.15 参数表

pdf2zh 的常数写在各移植文件里并注明出处（`0.79`、`width / 4`、`0.1 × size`、`1.4`、`0.05`、`linewidth < 5`、`conf > 0.25`、stride 32、补边 114），不改。DocFlow 自己的参数在 `src/shared/pdf-constants.ts`：`MAX_PAGES 600`、`MIN_TEXT_CHARS_SAMPLE 200`、`SAMPLE_PAGES 8`、`MAX_PAGES_SINGLE_PASS 200`（双语合并分批）、各超时。
