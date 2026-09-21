# ADR-0003：用 TypeScript（pdf.js + pdf-lib）实现 PDF 原生翻译，替代 BabelDOC/Python

- 状态：已采纳
- 日期：2026-09-21
- 相关：docs/plan/03-pdf-pipeline.md、ADR-0006

## 背景

3.x 的原生翻译靠打包一份 CPython 3.12 + BabelDOC 0.6.4 + PyMuPDF + onnxruntime + DocLayout-YOLO 模型（约 1.3 GB），Rust 引擎通过 stdin/stdout JSONL 与 Python 子进程交换段落。问题：

1. **收尾卡死**：BabelDOC 的 `subset_fonts` / `pdf.save` 被我们改成进程内同步调用并去掉了上游 120 s 看门狗，同时把 `pdf_creater` 模块的任何 WARNING 提升为致命错误；病态 PDF 会在 88–89% 挂满 7200 s 或直接失败，而且上游异常文本被刻意隐藏，无法定位。
2. **构建慢**：pip 安装 25 个 wheel、下载并校验几百 MB 离线资源（CDN 会 429）、逐个二进制做 min-OS 扫描与签名，一次构建 30–75 分钟。
3. **许可证**：BabelDOC 与 PyMuPDF 是 AGPL，安装包不再是纯 MIT。
4. **路径限制**：BabelDOC 要求纯 ASCII 路径，Windows 上要把工作目录搬到 `%ProgramData%`。

## 决定

自己实现流水线，全部 TypeScript，运行在 Electron 主进程的 `worker_threads` 里：

- **解析**：`pdfjs-dist` 6（Node legacy build）`getOperatorList()` 的算子流，自己解释文字状态得到逐字形的位置、字号、字体、编码、颜色，再做行合并、段落合并、栏检测、公式片段识别（规则取自 PDFMathTranslate）。
- **写回**（细节见 ADR-0008）：`@cantoo/pdf-lib` 2（pdf-lib 的维护分支）+ `@cantoo/fontkit`：改写页面内容流，删除被翻译段落的文字绘制指令（其余字节原样保留），追加用嵌入 Noto Sans SC 子集排好的译文；行内公式用原字体资源与原编码在新位置重绘。
- **双语版**：pdf-lib `copyPages` 交替复制原页与译页。
- **校验**：输出重新用 pdf.js 打开，核对页数、页面尺寸、译页含有中文。
- **稳健性**：每个阶段有独立超时（worker 可被 `terminate()`），每个段落的写回单独 try/catch（失败保留原文并记 warning），日志保留完整错误堆栈。
- 不使用版面检测模型；图表内的短文本用启发式规则跳过（见 03 章）。

## 备选方案

- **修 BabelDOC 再继续打包 Python**：能缓解 1，解决不了 2、3、4。放弃。
- **MuPDF.js（WASM）**：解析质量更好（自带 block/line 结构、可做真正的文字删除 redaction），但 AGPL，且 1.2x 版本的 JS API 仍在变动。作为将来的备选记录在此；若白底覆盖法在彩色背景上问题突出，再评估。
- **onnxruntime-node + DocLayout-YOLO 做版面检测**：原生模块、模型 40 MB，先不做；接口上给 `analyze` 预留 `regions` 输入，将来可插入。

## 后果

- 好处：零原生依赖，安装包 ~120 MB；构建几分钟；纯 MIT/Apache/OFL；任意路径；错误可定位。
- 代价：没有版面模型，图表内文字、复杂多栏、彩色背景上的段落效果不如 BabelDOC；行内公式变成位图（放大后有锯齿，文件变大）。
- 跟进：收集失败样例到 `tests/fixtures/`；观察是否需要引入版面模型或 MuPDF。
