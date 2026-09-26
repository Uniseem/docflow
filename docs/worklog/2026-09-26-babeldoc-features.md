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

## 会话 1 续（同一会话，发布前）

### 做了什么

- 子代理对照代码改写 02、04–07 章，报告里指出的问题逐条处理：术语抽取阶段的进度改为「抽取术语 X / Y 段」（原来写成「已翻译」且计数加倍）；同一段不再重复逐段重译；字体文件缺失提示重新安装；术语表导入报错不再重复、删除确认文案改正；角色提示词说明跨行导致的中文空格；第三方许可附上 gpt-tokenizer 全文；ADR-0018 的字体数量与体积（15 个，新增约 95 MB 未压缩）。
- `chore: 发布 4.1.0`（d57024c）：`package.json` 4.1.0，CHANGELOG 定版 `[4.1.0] - 2026-09-26` 与比较链接。

### 怎么验证的

- `npm run check`：62 个测试文件、443 个用例全部通过。
- 本机 `dist:dir` 后 E2E 全部 10 个用例通过（6.4 分钟）。
- CI run 36187037672（d57024c）：check、Windows 与 macOS 打包冒烟加 E2E 全部通过。
- release.yml 在分支上 `workflow_dispatch` 演练（run 36187065978，只打包、不发布）：Windows x64、macOS arm64、macOS x64 三个任务都成功；工件 Windows 约 241 MB（压缩后），macOS 每个架构三个文件合计约 830 MB。
- 界面截图目检：设置「高级」各卡片、术语表导入后的列表与提示、新建翻译的页码校验错误与禁用的「开始翻译」。

### 没做成 / 坑

- **没有发布**：仓库规定只从 `main` 的 `v*` 标签发布，而 `main` 还停在 360139c（本分支的祖先，可以快进）。这个会话把 `main` 快进到 d57024c 的推送被权限规则拦下（未经评审合并到 `main`），所以没有推 `main`、也没有打 `v4.1.0` 标签，交给维护者决定。

### 下一步

- 维护者：评审后把本分支合入 `main`（`main` 是 d57024c 的祖先，可以快进），在 d57024c（或合并后的提交）上打 `v4.1.0` 并推送，release.yml 会发布；然后勾选 M10-7，在本文件追加发布结果。
- M10-8 与 M9-6 同上。

### 提交

- `a0c5cd1 fix(translate): 页码范围不含第 1 页时翻译崩溃`
- `7149912 fix(compose): 空白页生成并排双语时报错`
- `afddd8a feat(ui): 新建翻译可填页码，设置里管理术语表与写回选项`
- `4ac07a4 docs: 说明 4.1.0 照搬的 BabelDOC 功能与内置字体许可`
- `1571b2c style(ui): 去掉术语表提示前多余的空格`
- `a4d6a18 fix(translate): 术语抽取的进度单独显示`
- `5435f9f fix(translate): 同一段只逐段重译一次`
- `73a410a fix(compose): 字体文件缺失时提示重新安装`
- `60e4937 fix(ui): 术语表导入报错与删除确认的文案`
- `53b2067 build: 第三方许可附上 gpt-tokenizer 的许可证全文`
- `7a324e6 docs: 02、04–07 章对齐 4.1.0 的实现`
- `d57024c chore: 发布 4.1.0`

## 会话 1 续（发布 4.1.0）

### 做了什么

- 维护者回复「可以推送到 main 并打标签」后，把 `main` 从 360139c 快进到 95ae160（普通推送，不改写历史）。
- 本会话推 `v4.1.0` 标签失败：`git-receive-pack` 返回 HTTP 403，推分支（包括 `main`）正常，代理没有记录失败。按环境说明 403 不重试、不绕过，请维护者在本机推；维护者在 d57024c 上打了 `v4.1.0` 并推送。
- release.yml（run 36216462681）由标签触发，四个任务全部成功：Windows x64 约 5 分钟，macOS x64 与 arm64 各约 3.5 分钟，GitHub Release 不到 1 分钟。

### 怎么验证的

- [Release v4.1.0](https://github.com/Uniseem/docflow/releases/tag/v4.1.0)：正式版（非草稿、非预发布），是 Latest。8 个文件：`DocFlow-4.1.0-win-x64-setup.exe` 240.8 MB；macOS arm64 的 dmg、pkg、zip 各约 276.7–276.9 MB，x64 的各约 280.7–281.0 MB；`SHA256SUMS.txt`。比 4.0.1 大约 45–55 MB，来自新增的字体。
- `SHA256SUMS.txt` 里 7 个安装包的校验和与 GitHub 为每个文件记录的 SHA-256 一致。
- README 的 macOS 一行命令里的查询（`releases/latest` 里找 `-macos-<arch>.pkg`）解析出两个架构的 v4.1.0 pkg 链接；Windows setup、两个 pkg 与 arm64 dmg 的下载链接用范围请求取前 16 字节都返回 206，文件头分别是 `MZ`、`xar!`。（HEAD 请求跟随跳转后得到 401，GET 正常，只是存储端对 HEAD 的限制。）没有在实机上下载安装。
- CI run 36216244736（`main` 上的 95ae160，只比 d57024c 多工作日志）：写这段时 check 与 macOS 打包冒烟加 E2E 已通过，Windows 还在跑（结果见下一条）。

### 没做成 / 坑

- 这个环境里的会话能推分支但推不了标签（HTTP 403）；以后发布，打标签这一步由维护者在本机做。

### 下一步

- M10-8：用真实大模型翻几篇论文目检（需要维护者的 Key）；实机安装 4.1.0（Windows 覆盖安装、macOS 终端命令）。
- M9-6 仍等维护者决定。

### 提交

- `docs: 记录 4.1.0 发布结果`
