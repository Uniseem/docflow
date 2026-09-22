# 09 里程碑与任务清单

> 按顺序执行。勾选即表示「已实现、已验证、已提交」。每个里程碑末尾的「验收」全部满足才能进入下一个。任务编号（M1-3）用于 worklog 与提交信息引用。

## M0 工程骨架

- [x] M0-1 `npm init` 后按 02 章写入 `package.json`（版本 `4.0.0`），`npm install`，提交 `package-lock.json`。
- [x] M0-2 建 02 章列出的全部配置文件：`electron.vite.config.ts`、`tsconfig*.json`、`eslint.config.js`、`.prettierrc.json`、`.prettierignore`、`vitest.config.ts`、`playwright.config.ts`、`.npmrc`。
- [x] M0-3 `src/main/index.ts` 最小主进程（单实例、协议注册占位、创建窗口）；`src/preload/index.ts` 暴露空的 `window.docflow`；`src/renderer/` 最小 React 应用：`globals.css`、`index.html`、`App.tsx` 里放一个 HeroUI `Button`，标题栏拖动区域，深色模式切换按钮。
- [x] M0-4 `scripts/verify-fonts.mjs`（核对 `resources/fonts/README.md` 的 SHA-256）。
- [x] M0-5 `npx heroui-cli@latest agents-md --react --output .heroui-docs/AGENTS.md` 拉取文档（确认 `.heroui-docs/` 被忽略）。
- [x] M0-6 `npm run dev` 能开窗口并显示按钮；`npm run check` 全绿（此时测试可以只有一个占位用例）。
- [x] M0-7 `build/icon.png`（从 `old` 分支取）+ `scripts/make-icons.mjs` 生成 icns/ico；`electron-builder.yml`（07 章）；`npm run dist:dir` 能产出可启动的应用。
- [ ] M0-8 推送后 CI 的 `check` 与 `package` 两个 job 变绿（E2E 先放一个只验证窗口标题为 `DocFlow` 的用例）。

验收：`npm run check`、`npm run dist:dir`、CI 全绿；worklog 记录 electron-vite 多入口/ESM 的实际表现。

## M1 共享层与翻译子系统

- [x] M1-1 `src/shared/types.ts`、`presets.ts`、`constants.ts`、`errors.ts`、`text.ts`（04/05 章 schema 全部落地）+ 单测。
- [x] M1-2 `settings/atomic-write.ts`、`settings/settings.ts`、`settings/host.ts`、`settings/secrets.ts`（safeStorage；单测用注入的假加密器）+ 单测。
- [x] M1-3 `translate/http.ts`（fetch 注入）、`providers.ts`、`request.ts`、`response.ts`、`errors.ts` + 单测。
- [ ] M1-4 `translate/keys.ts`、`pool.ts` + 单测（假时钟）。
- [ ] M1-5 `tests/mock-provider/server.ts`（08.3 全部行为）+ `npm run mock:provider`。
- [ ] M1-6 `translate/batch.ts`、`protect.ts`、`validate.ts`、`cache.ts`、`translate-document.ts`、`fake.ts` + 单测（对 mock 服务跑完 08.4 列出的场景）。
- [ ] M1-7 `log/logger.ts`。

验收：`npm run check` 全绿；单测覆盖率（`src/main/translate`）≥ 85%；worklog。

## M2 PDF 解析

- [ ] M2-1 `scripts/make-fixtures.mjs` 生成 08.2 的全部 fixture 并提交；`tests/fixtures/README.md`。
- [ ] M2-2 `pdf/inspect.ts` + 错误码 + 单测（encrypted/scanned/empty/normal）。
- [ ] M2-3 `pdf/analyze/glyphs.ts`：pdf.js 算子流文字状态机（§3.4，含表单、颜色、图片矩形、编码字节数）+ 单测（用 fixture 核对每个字形的 x/y/size/adv 与 `getTextContent` 的结果一致，容差 0.05 pt）。
- [ ] M2-4 `pdf/analyze/lines.ts`（算子不可拆、竖直重叠规则）、`columns.ts` + 快照单测。
- [ ] M2-5 `pdf/analyze/formula.ts`（pdf2zh 规则 + 放宽）+ 单测（inline-formula、display-math、italic-sentence）。
- [ ] M2-6 `pdf/analyze/paragraphs.ts`（角色、对齐、可翻译判定）、`normalize.ts` + 快照单测。
- [ ] M2-7 表单引用统计（pdf-lib 扫描 `/XObject`，shared 判定）+ 单测（form-wrapped、shared-form fixture）。
- [ ] M2-8 `workers/analyze.ts` + `pdf/worker-host.ts`（协议、超时、取消、崩溃）+ 单测（用一个故意 `while(true)` 的假 worker 验证超时 terminate）。
- [ ] M2-9 `scripts/analyze-pdf.mjs` 调试工具（§3.15）。

验收：所有 fixture 的快照经人工核对合理（worklog 里贴关键数字：段数、可翻译数、公式片段数）；两篇真实论文 `analyze` ≤ 5 s；`npm run check` 全绿。

## M3 PDF 写回

- [ ] M3-1 `pdf/compose/content-lexer.ts`（§3.12.1，含内联图像、字符串转义、字典/数组）+ 单测（把 fixture 的内容流词法分析后原样拼回必须逐字节相等；构造的边角样例）。
- [ ] M3-2 `pdf/compose/content-walker.ts`（§3.12.2 定位状态机、表单递归）+ 单测（每个 show-text 算子的起点与 M2-3 字形记录的首字形坐标一致，容差 0.5 pt）。
- [ ] M3-3 `pdf/compose/fonts.ts`（CJK 嵌入与子集回退；`loadedName → 资源名` 映射：起点匹配 + BaseFont 回退；原字体以 `DFo<n>` 挂到页面字典）+ 单测。
- [ ] M3-4 `pdf/compose/layout.ts`（分词、换行、避头尾、行高/字号缩放、对齐）+ 单测。
- [ ] M3-5 `pdf/compose/emit.ts`（译文 `Tj`、公式片段重绘与合并、颜色、编码字节数）、`rewrite.ts`（删除集合、一致性校验、整页放弃、流写回）、`dual.ts`；`workers/compose.ts` + 集成测试（假翻译）。
- [ ] M3-6 `pdf/verify.ts`（含改写页 `getOperatorList` 可执行）+ 单测。
- [ ] M3-7 集成：每个 fixture → 假翻译 → compose → verify 全部通过；肉眼检查 `two-column`、`inline-formula`、`form-wrapped` 的输出（worklog 附截图路径）；用 `scripts/compose-pdf.mjs` 跑两篇真实论文，记录 `op_mismatch`/`font_unmapped` 数量（目标：0）。

验收：08.4 的 pdf 集成用例全绿；30 页 fixture compose+dual+verify ≤ 15 s；真实论文无 `page_skipped`。

## M4 流水线、文档库、IPC

- [ ] M4-1 `library/manifest.ts`、`events.ts`、`index.ts`、`library.ts`、`export.ts`（fflate ZIP）+ 单测。
- [ ] M4-2 `jobs/scheduler.ts`、`jobs/job.ts`（并发、重试、取消、恢复）+ 单测（假流水线、假时钟）。
- [ ] M4-3 `pipeline/run.ts` 与各 stage 文件，断点续传，事件文案（05.5）。
- [ ] M4-4 `src/shared/ipc.ts` 通道表 + `ipc/register.ts` + `ipc/handlers/*` + `preload/index.ts`（含 `pathsForFiles`）+ `api.d.ts`。
- [ ] M4-5 `app/protocol.ts`（`docflow://`，路径校验单测）、`app/dialogs.ts`、`app/menu.ts`（macOS 菜单：DocFlow/文件/编辑/窗口/帮助，中文）、通知与徽标（05.8）。
- [ ] M4-6 命令行冒烟：`DOCFLOW_FAKE_PROVIDERS=1 npm run dev` 后在 devtools 里 `window.docflow.invoke('documents:create', …)` 把 fixture 跑到完成，`output/` 出现两份 PDF。

验收：冒烟通过；`documents:*` 每个通道有至少一个单测（handler 层，注入假 library/scheduler）；`npm run check` 全绿。

## M5 界面

- [ ] M5-1 `renderer/api/`（类型化 invoke、事件 hooks）、三个 zustand store。
- [ ] M5-2 布局壳：顶栏、侧栏、列表/详情分栏、主题切换、快捷键。
- [ ] M5-3 文档库：行、空状态、搜索、筛选计数、拖放浮层、右键/菜单、删除/取消/重命名对话框。
- [ ] M5-4 新建翻译弹窗（6.3 全部行为）。
- [ ] M5-5 文档详情：头部操作、Tabs、iframe 预览、处理面板（进度、阶段、失败/重试提示）、处理记录（过滤、限量）、文档信息抽屉、导出与 Toast。
- [ ] M5-6 设置：通用、翻译服务（列表 + 详情 + 获取模型 + 检查 + 自定义 + 删除）、网络、高级、关于（检查更新）。
- [ ] M5-7 E2E 七个 spec（08.5）全部通过（本地用 `npm run build && electron-builder --dir` 产物）。
- [ ] M5-8 用真实 DeepSeek Key 跑 5 篇真实论文，肉眼检查，记录问题到 `docs/worklog/` 并修复明显的版面问题。

验收：E2E 全绿；08.6 验收清单前三项通过；截图（浅色、深色各一张文档库与详情）放 `docs/screenshots/`。

## M6 打包与发布

- [ ] M6-1 `scripts/third-party-notices.mjs` + `prebuild`；README 更新为 4.0 的安装与使用说明（含已知限制 3.15）。
- [ ] M6-2 `npm run dist` 在 macOS 与 Windows 各打一次，按 07.7 清单检查。
- [ ] M6-3 打 `v4.0.0-beta.1` 标签，`release.yml` 跑通，从 Release 下载安装验证（macOS 一行命令、Windows 安装器）。
- [ ] M6-4 修复 beta 发现的问题；`CHANGELOG.md` 整理；打 `v4.0.0`。

验收：Release 页有 7 个文件 + `SHA256SUMS.txt`；两平台安装可用。

## M7 收尾

- [ ] M7-1 系统通知、Dock 徽标 / 任务栏进度实测。
- [ ] M7-2 检查更新（GitHub API）与「关于」页。
- [ ] M7-3 无障碍走查：键盘可达、`aria-label`、对比度。
- [ ] M7-4 性能：60 页 fixture 全流程内存曲线（worklog 记录），主进程空闲内存。
- [ ] M7-5 `docs/` 与实现对齐：把执行中所有偏离写回规划；ADR 补齐；README「已知问题」。

## 之后（不在 4.0.0）

- 版面检测模型（可选安装）；MuPDF.js 评估；术语表；多目标语言；签名与公证；自动更新；DOCX 输入。
