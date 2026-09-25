# 2026-09-26 照搬后继版本的其余优点（4.1.0）

## 会话 1（Claude Code / Opus 5.5，云端 Linux 容器，9 月 26 日）

### 目标

维护者要求「继续完成，并且把后继版本的优点也都搞过来，之后发布」。后继版本指 PDFMathTranslate-next 2.9.0 与它的引擎 BabelDOC 0.6.4（PyPI 上的最新版）。ADR-0017 已经搬了排版与颜色，这次把其余优点搬过来：M10-1 到 M10-7（09 章），决定见 ADR-0018。

### 做了什么

- **参照**：从 PyPI 下载 `babeldoc-0.6.4` 与 `pdf2zh_next-2.9.0` 的 wheel 解到临时目录，逐行读了 `il_translator_llm_only.py`、`il_translator.py`、`automatic_term_extraction.py`、`glossary.py`、`styles_and_formulas.py`、`font_mapper.py`、`pdf_creater.py`（双语、书签、OCR 白底）、`detect_scanned_file.py`、`raster_geometry.py`、`translation_config.py`、pdf2zh-next 的 `config/model.py`。提示词模板用 Python 导出 JSON 后生成 `templates.ts`，逐字比对过。
- **分析 v5**（M10-1）：`parse.ts` 在 pdf2zh 分段之外记下每段的组成（字符、样式序号、虚空格、公式序号）与版面类别、版面框；`font-flags.ts` 用 MuPDF.js 读嵌入字体的粗体/斜体/等宽/衬线（没嵌入的按 Noto Serif Regular）。
- **翻译**（M10-2，`src/main/translate/babeldoc/`）：BabelDOC 的多段 JSON 请求（跨页、跨栏成对，每页约 200 token 或 6 段一批）、逐段回退、译文检查、标题上下文、占位符（公式 `{vN}`、样式 `<style id='N'>`）、o200k token 计数（`gpt-tokenizer`）、缓存按整条提示词。`translate-document.ts` 重写；设置里的提示词改为 BabelDOC 的角色行，4.0.x 的模板自动清空。
- **术语表**（M10-3）：自动术语抽取（默认开）、用户 CSV 术语表（导入、启用、删除，存在文档库 `glossaries/`）、`output/glossary.csv` 与导出。
- **写回**（M10-4）：`npm run assets` 下载 BabelDOC 的 14 个字体（SHA3 校验，CI 缓存），`FontMapper` 照搬，样式片段按原字体属性挑字体，没翻译的片段用原字形原样画，OCR 白底黑字。
- **输出**（M10-5）：双语默认左右并排（可交替、可译文在前），书签迁移，页码范围与「只输出这些页」。
- **扫描件**（M10-6，`src/main/pdf/scanned.ts`）：inspect 把不可见文字也算进「文字太少」的判定；版面检测前照 `DetectScannedFile` 比较 72 dpi 渲染与去掉文字后的渲染（SSIM），扫描件在设置打开时白底黑字，否则报 `scanned_with_text`。新 fixture `ocr-scan.pdf`（3 页文字图片 + `3 Tr` 文字层；`npm run fixtures -- ocr-scan.pdf` 可单独生成）。
- **界面**：设置「高级」加翻译、术语表、角色提示词、PDF 写回各项；新建翻译加页码范围与「只包含这些页」；详情的导出菜单加「术语表（CSV）…」。
- **文档**：ADR-0018，03、08 章与 fixture 说明，README、CHANGELOG、字体 README 与 OFL 版权行、第三方许可；02、04–07 章由子代理对照代码更新。

### 怎么验证的

- `npm run check`：全部通过（见提交前的输出）。
- SSIM 与灰度：同一对图像与 skimage 0.26 的 `structural_similarity` 差 1e-14；灰度与 PyMuPDF 渲染 + OpenCV `COLOR_RGB2GRAY` 逐像素相同。
- 扫描件判定：`ocr-scan.pdf` 3/3 页判为扫描页（SSIM 1.000）；两栏、`long.pdf`、`shared-form.pdf`、两篇 arXiv 论文都不是。
- OCR 白底黑字：`ocr-scan.pdf` 写回后渲染目检，图片里的英文被白底盖住，译文黑色。
- E2E（本机 Linux：`dist:dir` 后在 xvfb 与 gnome-keyring 下跑打包的应用）：新增 `babeldoc.spec.ts` 两个用例（术语表导入与导出、页码范围与并排双语的页数页宽；扫描件先报错、打开设置后完成）。

### 没做成 / 坑

- **只照搬会误判**：BabelDOC 的 SSIM 判定对字少的普通页也 > 0.95（Letter 页一段字 0.964），`long.pdf` 会被当成扫描件，这就是 pdf2zh-next 用户常见的「Scanned PDF detected」。多加了「图片覆盖页面一半以上」一条（ADR-0018 §5）。
- **打包失败**：o200k 分词表里有 `" import"` 这样的字符串，和用到 `__dirname` 的代码在同一个块时，electron-vite 的 CommonJS 垫片按正则把它当成 import 语句，把垫片插进字符串中间。分词表单独成块（`manualChunks`）。单测不打包，只有 CI 的打包冒烟发现了它——以后改依赖后先本地 `npm run build`。
- **页码范围从第 2 页起就崩**：`byPage` 用 `Array.prototype.map` 补空页，但 `map` 跳过稀疏数组的空位，第 1 页不在范围里时 `pages[0]` 仍是 `undefined`。E2E 发现，改为 `Array.from` 并加了单测。
- **空白页做不了并排双语**：pdf-lib 的 `embedPage` 遇到没有 `/Contents` 的页（合法的空白页）会抛错；这种页不画。单测发现。
- **本机跑 E2E**：Linux 上 `safeStorage` 需要 Secret Service。装 `gnome-keyring`，在 `~/.local/share/keyrings/` 放一个明文的 `login.keyring`，用 `dbus-run-session` 起守护进程，可执行文件包一层 `--password-store=gnome-libsecret`。只用于本机，Linux 不是发布平台。
- 缓存命中事件改为「缓存命中 N 个请求」（缓存按请求），`cancel-retry`、`restart` 两个 E2E 与 08 章跟着改。

### 下一步

- M10-8：用真实大模型翻几篇论文目检（需要维护者的 Key）。
- M9-6 仍等维护者决定。

### 提交

- `17b9ef7 feat: 照搬 BabelDOC 的批量翻译、术语表与富文本写回`
- `ed2cebc feat(pipeline): 照 BabelDOC 判定带 OCR 文字层的扫描件`
- `5918f07 build: 分词表单独成块，修复主进程打包失败`
