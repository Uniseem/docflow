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
