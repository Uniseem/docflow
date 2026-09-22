# AGENTS.md — 给 AI 编码代理的项目说明

> 这份文件是所有代理（Claude Code、Codex、Cursor 等）进入仓库后必须先读的入口。人类贡献者同样适用。

## 项目是什么

DocFlow 是一个 **PDF 论文翻译桌面应用**（Windows + macOS）：用户把带文本层的 PDF 拖进来，应用在本机解析版面、调用用户自己配置的大模型 API 翻译正文，再把译文按原版式写回，生成「中文 PDF」和「双语对照 PDF」。公式、图表、表格保持原样。

- 当前版本线：**4.x**，Electron + React + HeroUI 3，全部 TypeScript，**没有 Python、Rust 或原生模块**。
- 旧版本（3.x，Rust 引擎 + BabelDOC/Python + SwiftUI/WinUI 双客户端）完整保留在 git 分支 **`old`**，只做参考，不再维护。旧版的经验与坑整理在 [docs/reference/legacy-notes.md](docs/reference/legacy-notes.md)。

## 唯一事实来源

| 想知道                                   | 看这里                                                                             |
| ---------------------------------------- | ---------------------------------------------------------------------------------- |
| 要做成什么、按什么顺序做、怎样算做完     | [docs/plan/README.md](docs/plan/README.md)（总览与执行顺序）及 `docs/plan/0x-*.md` |
| 为什么这样设计                           | [docs/adr/](docs/adr/)                                                             |
| 之前的会话做了什么、卡在哪               | [docs/worklog/](docs/worklog/)                                                     |
| 旧版本细节（接口、事件、文案、错误信息） | [docs/reference/legacy-notes.md](docs/reference/legacy-notes.md)                   |

规划文件里已经把能定的都定了（版本号、目录、接口、文案、算法参数）。**执行时不要另起炉灶**；发现规划有错或不可行时，改规划文件并写一条 ADR 或 worklog 说明原因，再继续。

## 工作流程（每个会话都要遵守）

1. **开工前**：读本文件 → `docs/plan/README.md` → `docs/plan/09-milestones.md` 找到第一个未勾选的任务 → 读该任务对应的规划章节 → 看最近一篇 worklog。
2. **做事**：按里程碑顺序推进；一个里程碑内的任务可以并行；跨里程碑不要跳。
3. **验证**：每个里程碑结束前 `npm run check`（typecheck + lint + 单测）必须全绿；涉及界面的改动要真的启动应用看过（`npm run dev`）。
4. **提交**：每个里程碑至少一次 git commit（见下方提交规范）；不要把多个里程碑揉进一个提交。
5. **收工前**：在 `docs/plan/09-milestones.md` 勾选完成项；在 `docs/worklog/` 新建或追加当天的记录（用 `docs/worklog/TEMPLATE.md`）；有新决策就补 ADR；`CHANGELOG.md` 的 Unreleased 段落补一行。

## 技术栈速览（精确版本见 `docs/plan/02-architecture.md`）

Electron 44 · electron-vite 5 (Vite 7) · TypeScript 5.9 · React 19 · `@heroui/react` 3 + `@heroui/styles` · Tailwind CSS 4 · zustand 5 · zod 4 · pdfjs-dist 6（解析）· `@cantoo/pdf-lib` 2（写回）· vitest 5 · Playwright（Electron E2E）· electron-builder 26 · npm（不是 pnpm/yarn）。

## 目录约定

```
src/main/       Electron 主进程：窗口、IPC、设置、文档库、任务调度、翻译、PDF 流水线
src/preload/    contextBridge，只暴露 src/shared/ipc.ts 里声明的通道
src/renderer/   React 界面（HeroUI 3）
src/shared/     主进程与渲染进程共用的类型、zod schema、常量、纯函数
resources/      随应用打包的静态资源（字体、图标）
tests/          单测 fixtures、mock 大模型服务、E2E
docs/           规划、ADR、worklog、参考资料
scripts/        开发/构建辅助脚本（Node，跨平台）
```

## 编码规范

- **语言**：界面文案、文档、提交信息、日志给用户看的部分用简体中文；代码标识符、代码注释、日志的技术字段用英文。
- TypeScript `strict`；不用 `any`（确需时 `unknown` + 收窄）；跨进程的数据都经 zod 校验。
- 主进程不 `import` 渲染进程代码，反之亦然；共享的只放 `src/shared/`。
- 渲染进程 **不能** 用 Node API（`nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`），一切通过 `window.docflow.*`。
- 网络请求只在主进程，只用 Electron `net.fetch`（自动走系统代理）。
- 错误信息要给用户看的，一律中文、说清楚下一步能做什么；技术细节进日志。
- 不引入原生模块（需要编译或平台二进制的 npm 包）；确有必要先写 ADR。
- 不引入 Python/Rust/任何非 Node 工具链；CI 只需要 Node 24 + npm。
- 测试不访问真实网络；大模型用 `tests/mock-provider/` 的本地服务。
- 文件名：`kebab-case.ts`；React 组件文件 `PascalCase.tsx`；测试 `*.test.ts` 与被测文件同目录，或放 `tests/`。

## 提交规范

Conventional Commits，主题用中文，动词开头，不超过 50 字：

```
feat: 新增 PDF 版面分析与段落合并
fix(compose): 行高计算错误导致译文重叠
docs: 补充第 3 里程碑的 worklog
chore: 升级 electron 到 44.4.3
```

类型：`feat` `fix` `refactor` `perf` `test` `docs` `build` `ci` `chore` `style`。作用域可选：`main` `renderer` `pipeline` `translate` `compose` `analyze` `ipc` `ui` `ci`。正文说明「为什么」而不是「改了什么」。提交前必须 `npm run check` 通过。

## 常用命令（`package.json` 建好后生效）

```
npm run dev            # 开发模式启动（热更新）
npm run check          # typecheck + lint + 单元测试，提交前必跑
npm run test           # vitest
npm run test:e2e       # Playwright 驱动打包前的应用
npm run build          # electron-vite 构建到 out/
npm run dist           # electron-builder 打当前平台安装包到 release/
npm run mock:provider  # 启动本地 mock 大模型服务（端口 38111）
```

## 禁止事项

- 不要在 `main` 之外的分支名上做发布；发布只由 `v*` 标签触发。
- 不要提交 `node_modules/`、`out/`、`release/`、`.heroui-docs/`、任何 API Key。
- 不要修改 `LICENSE`。
- 不要删除或改写 `docs/worklog/` 里已有的记录（只能追加）。
- 不要为了让测试通过而放宽 zod schema 或删测试。
