# 2026-09-21 仓库重建、规划落地

## 会话 1（Claude，与维护者协作）

### 目标

按维护者要求：① 把 3.x 全部代码移到 `old` 分支并清空 `main`（GitHub 同步）；② 搭标准仓库骨架（AGENTS.md、docs/plan、docs/adr、docs/worklog 等）；③ 写出足够详细的 4.0 规划，让另一个模型能一次性执行完。

### 做了什么

- 同步 GitHub：远端 `main` 曾被改写为中文提交信息的历史并新增了一次 README 精简（`239d554`），本地强制对齐；随后建 `old` 分支指向 `239d554` 并推送。
- `git checkout --orphan` 新建空历史，删除全部旧文件（apps/、engine/、runtime/、.cargo/、旧工作流）。
- 写入骨架：`AGENTS.md`、`CLAUDE.md`、`README.md`、`LICENSE`（MIT 不变）、`CHANGELOG.md`、`.gitignore`、`.gitattributes`、`.editorconfig`、`.nvmrc`、`.github/`（CI 与 Release 工作流，在 `package.json` 出现前自动跳过；issue/PR 模板；发布说明模板）。
- 字体：`resources/fonts/NotoSansSC-{Regular,Bold}.otf`（notofonts/noto-cjk SubsetOTF/SC，OFL），校验和记录在 `resources/fonts/README.md`。
- 文档：`docs/README.md`；7 篇 ADR；`docs/reference/legacy-notes.md`（旧版接口、事件、文案、错误信息与教训）；`docs/plan/` 共 10 篇规划。
- 规划前做过的调研（结论已写进规划）：
  - npm 现状：electron 44.4.3（Node 24.21 / Chrome 152）、electron-vite 5.0.0（peer 只到 vite 7，故 vite 锁 7.3）、`@heroui/react` 3.2.6（需 Tailwind ≥ 4、React ≥ 19、不需要 Provider）、pdfjs-dist 6.3（`legacy/build/pdf.mjs` 仍在，engines node ≥ 22.13）、`@cantoo/pdf-lib` 2.11（pdf-lib 维护分支，原版 2022 年后无更新）、typescript-eslint 8.70 只支持 TS < 6.1，故 TypeScript 锁 5.9。
  - HeroUI 3 文档在 https://heroui.com/docs/react/…，仓库 `heroui-inc/heroui` 的 `v3` 分支 `apps/docs/content/docs/en/react/` 下有 mdx 源码；`npx heroui-cli@latest agents-md --react` 可把文档拉到本地 `.heroui-docs/`。
  - 旧版 3.x 卡死根因（写在 ADR-0003）：BabelDOC 收尾阶段被改成无看门狗的同步调用且警告升级为致命错误。

### 怎么验证的

- 本会话只有文档与配置，无代码；`git status` 干净后提交并强制推送 `main`。

### 没做成 / 坑

- 无。

### 下一步

- 从 `docs/plan/09-milestones.md` 的 M0 开始执行。执行前先 `npx heroui-cli@latest agents-md --react --output .heroui-docs/AGENTS.md`（不要覆盖仓库根的 AGENTS.md），把 HeroUI 文档拉到本地查阅。

## 会话 2（Claude，同日）

### 目标

维护者要求 PDF 处理逻辑参照 [PDFMathTranslate](https://github.com/PDFMathTranslate/PDFMathTranslate)。

### 做了什么

- 读了 pdf2zh 1.x 的 `converter.py`（`receive_layout` 的解析/翻译/排版三段）、`pdfinterp.py`（`ops_base` 重建、表单逆矩阵回写）、`high_level.py`（版面矩阵、字体插入），整理成 `docs/reference/pdfmathtranslate-notes.md`。
- 写回方案从「白色覆盖 + 公式栅格化贴图」改为 pdf2zh 式「内容流改写 + 公式用原字体/原编码重绘」：新增 ADR-0008，废弃 ADR-0006，修订 ADR-0003；`docs/plan/03-pdf-pipeline.md` 整章重写（字形级解析用 pdf.js 算子流 + 自写文字状态机；公式判定照搬 `vflag` 规则并加两处放宽；写回只删被翻译段落的 show-text 算子，其余字节原样保留；§3.17 逐项对照表）。
- 同步修改：02 章（去掉隐藏栅格窗口，目录与配置相应调整）、05 章（去掉 raster 阶段与 `rasterScale` 设置）、06 章（阶段说明、设置项）、08 章（新增 tj-arrays / cid-font / form-wrapped / shared-form / italic-sentence / invisible-text 六个 fixture）、09 章（M2/M3 任务重排）、AGENTS.md、plan/README。
- 核对了 pdf.js 源码：`'`/`"`/`TJ` 都被归一化为 `showText`（数字混在字形数组里），`Tf` 参数是 `loadedName`，Glyph 有 `originalCharCode/unicode/width/isSpace`，填充色被换算成 RGB（数组或 `#rrggbb`）。

### 没做成 / 坑

- 分式横线（路径）随公式搬动没有纳入 4.0.0，写在 03 章已知限制 2。

### 下一步

- 同会话 1：从 M0 开始执行。M2-3 的字形状态机是全流水线的地基，先用 `getTextContent` 交叉验证坐标再往下做。
