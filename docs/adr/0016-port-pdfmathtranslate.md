# ADR-0016：PDF 处理逐步照搬 PDFMathTranslate 1.9.11（版面模型、删除全部文字、整页重绘、逐段翻译）

- 状态：已采纳（取代 ADR-0008、ADR-0015；修订 ADR-0003 的「不用版面模型」与「不用 MuPDF.js」）
- 日期：2026-09-26
- 相关：docs/plan/03-pdf-pipeline.md（整章重写）、docs/plan/04-translation.md、worklog 2026-09-26-pdf2zh-port、docs/reference/pdfmathtranslate-notes.md

## 背景

4.0.0 发布后，维护者用真实论文（ChemistrySelect 综述，61 页）翻译，得到的中文 PDF 里大量段落的英文原文没有删掉，译文直接叠在原文上。原因是 4.0 只「参照」了 pdf2zh 的思路，在关键环节换成了自己的做法：

- 段落与保留区域用自写的行、栏、段几何规则，而不是 pdf2zh 的 DocLayout-YOLO 版面模型；
- 只删除被翻译段落的文字算子，靠「算子起点落在段落框里」找要删的算子（ADR-0008、ADR-0015）。只要找错或找漏，原文就会留下；
- 排版、字号缩放、颜色、批量翻译请求都是自己设计的。

维护者要求：不要自己设计，照抄 PDFMathTranslate 的逻辑。

## 决定

以 PDFMathTranslate 1.9.11（`pdf2zh/converter.py`、`pdfinterp.py`、`high_level.py`、`doclayout.py`、`translator.py`）以及它依赖的 pdfminer.six 20250416 为准，逐函数移植成 TypeScript，放在 `src/main/pdf/pdf2zh/`，行为保持一致：

1. **版面检测**：每页用 MuPDF 按 72 dpi 渲染（`get_pixmap()`），交给 DocLayout-YOLO-DocStructBench（ONNX，`imgsz = int(高/32)*32`，置信度 > 0.25，BGR 输入、缩放补边与坐标还原照 `OnnxModel`），再按 `translate_patch` 生成逐像素的类别图：默认 1；文本类框依置信度顺序填 `i+2`；`abandon/figure/table/isolate_formula/formula_caption` 填 0。
   - 渲染用 MuPDF.js（`mupdf` 1.3.6，内核 MuPDF 1.25.6，WebAssembly，无原生模块）。pdf2zh 用的 PyMuPDF 1.25.2 内核是 MuPDF 1.25.2，这是能找到的最接近版本。起初改用 pdf.js 渲染：模型输入图不同，61 页里有 8 页多出低置信度的整栏大框，例如参考文献页每栏被并成一段。换成 MuPDF.js 后，61 页中 60 页的段落切分和 pdf2zh 一致。
   - 推理用 onnxruntime-web 1.30（WebAssembly，在分析 worker 线程里跑，最多 16 线程）；拿 pdf2zh 实际喂给模型的那张图测试，输出的框与 pdf2zh 逐个相同。
2. **逐字符分段**（`receive_layout` A 部分）：字符按内容流顺序处理，类别变化即新段；`vflag`（字体正则、Unicode 类别、希腊字母、`(cid:`）、角标 0.79、竖排、括号计数、`vmax`、`vfix`、纯公式段的 `xt_cls = -1`、线条进公式或全局列表，全部照搬。字符的几何与文字按 pdfminer 的 `LTChar`：descent 视为 0，`size` 取框高，文字按 pdfminer 的 `to_unichr` 规则，查不到就是 `(cid:N)`。
3. **删除原文**（`pdfinterp.execute`）：解释原始内容流，去掉所有 `T` 开头算子、`'`、`"`、内联图片、`MP/DP/BMC/BDC/EMC`；独立的两点水平黑色描边线改为 `n S`，交给转换器重画；表单 XObject 递归处理。页面内容换成 `q {ops_base}Q 1 0 0 1 x0 y0 cm {ops_new}`，表单写回 `q {ops_base}Q {逆 CTM} cm {ops_new}`，同一表单多次绘制时最后一次生效。
4. **重绘与排版**（C 部分）：所有字符都重画。译文拉丁字符用 PDF 标准字体 Times-Roman（`tiro`，WinAnsi，不嵌入），其他字符用思源宋体（`noto`，Source Han Serif CN，子集嵌入）；原文有换行（`brk`）才换行，超出 `x1 + 0.1×字号` 时切段；行高 1.4 起每次减 0.05，直到放得下或低于 1；公式用原字体资源名、原字号、原编码按相对位置重画，分式横线一起搬；页面与表单的 `/Font` 里挂上 `tiro`、`noto`。
5. **翻译**：每个段落字符串单独一个请求，只有一条 user 消息，内容是 `BaseTranslator.prompt`（`lang_out` 为 `zh`），空白段和纯公式段不发；回复先 `strip()`、去掉开头的 `<think>` 块、再 `strip()`，不做占位符校验；缓存按原文取值。设置里的「翻译提示词」改为 pdf2zh 的 `string.Template` 模板（`$lang_in`、`$lang_out`、`$text`）；4.0.0 的默认提示词在读取设置时自动换成新默认。
6. **资源**：模型 75.3 MB，不进 git，由 `scripts/fetch-model.mjs` 下载（依次尝试 HuggingFace、hf-mirror、ModelScope，校验 SHA3-256），打包进安装包的 `resources/models`；思源宋体 14 MB 提交在 `resources/fonts`，替换 Noto Sans SC。

### 保留的 DocFlow 部分

以下不属于 pdf2zh 的处理逻辑，按维护者的选择保留：服务商、Key 轮换、重试退避、并发、取消、断点续跑、文档库与界面、`inspect` 检查（加密、扫描件）、`verify` 校验、双语 PDF（原文页、译文页交替，与 pdf2zh 相同）。请求不传 `temperature`（ADR-0011；pdf2zh 的 OpenAI 翻译器传 0）。服务商拒绝回答（`content_filter`）时这一段保留原文并记警告；pdf2zh 会抛异常后无限重试。

### 实现层面的差异（不改变 pdf2zh 的逻辑）

- **字形来源**：取 pdf.js 的算子流逐字形数据，再换算成 pdfminer 的 `LTChar`，不再另写一套 pdfminer 的字体解码。每个字形所属的 `Tf` 资源名，由原始内容流的解释器按算子顺序对齐得到。简单字体的文字按 pdfminer 规则重新计算（ToUnicode → 编码表 → Differences → 内嵌 Type1 自带编码 → `(cid:N)`）；CID 字体里 pdfminer 能查到映射的，沿用 pdf.js 的结果。
- **坐标精度**：pdf.js 算子流里的矩阵是单精度（float32），坐标约有 1e-5 的差，写回后单词位置与 pdf2zh 最大差 0.016 pt。
- **pdfminer 的缺陷不照搬**：`"` 算子不换行（`do__w` 漏了 `T*`），我们沿用 pdf.js 按规范算出的位置；`tj-arrays` 样例因此有一处不同。
- **写回的字节**：`ops_base` 保留原算子及其实际弹出的操作数的原始字节，不按 Python `str()` 重新序列化，内容等价、精度不丢。
- **缺字体的情况**：公式字符对不上 `Tf` 资源名时不重画（记 `font_unmapped`），避免写出非法的 `/ 12 Tf`；表单有 `/Resources` 但没有 `/Font` 时新建一个 `/Font` 挂字体（pdf2zh 不挂，这些字会画不出来）。
- **字体子集**：`noto` 用 pdf-lib 子集嵌入，字形编号与 PyMuPDF 不同，显示一致。

### 随 pdf2zh 一起带来的行为

原文颜色全部丢失，译文和重画的公式都是默认黑色；内联图片被删掉；旋转页（`/Rotate`）的字符按竖排处理，全部当公式重画；不可见文字（`Tr 3`，例如 OCR 文字层）也会被重画成可见；段落只有在原文有换行时才换行，单行段落的译文会向右溢出；空格字体特别小的 PDF，空格会被角标规则判成公式，译文词间出现空隙。

## 备选方案

- **继续修补自写的几何规则与删除集合**：维护者明确要求照抄 pdf2zh。放弃。
- **用 pdf.js 渲染页面**：纯 MIT，但模型输入与 pdf2zh 不同，部分页面结果不一致（见上）。维护者选择 MuPDF.js。
- **把模型下载推迟到首次使用（pdf2zh 的做法）**：维护者选择打进安装包，离线可用。
- **用 onnxruntime-node**：原生模块，违反「不引入原生模块」。onnxruntime-web 在 Node 里即可运行。

## 后果

- 好处：给定同样的版面框，14 个测试样例和维护者的论文与 pdf2zh 逐页一致（`tests/fixtures/pdf2zh/*.json` 为参考结果，单测逐页比对）；不再有原文残留。
- 代价：
  - **许可**：MuPDF.js 是 AGPL-3.0-or-later，打进安装包后，分发的 DocFlow 整体须按 AGPL-3.0 提供源码（仓库本来公开）；仓库里 DocFlow 自己的代码仍按 `LICENSE`（MIT）。移植本身按 pdf2zh 的行为重写，没有复制它的代码。模型权重是 Apache-2.0，思源宋体是 OFL-1.1。
  - **安装包变大**：模型 75 MB、MuPDF.js 约 11 MB、onnxruntime-web 的 wasm 约 14 MB；思源宋体比原来两个字重的 Noto 小约 3 MB。
  - **处理变慢**：版面检测每页约 0.6–1.4 秒（61 页约 1 分钟），pdf2zh 原生 onnxruntime 更快。
  - pdf2zh 自身的局限（颜色、换行、溢出、空格被判成公式等）一并带来。
- 跟进：用真实大模型翻几篇论文，和 pdf2zh 实际输出对照；版面检测速度可以再优化（批量推理、WebGPU）。
