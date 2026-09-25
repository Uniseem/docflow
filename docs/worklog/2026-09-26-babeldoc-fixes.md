# 2026-09-26 按 BabelDOC 0.6.4 修正 pdf2zh 自身的问题

## 会话 1（Claude Code / Opus 5.5，Windows 机器，9 月 26 日）

### 目标

4.0.1 发布后，维护者要求「修复 pdf2zh 的毛病」：README 已知问题里的颜色丢失、单行不换行、不缩字号、小字号空格判成公式、斜体整段当公式、内联图片被删、旋转页错位。对应 M9（09 章），决定见 ADR-0017。

### 做了什么

- **参照**：BabelDOC 0.6.4 装在开发机的 Python 3.13（`site-packages/babeldoc/format/pdf/`），逐行读了 `typesetting.py`、`styles_and_formulas.py`、`formular_helper.py`、`paragraph_finder.py`、`il_creater_active.py`、`pdf_creater.py`。只搬针对这些问题的部分，接在 pdf2zh 的段落与公式上；pdf2zh 的分段不换。
- **解释器**（`interp.ts`）：画字算子记下当时的颜色与图形状态算子列表（`TextOpInfo.gstate`）；内联图片原样留在 `ops_base`。
- **字符**（`chars.ts`）：`size` 对 `matrix[0] == 0` 的字取框宽；新增 `angle`、`gstate`。
- **分段**（`parse.ts`）：BabelDOC 的公式字体表、空白统一、空格只随前一字符、空格不开新段不扩框；段落 `gstate`；`strict` 选项保留 pdf2zh 规则。`analyzePdf` 透传选项，结果版本升到 4。
- **排版**（新文件 `reflow.ts`）：移植 BabelDOC 的 `Typesetting`、`TypesettingUnit`、`fix_overlapping_paragraphs`；`compose/index.ts` 先算全文段落再逐页画；页面前缀改为页面 CTM 的逆；新 warning `paragraph_not_fit`（`run.ts` 有中文文案）。
- **测试**：新增 `reflow.test.ts`（12 个）；parse、interp、chars 补 BabelDOC 规则的用例；compose 新增颜色与旋转页（`/Rotate 90`、内联图片）两个用例；pdf2zh 逐页比对改用 `strict: true`。两个旧用例按新行为改了预期：内联图片保留、页面内容允许 `q {状态} BT`。
- **文档**：ADR-0017；03 章 §3.1、§3.2、§3.5–§3.9、§3.13–§3.15；05 章 warning 文案；09 章 M9；README 介绍与已知问题；CHANGELOG Unreleased。

### 怎么验证的

- `npm run check`：56 个测试文件、375 个用例全部通过。
- **维护者论文**（61 页，缓存的 MuPDF 版面框，`tmp/paper-run.ts`，假译文按每个英文字母 0.3 个汉字生成）：分析 11 s，写回 5–9 s，无 warning；目检第 1、2、5、20、40、55 页：没有叠字，单行标题与图注在框内换行，摘要在灰框内，参考文献页正常。公式组 1890 个（`strict` 下空格被判成公式，数量大得多）。
- **旋转页**（`tmp/rotate-test.ts`，`/Rotate 90`、转着画的正文、红蓝两色）：译文正立、位置与原文一致、颜色保留。
- `dist:dir` 后 E2E（隐藏窗口）8 个全部通过，用时 3.5 分钟。

### 没做成 / 坑

- **gs 累加**：维护者论文每次画图都重复 `/GS4 gs /GS3 gs`，照 BabelDOC 累加后每段状态有几千字节。改为同名 `gs` 只留最后一次（效果相同），ADR-0017 写明。
- **Keywords 行叠在 Received 行上**：pdf2zh 本身的分段问题——「Accepted: 9 June 2026」后面的两个空格落在模型框外，开了一个新段并一直延伸到下一行。按 BabelDOC「空格不在别的版面框开新段」改掉后正常。
- **BabelDOC 的排版细节照原样**：第二遍从预算缩放重新开始且不带第一遍扩出的框，所以单行标题预算 0.7、实际画 0.65（`reflow.test.ts` 第一个用例写明）；中英文间隔的条件在行高为 0 时几乎不成立。
- **页边竖排文字**（Wiley 的 −90° 下载声明）仍按正立方向重画：pdf2zh 如此，BabelDOC 直接丢掉，按原角度重画是自己的做法，没做，留给维护者决定（M9-6）。
- **分隔竖线**（作者行、章节号后的 `|`）是图形，留在原位，译文重排后会与之交叠；pdf2zh、BabelDOC 相同。

### 下一步

- 维护者决定旋转字的处理（M9-6）；真实大模型对照（M8-7）。
- 这次改动未发版；发版前在应用里用真实服务商翻一篇论文目检。

### 提交

- `feat(compose): 按 BabelDOC 修正 pdf2zh 的排版与颜色`
- `docs: 记录按 BabelDOC 修正 pdf2zh 的决定与规格`
