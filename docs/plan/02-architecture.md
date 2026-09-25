# 02 架构与工程

## 2.1 进程模型

```
┌──────────────────────────── Electron 应用 ────────────────────────────┐
│                                                                        │
│  主进程 (Node 24)  src/main/                                           │
│  ├─ index.ts    单实例锁、主窗口、应用事件（启动顺序见 2.5）             │
│  ├─ app/        AppSession（启动、换库、代理）、菜单、docflow:// 协议、通知 │
│  ├─ ipc/        ipcMain.handle 注册表（每个通道一个函数，zod 校验入参）   │
│  ├─ settings/   settings.json、host.json、secrets.bin(safeStorage)      │
│  ├─ library/    文档目录、manifest、events.jsonl、内存索引、导出        │
│  ├─ jobs/       调度器：队列、并发、重试、取消、断点恢复                 │
│  ├─ pipeline/   一个文档的处理流程：inspect→analyze→translate→compose… │
│  ├─ translate/  服务商、请求、错误分类、密钥轮换、并发池、缓存；         │
│  │              babeldoc/：BabelDOC 的批量翻译、占位符、术语表          │
│  ├─ pdf/        worker 桥（超时、取消、空闲退出）+ 解析/写回的纯函数     │
│  └─ log/        electron-log 配置                                       │
│        │ worker_threads (纯 CPU，无 Electron API)                        │
│        ▼                                                                │
│  src/main/workers/analyze.ts   inspect、scan（扫描件判定）、detect（版面检测）、│
│                                analyze（分段与公式）、verify            │
│  src/main/workers/compose.ts   内容流改写 + 译文排版 + 公式重绘 + 双语   │
│                                                                        │
│  主窗口 renderer  src/renderer/  React 19 + HeroUI 3                   │
│     sandbox、contextIsolation；只通过 window.docflow (preload) 通信      │
│     PDF 预览：<iframe src="docflow://library/…pdf">（Chromium 内置查看器）│
└────────────────────────────────────────────────────────────────────────┘
```

要点：

- **翻译请求在主进程**（需要 `net.fetch`，worker 里没有）；**CPU 密集的解析与写回在 worker**（可 `terminate()` 实现硬超时）。
- 两个 worker（analyze、compose）各由一个 `PdfWorkerHost`（`pdf/worker-host.ts`）管理：按需启动，连续的阶段复用同一线程；最后一个请求结束 15 s（`WORKER_IDLE_MS`）后终止线程，把 pdf.js 缓存与中文字体占用的堆还给系统。（实现与原规划不同：原规划 worker 常驻；实测连续处理多份文档后主进程 RSS 停在 650–900 MB，见 [ADR-0014](../adr/0014-pdf-workers-exit-when-idle.md)、worklog 2026-09-23-m5-fixes。）
- 一个文档任务 = 主进程里的一个 async 函数，按阶段调用 worker / 翻译池，写事件到 `events.jsonl` 并通过 `webContents.send` 推给渲染进程。
- 渲染进程没有 Node、没有网络；预览 PDF 通过自定义协议 `docflow://` 读文档库里的文件（主进程校验路径不越界）。
- 没有隐藏窗口、没有第二个渲染进程：PDF 相关的一切都在主进程与 worker 里完成（ADR-0008）。

## 2.2 目录结构

```
docflow/
├─ AGENTS.md  CLAUDE.md  README.md  LICENSE  CHANGELOG.md
├─ package.json  package-lock.json  .nvmrc  .npmrc
├─ electron.vite.config.ts  electron-builder.yml
├─ tsconfig.json  tsconfig.node.json  tsconfig.web.json
├─ eslint.config.js  .prettierrc.json  .prettierignore
├─ vitest.config.ts  playwright.config.ts
├─ build/                         # electron-builder 用的图标与安装器资源
│  ├─ icon.icns  icon.ico  icon.png (1024)
├─ resources/                     # extraResources，运行时通过 process.resourcesPath 访问
│  ├─ fonts/*.ttf  LICENSE-OFL.txt  README.md   # BabelDOC 的 15 个字体（src/main/pdf/babeldoc/fonts.json）；
│  │                              # 只有 SourceHanSerifCN-Regular.ttf 进 git，其余 npm run assets 下载
│  └─ models/doclayout_yolo_docstructbench_imgsz1024.onnx   # 75 MB，不进 git，npm run assets 下载
├─ scripts/
│  ├─ verify-fonts.mjs            # 按 fonts.json 核对全部字体的 SHA3-256（npm run check 的第一步）
│  ├─ fetch-assets.mjs            # 下载版面模型与字体并校验 SHA3-256（predev、prebuild 自动运行）
│  ├─ make-icons.mjs              # 由 build/icon.png 生成 icns/ico（png2icons）
│  ├─ make-fixtures.mjs           # 生成 tests/fixtures/*.pdf（用 pdf-lib）
│  ├─ analyze-pdf.mjs             # 调试：版面检测 + 分段，输出 analysis.json 与画框的调试 PDF（03 章 §3.12）
│  ├─ compose-pdf.mjs             # 调试：假翻译跑完整写回
│  ├─ third-party-notices.mjs     # 生成 THIRD_PARTY_NOTICES.md（生成物，已 gitignore）
│  └─ bundled-deps.json           # 打进渲染进程 bundle 的包名清单，供上一个脚本列许可（07.3）
├─ src/
│  ├─ shared/                     # 主/渲染共用；不得 import electron 或 node
│  │  ├─ ipc.ts                   # 通道名常量 + 每个通道的请求/响应 zod schema + 类型
│  │  ├─ types.ts                 # Document、ProcessingEvent、Settings、Provider… 的 zod schema 与类型
│  │  ├─ view.ts                  # 设置视图类型（服务商带 keyConfigured 等只读字段）
│  │  ├─ pdf-types.ts             # Glyph、LtChar、LayoutUnit、AnalysisResult… （03 章 §3.2）
│  │  ├─ pdf-constants.ts         # DocFlow 自己的页数上限与超时（03 章 §3.15）
│  │  ├─ presets.ts               # 服务商预设表
│  │  ├─ provider-url.ts          # 按接口类型拼请求地址
│  │  ├─ library-filter.ts        # 文档库筛选与状态分组
│  │  ├─ constants.ts             # 其他限制值（并发上限、字符上限…）
│  │  ├─ text.ts                  # 纯函数：文件名清理、相对时间、字节格式化
│  │  ├─ pages.ts                 # 页码范围（BabelDOC parse_pages），界面与主进程共用
│  │  └─ errors.ts                # UserError / PermanentError 等错误类与错误码
│  ├─ main/
│  │  ├─ index.ts                 # 入口：协议注册、单实例、主窗口、启动顺序（见 2.5）
│  │  ├─ app/session.ts           # AppSession：启动、打开/切换文档库、代理、推送、检查更新
│  │  ├─ app/menu.ts  app/install-menu.ts  app/protocol.ts  app/dialogs.ts  app/notifications.ts
│  │  ├─ app/proxy.ts  app/window-state.ts   # 代理设置转换；窗口尺寸与位置的恢复
│  │  ├─ ipc/register.ts          # 把 handlers 表注册到 ipcMain，统一 zod 校验与错误转换
│  │  ├─ ipc/handlers.ts          # 所有通道的处理函数（一个文件）
│  │  ├─ settings/settings.ts  settings/secrets.ts  settings/host.ts  settings/atomic-write.ts  settings/view.ts
│  │  ├─ library/library.ts  library/manifest.ts  library/events.ts  library/export.ts  library/index.ts
│  │  ├─ jobs/scheduler.ts  jobs/job.ts
│  │  ├─ pipeline/run.ts          # 阶段编排
│  │  ├─ pipeline/hooks.ts        # 把 worker、翻译池、设置接到各阶段
│  │  ├─ pipeline/stages/inspect.ts  layout.ts  analyze.ts  translate.ts  compose.ts  verify.ts  archive.ts
│  │  ├─ pdf/worker-host.ts       # spawn worker、超时、取消、空闲退出、typed messages
│  │  ├─ pdf/pdfjs.ts             # 加载 pdf.js legacy 构建（先 import dom-matrix.ts）
│  │  ├─ pdf/dom-matrix.ts        # 纯 JS 的 DOMMatrix，替代 pdf.js 的可选原生依赖（ADR-0010）
│  │  ├─ pdf/load-pdf-lib.ts      # 加载 pdf-lib 前把间接 /Length 改写为数字
│  │  ├─ pdf/inspect.ts  pdf/verify.ts  pdf/analyze.ts（分析入口）
│  │  ├─ pdf/scanned.ts           # BabelDOC DetectScannedFile：带 OCR 文字层的扫描件判定（ADR-0018）
│  │  ├─ pdf/analyze/glyphs.ts    # pdf.js 算子流 → 逐字形
│  │  ├─ pdf/pdf2zh/              # PDFMathTranslate 1.9.11 的移植（03 章，ADR-0016）
│  │  │  ├─ render.ts detect.ts doclayout.ts   # MuPDF.js 渲染 + DocLayout-YOLO + 版面矩阵
│  │  │  ├─ interp.ts pages.ts                  # pdfinterp：ops_base、do_S、do_Do
│  │  │  ├─ chars.ts unicode.ts pdfminer-tables.ts  # LTChar、to_unichr
│  │  │  ├─ parse.ts segments.ts typeset.ts     # receive_layout A、B；C（只作参照）
│  │  │  ├─ reflow.ts                           # BabelDOC Typesetting（实际使用的排版，ADR-0017）
│  │  │  └─ font-flags.ts                       # 原字体的粗体/斜体/等宽/衬线（MuPDF.js）
│  │  ├─ pdf/babeldoc/            # BabelDOC 的字体：fonts.json（文件、属性、SHA3-256）、fonts.ts、
│  │  │                           # fontmap.ts（FontMapper）、font-set.ts（按需加载、查字形与宽度）
│  │  ├─ pdf/compose/index.ts  content-lexer.ts  streams.ts  dual.ts  outline.ts（书签迁移）
│  │  ├─ workers/analyze.ts  workers/compose.ts   # worker 入口（薄封装，调用 pdf/ 下纯函数）
│  │  ├─ translate/providers.ts  request.ts  response.ts  errors.ts  keys.ts  pool.ts
│  │  ├─ translate/translate-document.ts  cache.ts  fake.ts
│  │  ├─ translate/babeldoc/      # BabelDOC 0.6.4 的翻译（04 章 §4.9–§4.15，ADR-0018）：paragraphs.ts
│  │  │                           # translator.ts prompts.ts templates.ts placeholders.ts glossary.ts terms.ts text.ts
│  │  ├─ translate/http.ts        # fetch 注入：生产用 net.fetch，测试用 Node fetch
│  │  └─ log/logger.ts
│  ├─ preload/index.ts            # contextBridge.exposeInMainWorld('docflow', api)
│  ├─ preload/api.d.ts            # window.docflow 的类型声明（供渲染进程 tsconfig）
│  └─ renderer/
│     ├─ index.html
│     ├─ main.tsx  App.tsx  globals.css
│     ├─ api/                     # invoke.ts（window.docflow 的类型化 invoke/listen）、errors.ts（还原 IPC 错误）
│     ├─ store/                   # zustand：documents、settings、ui
│     ├─ views/Library/  NewTranslation/  Document/  Settings/
│     ├─ components/              # 通用：ConfirmDialog、TranslatorSelect
│     └─ lib/                     # 纯函数与小工具：文案表、拖放、Toast、主题、译者选项
├─ tests/
│  ├─ fixtures/                   # 由 scripts/make-fixtures.mjs 生成的 PDF + 少量真实样例
│  ├─ mock-provider/server.ts     # 假大模型服务（OpenAI/Anthropic/Gemini 三种接口 + 故障注入）
│  ├─ unit/                       # 跨模块的单测（模块内单测放源码旁 *.test.ts）、global-setup.ts、测试用 worker
│  └─ e2e/*.spec.ts               # Playwright _electron；global-setup.ts（mock 服务）、helpers.ts（启动夹具）
└─ docs/
```

## 2.3 依赖与版本

调研日期 2026-09-21 的 npm 最新稳定版。用 caret 范围；执行时取范围内最新。**major 不同时**：先看 `docs/worklog/` 有无说明；没有就按下表「若升级」列处理。

| 包                                                                                                                                                                                                                                      | 版本                                                 | 用途                                                                                | 若升级 major                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `electron`                                                                                                                                                                                                                              | `^44.4.3`（Node 24.21 / Chromium 152）               | 运行时                                                                              | 允许到 45/46；检查 `protocol.handle`、`safeStorage` API 无变化     |
| `electron-vite`                                                                                                                                                                                                                         | `^5.0.0`                                             | 构建 main/preload/renderer                                                          | 检查 peer 的 vite 范围，随之调整 vite                              |
| `vite`                                                                                                                                                                                                                                  | `^7.3.6`（electron-vite 5 的 peer 只到 7）           | 打包                                                                                | 不要升到 8，除非 electron-vite 支持                                |
| `@vitejs/plugin-react`                                                                                                                                                                                                                  | `^5.2.0`                                             | React Fast Refresh；6.x 的 peer 是 Vite 8，而 electron-vite 5 只到 Vite 7，故锁 5.x | 等 electron-vite 支持 Vite 8 后再升 6                              |
| `typescript`                                                                                                                                                                                                                            | `^5.9.3`（typescript-eslint 8.70 只支持 < 6.1）      | —                                                                                   | 不升 6/7                                                           |
| `react` / `react-dom`                                                                                                                                                                                                                   | `^19.3.0`                                            | UI                                                                                  | —                                                                  |
| `@heroui/react` / `@heroui/styles`                                                                                                                                                                                                      | `^3.2.6`                                             | 组件库；需 Tailwind ≥ 4、不需要 Provider                                            | 4.x 出现时停下，读迁移文档                                         |
| `tailwindcss` / `@tailwindcss/vite`                                                                                                                                                                                                     | `^4.3.3`                                             | 样式                                                                                | —                                                                  |
| `zustand`                                                                                                                                                                                                                               | `^5.0.15`                                            | 渲染进程状态                                                                        | —                                                                  |
| `zod`                                                                                                                                                                                                                                   | `^4.6.5`                                             | 所有跨进程/跨文件数据校验                                                           | —                                                                  |
| `pdfjs-dist`                                                                                                                                                                                                                            | `^6.3.289`（`legacy/build/pdf.mjs` 供 Node）         | 解析（算子流、文本层检测、校验）                                                    | 检查 `getOperatorList`/`OPS`/glyph 对象字段                        |
| `@cantoo/pdf-lib`                                                                                                                                                                                                                       | `^2.11.1`（pdf-lib 的维护分支，API 同 pdf-lib 1.17） | 写回（低层对象 API + 字体嵌入 + copyPages）                                         | —                                                                  |
| `@cantoo/fontkit`                                                                                                                                                                                                                       | `^2.0.12`                                            | 字体嵌入与子集化                                                                    | —                                                                  |
| `mupdf`                                                                                                                                                                                                                                 | `1.3.6`（精确版本，MuPDF 1.25.6，WebAssembly）       | 版面检测前的页面渲染，与 pdf2zh 的 PyMuPDF 一致；AGPL-3.0（ADR-0016）               | 换版本前用 `tests/fixtures/pdf2zh` 与维护者论文对照版面框          |
| `onnxruntime-web`                                                                                                                                                                                                                       | `1.30.0`（精确版本）                                 | DocLayout-YOLO 推理（Node 下用 wasm 后端，不用原生的 onnxruntime-node）             | 检查 `ort.node.min.mjs` 与 wasm 文件名（electron-builder `files`） |
| `electron-log`                                                                                                                                                                                                                          | `^5.4.4`                                             | 日志                                                                                | —                                                                  |
| `fflate`                                                                                                                                                                                                                                | `^0.8.2`                                             | ZIP 导出（内容流的解压/压缩用 pdf-lib 自带的）                                      | —                                                                  |
| `gpt-tokenizer`                                                                                                                                                                                                                         | `^4.0.0`（devDependency，打进主进程 bundle）         | o200k_base 分词计数，BabelDOC 按 token 分批（04 §4.9，ADR-0018）；纯 JS，MIT        | 检查 `gpt-tokenizer/encoding/o200k_base` 入口与 `encode` 的选项    |
| `lucide-react`                                                                                                                                                                                                                          | `^1.47.0`                                            | 图标                                                                                | —                                                                  |
| `clsx`                                                                                                                                                                                                                                  | `^2.1.1`                                             | className 拼接                                                                      | —                                                                  |
| `vitest`                                                                                                                                                                                                                                | `^5.0.1`                                             | 单测                                                                                | —                                                                  |
| `@playwright/test`                                                                                                                                                                                                                      | `^1.63.0`                                            | E2E（`_electron`）                                                                  | —                                                                  |
| `electron-builder`                                                                                                                                                                                                                      | `^26.15.3`                                           | 打包                                                                                | —                                                                  |
| `png2icons`                                                                                                                                                                                                                             | `^2.0.1`                                             | 生成图标                                                                            | —                                                                  |
| `eslint` `^10.11.0`、`@eslint/js` `^10.0.1`、`typescript-eslint` `^8.70.0`、`eslint-plugin-react-hooks` `^7.1.1`、`eslint-plugin-react-refresh` `^0.5.7`、`eslint-config-prettier` `^10.1.8`、`globals` `^17.12.0`、`prettier` `^3.9.8` | lint/格式                                            |                                                                                     |
| `tsx` `^4.23.15`                                                                                                                                                                                                                        | 直接运行 `tests/mock-provider/server.ts` 与脚本      |                                                                                     |
| `@types/node` `^24`、`@types/react` `^19.3`、`@types/react-dom` `^19.3`                                                                                                                                                                 | 类型                                                 |                                                                                     |

`@heroui/react` 的 peer（`react-aria`、`react-aria-components`、`@react-aria/ssr`、`@react-aria/utils`、`@internationalized/date`）由 npm 自动安装；若 `npm ls` 报 peer 缺失，显式 `npm i` 它们。

## 2.4 `package.json`

```json
{
  "name": "docflow",
  "version": "4.1.0",
  "private": true,
  "description": "PDF 论文翻译桌面应用",
  "author": "DocFlow contributors",
  "homepage": "https://github.com/Uniseem/docflow",
  "license": "MIT",
  "type": "module",
  "main": "./out/main/index.mjs",
  "engines": { "node": ">=24" },
  "scripts": {
    "dev": "electron-vite dev",
    "predev": "node scripts/fetch-assets.mjs",
    "build": "electron-vite build",
    "prebuild": "node scripts/fetch-assets.mjs && node scripts/third-party-notices.mjs",
    "preview": "electron-vite preview",
    "typecheck": "tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json",
    "lint": "eslint . && prettier --check .",
    "format": "prettier --write .",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test",
    "verify:fonts": "node scripts/verify-fonts.mjs",
    "model": "node scripts/fetch-assets.mjs",
    "assets": "node scripts/fetch-assets.mjs",
    "check": "npm run verify:fonts && npm run typecheck && npm run lint && npm run test",
    "dist": "npm run build && electron-builder --publish never",
    "dist:dir": "npm run build && electron-builder --dir --publish never",
    "mock:provider": "tsx tests/mock-provider/server.ts",
    "fixtures": "node scripts/make-fixtures.mjs",
    "icons": "node scripts/make-icons.mjs",
    "analyze": "tsx scripts/analyze-pdf.mjs",
    "compose": "tsx scripts/compose-pdf.mjs"
  },
  "dependencies": {
    "@cantoo/fontkit": "^2.0.12",
    "@cantoo/pdf-lib": "^2.11.1",
    "electron-log": "^5.4.4",
    "fflate": "^0.8.2",
    "mupdf": "1.3.6",
    "onnxruntime-web": "1.30.0",
    "pdfjs-dist": "^6.3.289",
    "zod": "^4.6.5"
  },
  "devDependencies": {
    "@eslint/js": "^10.0.1",
    "@heroui/react": "^3.2.6",
    "@heroui/styles": "^3.2.6",
    "@playwright/test": "^1.63.0",
    "@tailwindcss/vite": "^4.3.3",
    "@types/node": "^24",
    "@types/react": "^19.3.0",
    "@types/react-dom": "^19.3.0",
    "@vitejs/plugin-react": "^5.2.0",
    "clsx": "^2.1.1",
    "electron": "^44.4.3",
    "electron-builder": "^26.15.3",
    "electron-vite": "^5.0.0",
    "eslint": "^10.11.0",
    "eslint-config-prettier": "^10.1.8",
    "eslint-plugin-react-hooks": "^7.1.1",
    "eslint-plugin-react-refresh": "^0.5.7",
    "globals": "^17.12.0",
    "gpt-tokenizer": "^4.0.0",
    "lucide-react": "^1.47.0",
    "png2icons": "^2.0.1",
    "prettier": "^3.9.8",
    "react": "^19.3.0",
    "react-dom": "^19.3.0",
    "tailwindcss": "^4.3.3",
    "tsx": "^4.23.15",
    "typescript": "^5.9.3",
    "typescript-eslint": "^8.70.0",
    "vite": "^7.3.6",
    "vitest": "^5.0.1",
    "zustand": "^5.0.15"
  }
}
```

原则：**主进程运行时需要的包放 `dependencies`**（electron-vite 的 `externalizeDepsPlugin` 把它们保持为外部模块，electron-builder 打包 `node_modules` 里的它们）；渲染进程用的包被 Vite 打进 bundle，放 `devDependencies`，避免打包体积膨胀。例外：`zod` 在 `dependencies` 里，但 preload 把它打进 bundle（2.9）；`gpt-tokenizer` 反过来在 `devDependencies` 里，由 Vite 打进主进程 bundle 的单独一块（2.9），不进 `node_modules` 的打包；`pdfjs-dist` 的可选原生依赖 `@napi-rs/canvas` 会随 npm 安装，但被 `electron-builder.yml` 的 `files` 排除，`DOMMatrix` 由 `src/main/pdf/dom-matrix.ts` 补齐（ADR-0010）。`dist` / `dist:dir` 走 `npm run build`（不要直接 `electron-vite build`），这样 `prebuild` 会先下载版面模型与字体（`fetch-assets.mjs`，已有且哈希一致的跳过）并生成 `THIRD_PARTY_NOTICES.md`，electron-builder 的 extraResources 才能找到它们。`model` 是 `assets` 的旧名，指向同一个脚本。

`.npmrc`：

```
engine-strict=true
fund=false
audit=false
```

## 2.5 主进程启动顺序（`src/main/index.ts`）

1. 模块顶层（`app.ready` 之前）：`protocol.registerSchemesAsPrivileged([{ scheme: 'docflow', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }])`；有 `DOCFLOW_DATA_DIR` 时把它解析成绝对路径并 `app.setPath('userData', <dir>/.electron-user-data)`（2.8，必须早于单实例锁，锁在 userData 里）；注册 `open-file`（macOS 冷启动时它可能早于 ready，先缓存路径）。
2. `app.requestSingleInstanceLock()`；拿不到 → `app.quit()`；拿到后监听 `second-instance` 把主窗口前置，并把命令行里的 PDF 路径交给「新建翻译」。
3. `await app.whenReady()`，然后 `new AppSession(userData).boot()`（`app/session.ts`，第 4–7 步）；任何一步抛错都弹 `dialog.showErrorBox` 并退出。
4. 读 `host.json`（在 userData 里），按其中的主题设 `nativeTheme.themeSource`。
5. 决定文档库目录（05 章 5.1）→ 建目录并试写 → `settings.load()`、`secrets.load()`、`library.open()`（扫描 manifest 建索引）。打不开时回落到默认文档库，窗口出现后弹框说明原因（`host.json` 保留原设置，下次启动再试）。
6. 初始化日志（2.7；日志在文档库的 `logs/` 下，所以放在确定文档库之后）→ `session.defaultSession.setProxy(...)` 按设置（并 `closeAllConnections()`）→ `protocol.handle('docflow', handler)`（2.6）。
7. 注册 IPC（`ipc/register.ts`）→ `scheduler.start()`：把上次未完成（`processing`/`retrying`）的文档改回 `queued` 并开始跑。
8. 安装应用菜单（`app/install-menu.ts`），创建主窗口（`src/main/index.ts` 的 `createWindow()`；`show: false`，`ready-to-show` 时再显示），macOS 上 `titleBarStyle: 'hiddenInset'`、`trafficLightPosition: {x: 16, y: 16}`；Windows 默认标题栏，没有菜单栏（`Menu.setApplicationMenu(null)`：菜单里的命令在设置与「关于」里都有，快捷键由渲染进程处理；2026-09-25 起，此前 Windows 也有「文件/编辑/窗口/帮助」菜单栏）。最小尺寸 960×600，默认 1240×800，记住上次尺寸、位置与是否最大化（存 `host.json`；标题栏不在任何屏幕内时用默认尺寸，见 `app/window-state.ts`）。
9. macOS：`app.on('open-file')` 与 Dock 拖入 → 新建翻译（渲染进程订阅前先排队，由 `app:takePendingFiles` 取走）；`activate` 时没有窗口就重建；`window-all-closed` 时不退出（macOS）/ 退出（Windows）。
10. `before-quit`：`AppSession.dispose()` → `scheduler.stop()`（给正在跑的任务最多 5 s 收尾；它们保持 `processing`，下次启动从断点续跑），然后 terminate 两个 worker，再退出。

（实现与原规划不同：原规划先初始化日志、先建窗口再注册 IPC；实际日志路径依赖文档库，所以日志在打开文档库之后初始化；窗口在 IPC 与调度器就绪之后才创建，渲染进程一加载就能调用。文档库回落与窗口位置见 worklog 2026-09-23-m5-review 第 1、40 条。）

## 2.6 安全设置

- 主窗口 `webPreferences`：`{ preload, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, plugins: true, spellcheck: false }`。`plugins: true` 是为了 iframe 里用 Chromium 内置 PDF 查看器。
- `index.html` 的 CSP（meta 标签，开发与生产一致；生产是 asar 里的 `<script type="module">`，`'self'` 能匹配，见 ADR-0009）：

  ```
  default-src 'self';
  script-src 'self';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob: docflow:;
  font-src 'self' data:;
  frame-src docflow:;
  connect-src 'self' blob: data:;
  worker-src 'self' blob:;
  ```

  开发模式 Vite 需要 `connect-src ws://localhost:*`，通过 Vite 插件在非 production 时注入。`script-src` 不含 `'unsafe-eval'`：zod 4 会先试探 `new Function`，被拦时自动退回非 JIT 路径，控制台那条 CSP 报告可以忽略。

- `docflow://` 协议处理器（`app/protocol.ts`）：只接受 `docflow://library/<相对路径>`，把相对路径 `path.resolve(libraryDir, rel)` 后检查仍在 `libraryDir` 内且不含符号链接逃逸（`fs.realpath` 比较），否则 404；只允许 `.pdf`；用 `net.fetch(pathToFileURL(file))` 返回，附 `Content-Type: application/pdf` 与 `Cache-Control: no-store`。
- 所有 `shell.openExternal` 只放行 `https:` 与 `mailto:`。
- `setWindowOpenHandler` 一律拒绝；`will-navigate` 只放行应用自己的页面（开发时的 `ELECTRON_RENDERER_URL`、生产的 `out/renderer/index.html`），其余拒绝。被拒的地址是 `https:` / `mailto:` 时交给 `shell.openExternal`。
- 渲染进程收到的任何字符串只当数据；文档标题、文件名在界面上用 React 正常渲染（自动转义），不用 `dangerouslySetInnerHTML`。

## 2.7 日志

- `electron-log` 5，文件 `<library>/logs/main.log`，`maxSize` 8 MiB，滚动保留 `main.old.log`。
- 级别：开发 `debug`，生产 `info`；环境变量 `DOCFLOW_LOG_LEVEL` 覆盖。
- 格式：`[2026-09-21 16:00:00.123] [info] [pipeline] {docId} inspect ok pages=12`——统一 `scope` 用模块名。
- **永远不记录 API Key**；请求体日志截断到 400 字并做 `redact()`（04 章 4.5）。
- 处理记录（给用户看的事件）另有 `events.jsonl`（05 章 5.5），与日志不是一回事。

## 2.8 环境变量

| 变量                        | 作用                                                                                                                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DOCFLOW_DATA_DIR`          | 覆盖文档库目录（优先于 host.json；相对路径按当前目录转成绝对路径）；同时把 Electron `userData` 改到 `<dir>/.electron-user-data`，E2E 不碰真实的 host.json、缓存与单实例锁                                          |
| `DOCFLOW_FAKE_PROVIDERS=1`  | 翻译不发网络请求，返回确定性的假译文（04 章 4.13）；打开文档库时在设置里补一个 `fake` 服务商                                                                                                                       |
| `DOCFLOW_MOCK_PROVIDER_URL` | 存在时把所有服务商的 Base URL 按接口类型改指向它（E2E 用 mock 服务）                                                                                                                                               |
| `DOCFLOW_LOG_LEVEL`         | `debug/info/warn/error`                                                                                                                                                                                            |
| `DOCFLOW_E2E_SAVE_PATH`     | 存在时保存对话框直接返回该路径（E2E 用）                                                                                                                                                                           |
| `DOCFLOW_E2E_FOLDER_PATH`   | 存在时选文件夹对话框直接返回该路径；同时让 `app:info.dataDirFromEnv` 为 false，以便 E2E 改文档库位置                                                                                                               |
| `DOCFLOW_E2E_GLOSSARY_PATH` | 存在时 `glossaries:import` 不弹对话框，直接导入该 CSV（E2E 用，05 §5.6）                                                                                                                                           |
| `DOCFLOW_MODEL_URL`         | 只给 `scripts/fetch-assets.mjs`：版面模型的完整下载地址，替换内置的 Hugging Face / hf-mirror / ModelScope 三个来源                                                                                                 |
| `DOCFLOW_FONTS_URL`         | 只给 `scripts/fetch-assets.mjs`：字体的基础地址（以 `/` 结尾，后面接文件名），替换内置的 BabelDOC-Assets 三个来源（GitHub、Hugging Face、ModelScope）                                                              |
| `DOCFLOW_HIDE_WINDOW`       | `1` 时窗口创建后不显示、macOS 隐藏 Dock 图标、不发系统通知，`backgroundThrottling` 关闭（隐藏窗口的定时器与动画照常）；E2E 默认带上（`E2E_SHOW=1` 时不带），自写的冒烟脚本也应带上，避免在开发者屏幕上反复开关窗口 |

## 2.9 各配置文件全文

### `electron.vite.config.ts`

```ts
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

function devCsp() {
  return {
    name: 'dev-csp',
    transformIndexHtml(html: string) {
      if (process.env.NODE_ENV === 'production') return html
      return html.replace(
        "connect-src 'self' blob: data:;",
        "connect-src 'self' blob: data: ws://localhost:* http://localhost:* ws://127.0.0.1:* http://127.0.0.1:*;",
      )
    },
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'workers/analyze': resolve(__dirname, 'src/main/workers/analyze.ts'),
          'workers/compose': resolve(__dirname, 'src/main/workers/compose.ts'),
        },
        output: {
          format: 'es',
          entryFileNames: '[name].mjs',
          chunkFileNames: 'chunks/[name]-[hash].mjs',
          // The o200k token list holds strings such as " import": in a chunk that also uses
          // __dirname, electron-vite's CommonJS shim takes one for an import statement and is
          // inserted inside the list. On its own the list needs no shim.
          manualChunks: (id) =>
            id.includes('/node_modules/gpt-tokenizer/') ? 'gpt-tokenizer' : undefined,
        },
      },
    },
    resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ['zod'] })],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        // 沙箱 preload 必须是 CommonJS
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
    resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  },
  renderer: {
    plugins: [react(), tailwindcss(), devCsp()],
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } } },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@renderer': resolve(__dirname, 'src/renderer'),
      },
    },
  },
})
```

说明：

- `"type": "module"` + 主进程 ESM 输出：`pdfjs-dist` 是 ESM-only，这样主进程与 worker 可以直接 `import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'`。ESM 主进程里没有 `__dirname`，先取 `appDir = fileURLToPath(new URL('.', import.meta.url))`，再 `join(appDir, '../preload/index.cjs')`。
- worker 作为主进程的额外入口打包（`out/main/workers/analyze.mjs`），`PdfWorkerHost` 用 `new Worker(pathToFileURL(join(appDir, 'workers/analyze.mjs')))` 启动（路径由 `app/session.ts` 的 `workerPath()` 给出）。M0 已验证：electron-vite 5 在 `dev` 与 `build` 下都会把 `out/main/workers/{analyze,compose}.mjs` 打出来，路径一致，无需改 `?nodeWorker` 或 `utilityProcess.fork`。
- `gpt-tokenizer` 单独成块（`out/main/chunks/gpt-tokenizer-<hash>.mjs`）：它的 o200k 分词表里有 `" import"` 这样的字符串，与用到 `__dirname` 的代码在同一块时，electron-vite 给 ESM 输出补 CommonJS 垫片的正则把它当成 import 语句，把垫片插进字符串中间，主进程打包失败（4.1.0 开发时 CI 打包冒烟发现，单测不打包所以测不出；worklog 2026-09-26-babeldoc-features）。改主进程依赖后先本地 `npm run build`。
- 沙箱 preload 必须是 CJS（Electron 限制），所以 preload 单独指定 `format: 'cjs'`、后缀 `.cjs`。沙箱里不能 `require('zod')`，因此 `externalizeDepsPlugin({ exclude: ['zod'] })` 把 zod 打进 preload（ADR-0009）。
- 开发模式 CSP：renderer 用 Vite 插件把 `connect-src` 扩成允许 `ws://localhost:*` / `http://localhost:*`（生产构建 `NODE_ENV=production` 不改）。
- 生产窗口：`loadFile(out/renderer/index.html)`，文件在 asar 里，Vite 产出的 `<script type="module" crossorigin>` 原样可用。开发窗口：`ELECTRON_RENDERER_URL`。

### `tsconfig.json`（基础）

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": true,
    "useUnknownInCatchVariables": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "baseUrl": ".",
    "paths": { "@shared/*": ["src/shared/*"], "@renderer/*": ["src/renderer/*"] }
  },
  "files": [],
  "references": [{ "path": "./tsconfig.node.json" }, { "path": "./tsconfig.web.json" }]
}
```

`tsconfig.node.json`：`extends` 基础，`compilerOptions.types: ["node"]`，`lib: ["ES2023"]`，`noEmit: true`，`allowJs: true`（scripts 是 `.mjs`）、`checkJs: false`，`include: ["src/main", "src/preload", "src/shared", "electron.vite.config.ts", "vitest.config.ts", "playwright.config.ts", "scripts", "tests/mock-provider", "tests/unit", "tests/e2e"]`。
`tsconfig.web.json`：`extends` 基础，`jsx: "react-jsx"`，`lib: ["ES2023", "DOM", "DOM.Iterable"]`，`types: []`，`noEmit: true`，`include: ["src/renderer", "src/shared", "src/preload/api.d.ts"]`。

`src/preload/api.d.ts` 声明 `interface Window { docflow: DocflowApi }`，`DocflowApi` 类型从 `src/shared/ipc.ts` 推导（05 章 5.6）。

### `eslint.config.js`

```js
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import prettier from 'eslint-config-prettier'
import globals from 'globals'

export default tseslint.config(
  {
    ignores: [
      'out/**',
      'dist/**',
      'release/**',
      'coverage/**',
      '.heroui-docs/**',
      'playwright-report/**',
      'test-results/**',
      'node_modules/**',
      'tmp/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': 'warn',
    },
  },
  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts', 'scripts/**', 'tests/**'],
    languageOptions: { globals: globals.node },
  },
  {
    // 主进程与渲染进程互不引用
    files: ['src/main/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: ['**/renderer/**', '@renderer/*'] }] },
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', { patterns: ['**/main/**', 'electron', 'node:*'] }],
    },
  },
  {
    files: ['**/*.mjs', 'eslint.config.js'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node, sourceType: 'module' },
  },
  prettier,
)
```

`.prettierrc.json`：`{ "semi": false, "singleQuote": true, "printWidth": 100, "trailingComma": "all" }`；`.prettierignore`：`out dist release coverage .heroui-docs package-lock.json THIRD_PARTY_NOTICES.md tmp`。`tmp/` 是本地调试目录（临时脚本、截图、写回结果），已 gitignore，ESLint 同样忽略。

### `vitest.config.ts`

```ts
import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  test: {
    include: ['src/**/*.test.ts', 'tests/unit/**/*.test.ts', 'tests/mock-provider/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000,
    globalSetup: ['tests/unit/global-setup.ts'], // 确保 fixtures 已生成
    coverage: { provider: 'v8', include: ['src/main/**', 'src/shared/**'] },
  },
})
```

渲染进程组件不做 DOM 单测（HeroUI 组件靠 E2E 覆盖）；纯函数放 `src/shared/` 或 `src/renderer/lib/` 并用 node 环境测。

### `playwright.config.ts`

```ts
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 180_000,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  globalSetup: './tests/e2e/global-setup.ts',
  use: { trace: 'retain-on-failure' },
})
```

`globalSetup` 在 38111 端口启动 mock 服务（08.3）。E2E 一律启动 `electron-builder --dir` 的打包产物（先 `npm run dist:dir`），不用 `args: [mainEntry]` 启动源码：`_electron.launch({ executablePath, env: { DOCFLOW_DATA_DIR, DOCFLOW_MOCK_PROVIDER_URL } })`，`executablePath` 指向 `release/mac-arm64/DocFlow.app/Contents/MacOS/DocFlow`（Intel 为 `release/mac/…`）或 `release/win-unpacked/DocFlow.exe`。启动、临时目录与清理都在 `tests/e2e/helpers.ts` 的 fixture 里（08.5）。

### `src/renderer/globals.css`

```css
@import 'tailwindcss';
@import '@heroui/styles';

:root {
  /* 品牌色：沉稳的蓝，深浅模式各自可读 */
  --accent: oklch(0.55 0.16 255);
}
.dark {
  --accent: oklch(0.72 0.14 255);
}

html,
body,
#root {
  height: 100%;
  overflow: hidden;
}
body {
  @apply bg-background text-foreground;
  -webkit-user-select: none;
  user-select: none;
}
/* 可选中的区域（日志、路径、错误信息）显式打开 */
.selectable {
  -webkit-user-select: text;
  user-select: text;
}
/* macOS 无边框标题栏可拖动区域 */
.titlebar-drag {
  -webkit-app-region: drag;
}
.titlebar-no-drag {
  -webkit-app-region: no-drag;
}
/* Overlays are portaled to the end of <body> and can cover the draggable title bar.
   Electron hit-tests app regions, not stacking order, so without no-drag the part of a
   drawer, backdrop or popover that overlaps the title bar swallows clicks. */
[data-slot='modal-backdrop'],
[data-slot='alert-dialog-backdrop'],
[data-slot='drawer-backdrop'],
[data-slot$='-popover'],
[data-slot='popover-dialog'] {
  -webkit-app-region: no-drag;
}
```

深色模式：`lib/theme.ts` 的 `applyTheme()` 在 `<html>` 上切换 `.dark` / `.light` 类并设置 `data-theme`（HeroUI 两种都认）；`ui` store 里 `theme: 'system' | 'light' | 'dark'`，`system` 时监听 `matchMedia('(prefers-color-scheme: dark)')`。改主题走 `app:setTheme`：主进程设 `nativeTheme.themeSource`（原生对话框跟随）并存进 `host.json`。启动时主进程在建窗口前就按 `host.json` 设好 `themeSource`，所以 `prefers-color-scheme` 已反映保存的主题；`main.tsx` 在首次渲染前先 `applyTheme('system')`，`index.html` 的内联样式按 `prefers-color-scheme` 给首帧背景色，避免深色模式先闪一下浅色。

### `src/renderer/index.html`

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: docflow:; font-src 'self' data:; frame-src docflow:; connect-src 'self' blob: data:; worker-src 'self' blob:"
    />
    <meta name="color-scheme" content="light dark" />
    <title>DocFlow</title>
    <style>
      /* Until main.tsx sets .light/.dark: follow prefers-color-scheme, which reflects the saved
         theme (nativeTheme.themeSource), so the first frame is not painted light in dark mode.
         Colors are HeroUI's --background for each theme. */
      html:not(.light):not(.dark) body {
        background: oklch(0.9702 0 0);
      }
      @media (prefers-color-scheme: dark) {
        html:not(.light):not(.dark) body {
          background: oklch(12% 0.005 285.823);
        }
      }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

## 2.10 版本策略

- `package.json.version` 是唯一版本源；`app.getVersion()` 读取它。首个发布 `4.0.0`，之前用 `4.0.0-beta.N` 标签演练发布流程。
- 打标签：`git tag v4.0.0 && git push origin v4.0.0`；`release.yml` 校验标签 == 版本。
- CHANGELOG 在打标签前把 Unreleased 改为版本号与日期。
