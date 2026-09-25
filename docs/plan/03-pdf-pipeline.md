# 03 PDF 流水线

> 本章是 4.x 的 PDF 处理规格。**处理逻辑逐函数照搬 [PDFMathTranslate（pdf2zh）1.9.11](https://github.com/PDFMathTranslate/PDFMathTranslate)**（`pdf2zh/high_level.py`、`converter.py`、`pdfinterp.py`、`doclayout.py`、`translator.py`）及其依赖的 pdfminer.six 20250416，移植成 TypeScript，放在 `src/main/pdf/pdf2zh/`。决定与原因见 [ADR-0016](../adr/0016-port-pdfmathtranslate.md)；4.0.0 里自写的行、栏、段规则和「只删被翻译段落」的做法已经废弃（ADR-0008、ADR-0015）。
>
> pdf2zh 自身的毛病（颜色丢失、单行不换行、不缩字号、小字号空格判成公式、斜体整段当公式、内联图片被删、旋转页错位）按 pdf2zh 的后继项目 **BabelDOC 0.6.4** 的做法修正，排版整体换成 BabelDOC 的 `Typesetting`（`pdf2zh/reflow.ts`），见 [ADR-0017](../adr/0017-babeldoc-fixes.md) 与 §3.13。
>
> **修改本章涉及的代码时，先看 pdf2zh（或上面这几处的 BabelDOC）的对应函数，照它改，不加自己的规则。** 两者都做不到或不适用的地方写在 §3.13、§3.14，改动前先问维护者。
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
| `receive_layout` C 部分（排版）+ `obj_patch` 写回             | `pdf2zh/reflow.ts`（BabelDOC `Typesetting`）+ `compose/index.ts`（§3.9）    |
| `doc_en.insert_file(doc_zh)` 交替插页                         | `compose/dual.ts`                                                           |

## 3.2 数据类型

`src/shared/pdf-types.ts`（zod schema + 推导类型）：

```ts
// pdfminer LTChar（descent 视为 0，y0 即基线）
LtChar = { text, x0, y0, x1, y1, size, vertical, angle, fontname, font, code, codeBytes, gstate }
//   text: to_unichr 的结果，查不到为 '(cid:N)'；fontname: BaseFont；font: Tf 的资源名
//   angle: 字符矩阵的 atan2(b, a)（度）；gstate: 画这个字时生效的颜色/图形状态算子（BabelDOC）
// do_S 交出的独立水平黑线
LtLine = { x0, y0, pts: [[x, y], [x, y]], linewidth }
// converter.Paragraph（pstk 的元素）
Pdf2zhParagraph = { y, x, x0, x1, y0, y1, size, brk, gstate /* 文字字符共同的 gstate，不同为 null */ }
// 一个 {vN}：var[N]、varl[N]、varf[N]、vlen[N]
Pdf2zhFormula = { chars: LtChar[], lines: LtLine[], fix, len }
// 一页的模型输出（像素坐标，左上原点，按置信度降序）
PageLayout = { width, height, boxes: { name, conf, xyxy }[] }
// 一次 receive_layout：页面本身（formPath ''）或一次表单绘制
LayoutUnit = { id, page, formPath, texts /* sstk */, paragraphs, formulas, lines /* lstk */ }
AnalysisResult = { version: 4, pages, pageSizes, units: LayoutUnit[],
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
- **转成 `LTChar`**（`chars.ts` `toLtChar`）：两点经页面 CTM 映射后取包围框；`size` = 框高，竖排字体或字符矩阵 `a == 0`（转了 90° 的字）取框宽（BabelDOC；pdfminer 20250416 只看字体，转过的字会拿到前进宽度）；`vertical` = 字符矩阵（`trm × 页面 CTM`）的 `a == 0 && d == 0`（pdf2zh 的「垂直字体」判定）；`angle` = `atan2(b, a)`（BabelDOC `get_rotation_angle`）；`font` = 该算子 `Tf` 的资源名；`gstate` = 该算子记下的图形状态（§3.6）；`text` 见下。

页面 CTM（`pageCtm`，照 `process_page`）：`/Rotate` 0 → `(1,0,0,1,−x0,−y0)`；90 → `(0,−1,1,0,−y0,x1)`；180 → `(−1,0,0,−1,x1,y1)`；270 → `(0,1,−1,0,y1,−x0)`（裁剪框 `x0 y0 x1 y1`）。LTPage 宽 = 裁剪框两角经 CTM 后的横向距离。

**文字**（`unicode.ts`，照 pdfminer `to_unichr`）：

- 简单字体（Type1、TrueType、Type3）：先查 `/ToUnicode`（`CMapParser` 的 bfchar、bfrange、cidchar、cidrange；UTF-16BE 解码并忽略错误；同一编码已是空格时不被 U+00A0 覆盖），再查编码表：`/Encoding` 为名字时用对应表，为字典时 `BaseEncoding`（默认 StandardEncoding）+ `Differences`，没有 `/Encoding` 时用 StandardEncoding；Type1、TrueType 字体若不在 pdfminer 的度量表（标准 14 字体等），且没有 `/Encoding`、有 `/FontFile`，改用内嵌字体明文头里的 `dup <code> /<name> put`。字形名 → Unicode 用 pdfminer 的 `name2unicode`（Adobe Glyph List、`uniXXXX`、`uXXXX`、`_` 连写、`.` 后缀）。数据表由 pdfminer 生成：`pdf2zh/pdfminer-tables.ts`。
- CID 字体（Type0）：有 `/ToUnicode` 流时按它；`/ToUnicode` 是名字且含 Identity 时按码点；没有 `/ToUnicode` 且 `Adobe-Identity`/`Adobe-UCS`：有 `FontFile2` 时 pdfminer 用 TrueType cmap，我们用 pdf.js 的结果，没有就查不到；其他注册表（Adobe-GB1 等）沿用 pdf.js 的结果（同一套 Adobe 映射）。
- 查不到 → `(cid:N)`（pdf2zh 视为公式）。

**对齐**（`alignTextOps`）：字形的 `opSeq`（pdf.js 算子序号）与原始内容流解释器（§3.6）数到的画字算子，按执行顺序一一对应；数量一致、表单路径一致且 95% 以上的算子起点对得上（紧前没有定位算子的只比基线）时直接采用，否则同一表单内按起点顺序配对。对不上的字形仍参与分段，但没有资源名（公式里不重画，§3.9）。

## 3.6 内容流解释（`pdfinterp.PDFPageInterpreterEx`）

`pdf2zh/interp.ts` 按 pdfminer 的执行语义解释原始内容流（`compose/content-lexer.ts` 分词），分析与写回用同一份代码，结果一致：

- **`ops_base`**（`execute`）：已知算子（pdfminer 有 `do_*` 的）中，去掉所有以 `T` 开头的、`'`、`"`、`MP`、`DP`、`BMC`、`BDC`、`EMC`；其余保留，且只保留算子实际弹出的操作数（`SC/SCN/sc/scn` 保留全部操作数，`q` 等无参算子只写算子）；未知算子与参数不足的算子跳过。保留的内容照抄原字节，后跟一个空格。内联图片（`BI … ID … EI`）整段原样保留（pdf2zh 连同 `EI` 删掉；BabelDOC 保留）。
- **图形状态**（BabelDOC `passthrough_per_char_instruction`）：`sc SC scn SCN g G rg RG k K cs CS gs ri w J j M i d` 执行时，把「操作数 + 算子」的文本记进一个列表：除 `gs` 外，同名算子的旧条目删掉、新条目放到末尾；`gs` 累加，同一个 ExtGState 名重复出现时只留最后一次（每个 `gs` 只设置它自己的键，效果相同，避免列表无限变长）。列表随 `q/Q` 保存恢复，进入表单时清空。每个画字算子记下列表拼成的字符串（`TextOpInfo.gstate`），字符经对齐（§3.5）带上它。
- **`do_S`**：当前路径恰为 `m`、`l` 两段，两点经 CTM 后 y 完全相等，且描边色为黑色时，交给转换器一条 `LTLine`，并在 `ops_base` 里写 `n S`（路径不画）。黑色的判定照 pdfminer：`G 0`、`RG 0 0 0` 算黑；`K 0 0 0 1`（和为 1）、`SC/SCN` 设的颜色（pdf2zh 存的是列表）、从未设置描边色都不算。`s`、`f`、`B`、`b`、`n` 等清空路径。线宽只来自 `w`。
- **状态**：`q/Q` 保存 CTM、线宽、描边色、文字状态、图形状态列表；`cm` 为 `mult_matrix(cm, ctm)`。画字算子（`Tj`、`TJ`、`'`、`"`）记下序号、`Tf` 资源名、起点（含 `TJ` 开头的字距数字）。
- **`do_Do`**：表单 XObject 有 `/BBox` 时用新状态递归解释（CTM = `Matrix × CTM`，资源 = 表单自己的 `/Resources`，没有时沿用调用方的），形成一个单元（`LTFigure`，宽度按 pdfminer 把 BBox 当 `(x, y, w, h)` 算）；没有 `/BBox` 时 pdfminer 不解释，我们只数其中的画字算子以便对齐，不产生单元；`Do` 本身留在 `ops_base`。最多嵌套 12 层。

## 3.7 逐字符分段（`receive_layout` A 部分）

`pdf2zh/parse.ts` `parseLayout(items, layoutMap, width, { strict })`，items 为一个单元里按内容流顺序排列的 `LTChar` 与 `LTLine`。下面是 pdf2zh 的规则；不传 `strict` 时（应用里）有四处换成 BabelDOC 的，列在本节末尾。`strict: true` 只给与 pdf2zh 逐页比对的单测用。

- 字符类别 `cls = layout[int(y0)][int(x0)]`（截断、夹在图内）；`•` 强制为 0。
- **公式**（`cur_v`）：`cls == 0`；或同段且已有 > 1 个非空白字符且字号 < 段落字号 × 0.79；或 `vflag`（字体名去掉 `+` 前缀后匹配 `^(CM[^R]|MS.M|XY|MT|BL|RM|EU|LA|RS|LINE|LCIRCLE|TeX-|rsfs|txsy|wasy|stmary|.*Mono|.*Code|.*Ital|.*Sym|.*Math)`，或文字以 `(cid:` 开头，或首字符类别为 Lm/Mn/Sk/Sm/Zl/Zp/Zs（空格除外）或属于 U+0370–U+03FF）；或竖排。公式进行中遇到 `(` 也算公式并计数，计数未清零时的 `)` 算公式并减一。
- **公式结束**：当前字符不是公式、类别变化、或段落已有文字且与上一字符横向距离 > 单元宽度的 1/4。结束时 `sstk` 追加 `{vN}`；若段落此时还是空串（纯公式段），令上一字符类别为 −1，阻止后续字符并入。`vfix`：公式首字符与左侧同段文字的基线差，或公式后第一个同段文字右移时公式首字符与它的基线差。
- **段落**：类别与上一字符不同时开新段 `Paragraph(y0, x0, x0, x0, y0, y1, size, brk=False)`；同段时，`x0 > 上一字符 x1 + 1` 补空格，`x1 < 上一字符 x0` 补空格并标记 `brk`。字号更大的字符、或段落第二个非空白字符（首字母放大）会更新段落字号，并把 `y` 上移字号之差。段落框随每个字符扩展。
- **线条**：公式进行中且类别相同 → 公式线条（随公式搬动），否则 → 全局线条（原位重画）。
- `vlen`（公式宽）= 字符最大 `x1` − 首字符 `x0`。
- **段落样式**：段落里文字字符（不含公式字符）的 `gstate` 都相同时取它，否则为 `null`（BabelDOC `_merge_styles`）。

BabelDOC 的四条规则（ADR-0017）：

1. **公式字体**：`vflag` 的字体判断换成 BabelDOC `is_formulas_font`：先查已知数学字体（`.*Asana.*`、`.*STIX Math.*`、`.*NewCM.*` 等）→ 公式；再查已知正文字体（`.*Times.*`、`NimbusRomNo9L.*`、`CMTI10.*`、`CMR12.*`、`.*Symbol.*`、`.*Minion.*` 等）→ 不是公式；最后才用宽泛正则 `^(CM[^RB]|(MS|XY|MT|BL|RM|EU|LA|RS)[A-Z]|LINE|LCIRCLE|TeX-|rsfs|txsy|wasy|stmary|.*Mono|.*Code|.*Sym|.*Math|AdvP4C4E74|AdvPSSym|AdvP4C4E59)`（去掉了 `.*Ital`，`CMBX` 粗体不再是公式）。列表原样抄在 `parse.ts`。
2. **空白字符**：文字全由 U+0020、00A0、1680、2000–200A、202F、205F、3000、200B、2060、制表符组成的字符，文字改为 `" "`。
3. **空格与公式**：空格是否算公式只看前一个字符是不是公式（`in_formula_state`），覆盖上面所有判定——小字号空格不再被角标规则判成公式。
4. **空格与段落**：空格落在另一个版面框里时不开新段，跟前面的字符走（`_group_characters_into_paragraphs`）；空格不扩展段落框（BabelDOC 取框前去掉每行首尾空格）。

## 3.8 翻译接口

`pdf2zh/segments.ts`：每个单元的每个 `sstk` 字符串，除空白串与 `^\{v\d+\}$`（纯公式）外都送翻译（converter `worker`），id 为 `${unit.id}#${index}`。请求与提示词见 04 章。未送或翻译失败的段按原文排版。

## 3.9 写回（`receive_layout` C 部分 + `obj_patch`）

`compose/index.ts`（compose worker）：

1. 嵌入字体：`tiro` = pdf-lib 标准字体 Times-Roman（WinAnsiEncoding，不嵌入）；`noto` = 思源宋体（`resources/fonts/SourceHanSerifCN-Regular.ttf`，子集嵌入，失败时完整嵌入，再失败 `font_embed_failed`）。
2. **排版**（`pdf2zh/reflow.ts`，照 BabelDOC 0.6.4 `typesetting.py` 的 `Typesetting` 与 `TypesettingUnit`，套在 pdf2zh 的段落与公式上）：
   - 先算完全部页面的段落文字（译文，没有译文的用原文），每页先按 `fix_overlapping_paragraphs` 把同一个流里上下重叠的两个段落框在重叠中点切开（上框底 = 中点 + 1，下框顶 = 中点 − 1）。
   - 段落框 = pdf2zh 段落的 `(x0, y0, x1, y1)`（pdf2zh 的 `LTChar` 框代替 BabelDOC 的字形墨迹框，所以缩放 1 时首行基线就是原来的）；首行缩进 = 首字符 `x − x0 > 1`，缩进 4 × 半个「你」宽。
   - 排版单元：译文每个字符一个（`tiro`/`noto` 的选择照 pdf2zh；宽 = 该字体前进宽 × 字号，高 = 字号），每个 `{vN}` 一个（框 = 公式字符框的并集）；越界的 `{vN}` 跳过；文字（标记外）只有空白的段落不排版，公式按原位置、原字号重画。
   - 一次排版（`_layout_typesetting_units`，缩放 `s`）：字号 = 文字单元字号的众数；首行基线 = 框顶 − 单元高度众数 × s；逐单元前进，行首空格丢弃；不能断开的字符（`LINE_BREAK_REGEX`：拉丁、希腊、西里尔等字母与数字、`'`、`-`、`·`、`ʻ`）连成的词整体换行（检查时当前单元宽计两次，照原样）；行尾避头标点（`, . : ; ? ! ，。、：；！？”’」』)]}）〕〉】〗］｝》～-–—·・‧/／⁄` 等）可以超出右边，不触发换行；行首避尾标点（`“‘「『([{（〔〈《〖〘〚`）在 `x + 2w > 右边` 时就换行；换行时下移 `max(字号 × s × 1.5, 该行高度众数 × 1.5, 该行最大高度 × 1.05)`，基线低于框底即「放不下」（首行总算放得下）；一行一个单元都放不下时这次排版失败。中英文交界加 0.5 × 空格宽的条件照抄（其中「上一单元顶边与当前基线差 ≤ 行高 + 0.1」在行高为 0 时几乎不成立，照原样）。
   - 找缩放（`_find_optimal_scale_and_layout`）：从初值起，放不下就减 0.05（> 0.6 时）或 0.1；降到 0.7 以下时，先试向下扩框到下方最近段落顶 + 2（没有段落时到 `裁剪框 y × 1.1`），成功就在当前缩放继续试，失败则缩放重置为 1.0；第二次降到 0.7 以下时试向右扩到右侧最近段落左边 − 5（最多 `裁剪框 x2 × 0.9`）；最小 0.1。全都放不下时关掉「整词换行」再找一遍；还不行这一段不画（记 `paragraph_not_fit`，BabelDOC 相同）。
   - 两遍（`preprocess_document` + `render_page`）：第一遍给每段算最佳缩放（扩框不保留）；每段按「单元数」计票（公式按字符数），取出现最多的缩放中最小的一个作为全文上限，大于它的段落都压到它。第二遍逐页：每段若与正下方段落的距离小于 0.5（段高 < 36）或 3，就把段底抬到下方段落顶 + 间距；再以上限为初值排版并画出。
   - 输出：译文字符用段落样式 `gstate`，公式字符用各自的 `gstate`；同一样式的连续字符放进一个 `q {gstate} BT … ET Q`（样式为空时只有 `BT … ET`），同字体、同字号、同基线且紧挨着的字符合成一个 `/f 字号 Tf 1 0 0 1 x y Tm [<hex>] TJ`（BabelDOC 每个字形一个 `Tj`，位置相同）。公式字符按 `x + (vch.x0 − 公式框 x0) × s`、`基线 + (fix + vch.y0 − 首字符 y0) × s`、字号 × s 写，`fix` 只在段内前面有文字时加（照 pdf2zh）；转了 90° 的公式字符（竖排且 `angle` 在 89.9–90.1）写 `0 1 -1 0 x2 y Tm`（BabelDOC）；线宽 < 5 的公式线条一起按比例搬。全局线条（线宽 < 5）原位重画。数字 6 位小数。
3. 每页重新跑 §3.6 的解释器，按单元写回：
   - 页面：`/Contents` 换成一个新流 `q {ops_base}Q {页面 CTM 的逆} cm {ops_new}`，页面 `/Resources/Font` 挂上 `tiro`、`noto`。pdf2zh 这里写 `1 0 0 1 x0 y0 cm`，只在没有 `/Rotate` 时等于页面 CTM 的逆，旋转页的译文会错位；改用 pdf2zh 给表单用的逆 CTM。
   - 表单：流内容换成 `q {ops_base}Q {逆 CTM 的 a b c d e f} cm {ops_new}`，字典保留；同一表单被多次绘制时最后一次写入生效；表单自己的 `/Resources/Font` 也挂上两个字体。
4. 标题加「（中文）」保存 `mono.pdf`；需要双语时 `dual.ts` 把原文页与译文页交替合并（标题加「（双语）」）。
5. `writtenPages` = 有段落写入了译文的页（verify 在这些页上找中文）。

warning：`font_unmapped`（公式字符没有资源名，未重画）；`paragraph_not_fit`（有段落在任何缩放下都放不下，没有画）。

`pdf2zh/typeset.ts`（pdf2zh 原来的 C 部分）保留作参照并有单测，写回不再使用。

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

## 3.13 与 pdf2zh 的差异

按 BabelDOC 0.6.4 修正的部分（ADR-0017）：

| 环节        | pdf2zh 1.9.11                   | DocFlow（照 BabelDOC）                                           |
| ----------- | ------------------------------- | ---------------------------------------------------------------- |
| 颜色        | 不记录，译文与公式都是黑色      | 逐字记图形状态算子，译文用段落共同样式，公式用各自的（§3.6）     |
| 排版        | 原文有换行才换行，行高 1.4→1.0  | 框内重排、整词换行、标点规则、缩字号、扩框、全文统一缩放（§3.9） |
| 公式字体    | `^(CM[^R]\|…\|.*Ital\|…)`       | 数学字体表 → 正文字体表 → 宽泛正则（§3.7）                       |
| 空格        | 可被角标规则判成公式；可开新段  | 只随前一个字符；不开新段、不扩框；各种空白统一为空格（§3.7）     |
| 内联图片    | 删除                            | 原样保留（§3.6）                                                 |
| 转 90° 的字 | `size` 取前进宽，按正立方向重画 | `size` 取框宽，按 `0 1 -1 0` 重画（§3.5、§3.9）                  |
| 旋转页      | 译文按未旋转坐标写，错位        | 用页面 CTM 的逆写回（pdf2zh 表单的做法，§3.9）                   |

实现层面的差异（逻辑相同）：

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

## 3.14 已知问题

pdf2zh 与 BabelDOC 0.6.4 都没有解决、DocFlow 照原样保留的：

1. 版面模型判为 figure、table、abandon（页眉页脚）、公式的区域不翻译；模型框不准时段落会被合并或拆开（BabelDOC 用自己的分段翻译图表内文字，与 pdf2zh 的分段不兼容，没有采用）。
2. 转了 90° 以外角度的字（例如出版社页边 −90° 的下载声明）当公式按正立方向重画（pdf2zh 的行为；BabelDOC 直接丢掉这些字）。
3. 段内颜色不一致（例如带蓝色链接的正文）时译文用默认黑色（BabelDOC 不开富文本占位时相同）；粗体、斜体不保留，译文只有 Times-Roman 与思源宋体两种字体。
4. 分隔竖线、图标等图形留在原位，译文重排后可能与它们交叠。
5. 不可见文字（`Tr 3`，如 OCR 文字层）会被重画成可见；扫描件在 inspect 阶段就被拒绝。
6. BabelDOC 的排版细节原样照抄：第二遍从预算的缩放重新开始且不带第一遍扩出的框，所以实际缩放可能比预算小一档；任何缩放都放不下的段落不画（`paragraph_not_fit`）。

## 3.15 参数表

pdf2zh 的常数写在各移植文件里并注明出处（`0.79`、`width / 4`、`0.1 × size`、`linewidth < 5`、`conf > 0.25`、stride 32、补边 114），不改。BabelDOC 排版的常数在 `reflow.ts`：行距 1.5（中文目标）、缩放步长 0.05/0.1（以 0.6 为界）、扩框阈值 0.7、最小缩放 0.1、下扩 +2、右扩 −5、右边界 `x2 × 0.9`、下边界 `y × 1.1`、段间距 0.5/3（以段高 36 为界）、首行缩进 4 × 半个「你」宽、中英文间隔 0.5 × 空格宽、换行下移 `max(1.5 × 字号, 1.5 × 行高众数, 1.05 × 行最大高)`。DocFlow 自己的参数在 `src/shared/pdf-constants.ts`：`MAX_PAGES 600`、`MIN_TEXT_CHARS_SAMPLE 200`、`SAMPLE_PAGES 8`、`MAX_PAGES_SINGLE_PASS 200`（双语合并分批）、各超时。
