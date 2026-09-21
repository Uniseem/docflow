# 02 架构与工程

## 2.1 进程模型

```
┌──────────────────────────── Electron 应用 ────────────────────────────┐
│                                                                        │
│  主进程 (Node 24)  src/main/                                           │
│  ├─ app/        生命周期、单实例锁、窗口、菜单、协议、托盘(无)            │
│  ├─ ipc/        ipcMain.handle 注册表（每个通道一个函数，zod 校验入参）   │
│  ├─ settings/   settings.json、host.json、secrets.bin(safeStorage)      │
│  ├─ library/    文档目录、manifest、events.jsonl、内存索引、导出        │
│  ├─ jobs/       调度器：队列、并发、重试、取消、断点恢复                 │
│  ├─ pipeline/   一个文档的处理流程：inspect→analyze→translate→compose… │
│  ├─ translate/  服务商、请求、错误分类、密钥轮换、并发池、批处理、缓存   │
│  ├─ pdf/        与 worker 的桥：启动 worker、超时、取消、消息协议        │
│  ├─ raster/     管理隐藏栅格化窗口：加载 PDF、按矩形出 PNG               │
│  └─ log/        electron-log 配置                                       │
│        │ worker_threads (纯 CPU，无 Electron API)                        │
│        ▼                                                                │
│  src/main/workers/analyze.ts   pdf.js 解析 + 版面分析  → AnalysisResult │
│  src/main/workers/compose.ts   pdf-lib 覆盖/写回/双语  → 输出文件       │
│                                                                        │
│  隐藏窗口 raster  src/renderer/raster.html + src/raster/               │
│     pdf.js (web build) 渲染页面到 canvas，按矩形裁 PNG，走 IPC 回主进程  │
│                                                                        │
│  主窗口 renderer  src/renderer/  React 19 + HeroUI 3                   │
│     sandbox、contextIsolation；只通过 window.docflow (preload) 通信      │
│     PDF 预览：<iframe src="docflow://library/…pdf">（Chromium 内置查看器）│
└────────────────────────────────────────────────────────────────────────┘
```

要点：

- **翻译请求在主进程**（需要 `net.fetch`，worker 里没有）；**CPU 密集的解析与写回在 worker**（可 `terminate()` 实现硬超时）。
- 一个文档任务 = 主进程里的一个 async 函数，按阶段调用 worker / 翻译池 / 栅格窗口，写事件到 `events.jsonl` 并通过 `webContents.send` 推给渲染进程。
- 渲染进程没有 Node、没有网络；预览 PDF 通过自定义协议 `docflow://` 读文档库里的文件（主进程校验路径不越界）。

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
│  ├─ icon.icns  icon.ico  icon.png (1024)  installer.nsh(可选)
├─ resources/                     # extraResources，运行时通过 process.resourcesPath 访问
│  └─ fonts/NotoSansSC-Regular.otf  NotoSansSC-Bold.otf  LICENSE-OFL.txt  README.md
├─ scripts/
│  ├─ verify-fonts.mjs            # 核对字体 SHA-256
│  ├─ make-icons.mjs              # 由 build/icon.png 生成 icns/ico（用 png2icons 或 electron-icon-builder）
│  └─ make-fixtures.mjs           # 生成 tests/fixtures/*.pdf（用 pdf-lib）
├─ src/
│  ├─ shared/                     # 主/渲染共用；不得 import electron 或 node
│  │  ├─ ipc.ts                   # 通道名常量 + 每个通道的请求/响应 zod schema + 类型
│  │  ├─ types.ts                 # Document、ProcessingEvent、Settings、Provider… 的 zod schema 与类型
│  │  ├─ presets.ts               # 服务商预设表
│  │  ├─ constants.ts             # 限制值（并发上限、字符上限…）
│  │  ├─ text.ts                  # 纯函数：文件名清理、相对时间、字节格式化
│  │  └─ errors.ts                # UserError / PermanentError 等错误类与错误码
│  ├─ main/
│  │  ├─ index.ts                 # 入口：单实例、协议注册、启动顺序（见 2.5）
│  │  ├─ app/window.ts  app/menu.ts  app/protocol.ts  app/dialogs.ts
│  │  ├─ ipc/register.ts          # 把 handlers 表注册到 ipcMain，统一 zod 校验与错误转换
│  │  ├─ ipc/handlers/*.ts        # app、settings、providers、documents、shell 各一个文件
│  │  ├─ settings/settings.ts  settings/secrets.ts  settings/host.ts  settings/atomic-write.ts
│  │  ├─ library/library.ts  library/manifest.ts  library/events.ts  library/export.ts  library/index.ts
│  │  ├─ jobs/scheduler.ts  jobs/job.ts
│  │  ├─ pipeline/run.ts          # 阶段编排
│  │  ├─ pipeline/stages/inspect.ts  analyze.ts  translate.ts  compose.ts  verify.ts  archive.ts
│  │  ├─ pdf/worker-host.ts       # spawn worker、超时、取消、typed messages
│  │  ├─ pdf/analyze/*.ts         # 纯函数：text-items、lines、columns、paragraphs、formula、normalize
│  │  ├─ pdf/compose/*.ts         # 纯函数：layout（换行/缩放）、cover、draw、dual、fonts
│  │  ├─ pdf/inspect.ts  pdf/verify.ts
│  │  ├─ workers/analyze.ts  workers/compose.ts   # worker 入口（薄封装，调用 pdf/ 下纯函数）
│  │  ├─ raster/raster-window.ts  # 隐藏窗口生命周期 + 请求队列
│  │  ├─ translate/providers.ts  request.ts  response.ts  errors.ts  keys.ts  pool.ts
│  │  ├─ translate/batch.ts  protect.ts  validate.ts  translate-document.ts  cache.ts  fake.ts
│  │  ├─ translate/http.ts        # fetch 注入：生产用 net.fetch，测试用 undici/node fetch
│  │  └─ log/logger.ts
│  ├─ preload/index.ts            # contextBridge.exposeInMainWorld('docflow', api)
│  ├─ raster/main.ts              # 栅格化页面脚本（pdf.js web build）
│  └─ renderer/
│     ├─ index.html  raster.html
│     ├─ main.tsx  App.tsx  globals.css
│     ├─ api/                     # window.docflow 的类型化封装 + 事件订阅 hooks
│     ├─ store/                   # zustand：documents、settings、ui
│     ├─ views/Library/  NewTranslation/  Document/  Settings/
│     ├─ components/              # 通用：StatusChip、DropZone、Toasts、ConfirmDialog、PdfFrame…
│     └─ lib/                     # 纯函数：格式化、文案表
├─ tests/
│  ├─ fixtures/                   # 由 scripts/make-fixtures.mjs 生成的 PDF + 少量手工样例
│  ├─ mock-provider/server.ts     # 假大模型服务（OpenAI/Anthropic/Gemini 三种接口 + 故障注入）
│  ├─ unit/                       # 跨模块的单测（模块内单测放源码旁 *.test.ts）
│  └─ e2e/*.spec.ts               # Playwright _electron
└─ docs/
```

## 2.3 依赖与版本

调研日期 2026-09-21 的 npm 最新稳定版。用 caret 范围；执行时取范围内最新。**major 不同时**：先看 `docs/worklog/` 有无说明；没有就按下表「若升级」列处理。

| 包 | 版本 | 用途 | 若升级 major |
| --- | --- | --- | --- |
| `electron` | `^44.4.3`（Node 24.21 / Chromium 152） | 运行时 | 允许到 45/46；检查 `protocol.handle`、`safeStorage`、`utilityProcess` API 无变化 |
| `electron-vite` | `^5.0.0` | 构建 main/preload/renderer | 检查 peer 的 vite 范围，随之调整 vite |
| `vite` | `^7.3.6`（electron-vite 5 的 peer 只到 7） | 打包 | 不要升到 8，除非 electron-vite 支持 |
| `@vitejs/plugin-react` | `^6.1.1` | React Fast Refresh | — |
| `typescript` | `^5.9.3`（typescript-eslint 8.70 只支持 < 6.1） | — | 不升 6/7 |
| `react` / `react-dom` | `^19.3.0` | UI | — |
| `@heroui/react` / `@heroui/styles` | `^3.2.6` | 组件库；需 Tailwind ≥ 4、不需要 Provider | 4.x 出现时停下，读迁移文档 |
| `tailwindcss` / `@tailwindcss/vite` | `^4.3.3` | 样式 | — |
| `zustand` | `^5.0.15` | 渲染进程状态 | — |
| `zod` | `^4.6.5` | 所有跨进程/跨文件数据校验 | — |
| `pdfjs-dist` | `^6.3.289`（`legacy/build/pdf.mjs` 供 Node；web build 供栅格窗口） | 解析、渲染 | 检查 `getTextContent` 返回结构 |
| `@cantoo/pdf-lib` | `^2.11.1`（pdf-lib 的维护分支，API 同 pdf-lib 1.17） | 写回 | — |
| `@cantoo/fontkit` | `^2.0.12` | 字体嵌入与子集化 | — |
| `electron-log` | `^5.4.4` | 日志 | — |
| `lucide-react` | `^1.47.0` | 图标 | — |
| `clsx` | `^2.1.1` | className 拼接 | — |
| `vitest` | `^5.0.1` | 单测 | — |
| `@playwright/test` | `^1.63.0` | E2E（`_electron`） | — |
| `electron-builder` | `^26.15.3` | 打包 | — |
| `eslint` `^10.11.0`、`typescript-eslint` `^8.70.0`、`eslint-plugin-react-hooks` `^7.1.1`、`eslint-plugin-react-refresh` `^0.5.7`、`eslint-config-prettier` `^10.1.8`、`globals` `^17.12.0`、`prettier` `^3.9.8` | lint/格式 | |
| `tsx` `^4.23.15` | 直接运行 `tests/mock-provider/server.ts` 与脚本 | |
| `@types/node` `^24`、`@types/react` `^19.3`、`@types/react-dom` `^19.3` | 类型 | |
| `archiver`（ZIP 导出）→ **改用** `fflate` `^0.8` | 纯 JS，`@cantoo/pdf-lib` 已依赖 | |

`@heroui/react` 的 peer（`react-aria`、`react-aria-components`、`@react-aria/ssr`、`@react-aria/utils`、`@internationalized/date`）由 npm 自动安装；若 `npm ls` 报 peer 缺失，显式 `npm i` 它们。

## 2.4 `package.json`

```json
{
  "name": "docflow",
  "version": "4.0.0",
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
    "build": "electron-vite build",
    "preview": "electron-vite preview",
    "typecheck": "tsc --noEmit -p tsconfig.node.json && tsc --noEmit -p tsconfig.web.json",
    "lint": "eslint . && prettier --check .",
    "format": "prettier --write .",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test",
    "verify:fonts": "node scripts/verify-fonts.mjs",
    "check": "npm run verify:fonts && npm run typecheck && npm run lint && npm run test",
    "dist": "electron-vite build && electron-builder --publish never",
    "dist:dir": "electron-vite build && electron-builder --dir --publish never",
    "mock:provider": "tsx tests/mock-provider/server.ts",
    "fixtures": "node scripts/make-fixtures.mjs",
    "icons": "node scripts/make-icons.mjs"
  },
  "dependencies": {
    "@cantoo/fontkit": "^2.0.12",
    "@cantoo/pdf-lib": "^2.11.1",
    "electron-log": "^5.4.4",
    "fflate": "^0.8.2",
    "pdfjs-dist": "^6.3.289",
    "zod": "^4.6.5"
  },
  "devDependencies": {
    "@heroui/react": "^3.2.6",
    "@heroui/styles": "^3.2.6",
    "@playwright/test": "^1.63.0",
    "@tailwindcss/vite": "^4.3.3",
    "@types/node": "^24",
    "@types/react": "^19.3.0",
    "@types/react-dom": "^19.3.0",
    "@vitejs/plugin-react": "^6.1.1",
    "clsx": "^2.1.1",
    "electron": "^44.4.3",
    "electron-builder": "^26.15.3",
    "electron-vite": "^5.0.0",
    "eslint": "^10.11.0",
    "eslint-config-prettier": "^10.1.8",
    "eslint-plugin-react-hooks": "^7.1.1",
    "eslint-plugin-react-refresh": "^0.5.7",
    "globals": "^17.12.0",
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

原则：**主进程运行时需要的包放 `dependencies`**（electron-vite 的 `externalizeDepsPlugin` 把它们保持为外部模块，electron-builder 打包 `node_modules` 里的它们）；渲染进程用的包被 Vite 打进 bundle，放 `devDependencies`，避免打包体积膨胀。`pdfjs-dist` 两边都用：主进程外部引用，渲染进程 bundle。

`.npmrc`：

```
engine-strict=true
fund=false
audit=false
```

## 2.5 主进程启动顺序（`src/main/index.ts`）

1. `app.requestSingleInstanceLock()`；拿不到 → `app.quit()`；拿到后监听 `second-instance` 把主窗口前置，并把命令行里的 PDF 路径交给「新建翻译」。
2. `protocol.registerSchemesAsPrivileged([{ scheme: 'docflow', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }])`（必须在 `app.ready` 之前）。
3. 初始化日志（2.7）。
4. `await app.whenReady()`。
5. 读 `host.json` → 决定文档库目录（5.2）→ `settings.load()`、`secrets.load()`、`library.open()`（扫描 manifest 建索引）。
6. `protocol.handle('docflow', handler)`（2.6）。
7. `session.defaultSession.setProxy(...)` 按设置。
8. 创建主窗口（`app/window.ts`），macOS 上 `titleBarStyle: 'hiddenInset'`、`trafficLightPosition: {x: 16, y: 16}`；Windows 默认标题栏。最小尺寸 960×600，默认 1240×800，记住上次尺寸与位置（存 `host.json`）。
9. 注册 IPC（`ipc/register.ts`）。
10. `scheduler.start()`：把上次未完成（`processing`/`retrying`）的文档改回 `queued` 并开始跑。
11. macOS：`app.on('open-file')` 与 Dock 拖入 → 新建翻译；`window-all-closed` 时不退出（macOS）/ 退出（Windows）。
12. `before-quit`：`scheduler.stop()`（给正在写文件的任务最多 5 s 收尾，然后 terminate worker）、关闭栅格窗口、flush 日志。

## 2.6 安全设置

- 主窗口 `webPreferences`：`{ preload, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, plugins: true, spellcheck: false }`。`plugins: true` 是为了 iframe 里用 Chromium 内置 PDF 查看器。
- 栅格窗口：`{ show: false, webPreferences: { preload: rasterPreload, sandbox: true, contextIsolation: true, offscreen: false } }`，尺寸 800×600 无所谓（渲染到 canvas）。
- `index.html` 的 CSP（meta 标签，开发与生产一致）：

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

  开发模式 Vite 需要 `connect-src ws://localhost:*`，通过 electron-vite 的 `process.env.ELECTRON_RENDERER_URL` 判断后注入。
- `docflow://` 协议处理器（`app/protocol.ts`）：只接受 `docflow://library/<相对路径>`，把相对路径 `path.resolve(libraryDir, rel)` 后检查仍在 `libraryDir` 内且不含符号链接逃逸（`fs.realpath` 比较），否则 404；只允许 `.pdf`、`.png`；用 `net.fetch(pathToFileURL(file))` 返回，附 `Content-Type` 与 `Cache-Control: no-store`。
- 所有 `shell.openExternal` 只放行 `https:` 与 `mailto:`。
- `will-navigate` / `setWindowOpenHandler` 一律拒绝并交给 `shell.openExternal`（https）。
- 渲染进程收到的任何字符串只当数据；文档标题、文件名在界面上用 React 正常渲染（自动转义），不用 `dangerouslySetInnerHTML`。

## 2.7 日志

- `electron-log` 5，文件 `<library>/logs/main.log`，`maxSize` 8 MiB，滚动保留 `main.old.log`。
- 级别：开发 `debug`，生产 `info`；环境变量 `DOCFLOW_LOG_LEVEL` 覆盖。
- 格式：`[2026-09-21 16:00:00.123] [info] [pipeline] {docId} inspect ok pages=12`——统一 `scope` 用模块名。
- **永远不记录 API Key**；请求体日志截断到 400 字并做 `redact()`（4.4）。
- 处理记录（给用户看的事件）另有 `events.jsonl`（5.4），与日志不是一回事。

## 2.8 环境变量

| 变量 | 作用 |
| --- | --- |
| `DOCFLOW_DATA_DIR` | 覆盖文档库目录（优先于 host.json）；E2E 用 |
| `DOCFLOW_FAKE_PROVIDERS=1` | 翻译不发网络请求，返回确定性的假译文（4.13） |
| `DOCFLOW_MOCK_PROVIDER_URL` | 存在时把所有预设的 base_url 指向它（E2E 用 mock 服务） |
| `DOCFLOW_LOG_LEVEL` | `debug/info/warn/error` |
| `DOCFLOW_RASTER_SCALE` | 公式贴图缩放倍数，默认 4 |

## 2.9 各配置文件全文

### `electron.vite.config.ts`

```ts
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

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
        output: { format: 'es', entryFileNames: '[name].mjs', chunkFileNames: 'chunks/[name]-[hash].mjs' },
      },
    },
    resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          raster: resolve(__dirname, 'src/preload/raster.ts'),
        },
        // 沙箱 preload 必须是 CommonJS
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
    resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          raster: resolve(__dirname, 'src/renderer/raster.html'),
        },
      },
    },
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

- `"type": "module"` + 主进程 ESM 输出：`pdfjs-dist` 是 ESM-only，这样主进程可以直接 `import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'`。ESM 主进程里没有 `__dirname`，路径用 `fileURLToPath(new URL('../preload/index.cjs', import.meta.url))`。
- worker 作为主进程的额外入口打包（`out/main/workers/analyze.mjs`），用 `new Worker(new URL('./workers/analyze.mjs', import.meta.url))` 启动；开发模式下 electron-vite 也会输出到 `out/`，路径一致。**若 electron-vite 5 对多入口 + ESM 的组合有问题**（表现为 dev 时找不到 worker 文件），备选：用 electron-vite 文档的 `?nodeWorker` 导入方式，或把 worker 改为 `utilityProcess.fork`；把结论写进 worklog。
- 沙箱 preload 必须是 CJS（Electron 限制），所以 preload 单独指定 `format: 'cjs'`、后缀 `.cjs`。

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

`tsconfig.node.json`：`extends` 基础，`compilerOptions.types: ["node"]`，`lib: ["ES2023"]`，`include: ["src/main", "src/preload", "src/shared", "electron.vite.config.ts", "scripts", "tests/mock-provider", "tests/unit", "tests/e2e"]`。
`tsconfig.web.json`：`extends` 基础，`jsx: "react-jsx"`，`lib: ["ES2023", "DOM", "DOM.Iterable"]`，`types: []`，`include: ["src/renderer", "src/raster", "src/shared", "src/preload/api.d.ts"]`。

`src/preload/api.d.ts` 声明 `interface Window { docflow: DocflowApi }`，`DocflowApi` 类型从 `src/shared/ipc.ts` 推导（5.6）。

### `eslint.config.js`

```js
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import prettier from 'eslint-config-prettier'
import globals from 'globals'

export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'release/**', 'coverage/**', '.heroui-docs/**', 'playwright-report/**'] },
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
    files: ['src/renderer/**/*.{ts,tsx}', 'src/raster/**/*.ts'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: { ...reactHooks.configs.recommended.rules, 'react-refresh/only-export-components': 'warn' },
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
    rules: { 'no-restricted-imports': ['error', { patterns: ['**/main/**', 'electron', 'node:*'] }] },
  },
  prettier,
)
```

`.prettierrc.json`：`{ "semi": false, "singleQuote": true, "printWidth": 100, "trailingComma": "all" }`；`.prettierignore`：`out dist release coverage .heroui-docs package-lock.json`。

### `vitest.config.ts`

```ts
import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  test: {
    include: ['src/**/*.test.ts', 'tests/unit/**/*.test.ts'],
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
  use: { trace: 'retain-on-failure' },
})
```

E2E 用 `_electron.launch({ args: [mainEntry], env: { DOCFLOW_DATA_DIR, DOCFLOW_MOCK_PROVIDER_URL } })`，在 `globalSetup` 里启动 mock 服务。打包冒烟里用 `--dir` 产物：`executablePath` 指向 `release/<platform>-unpacked/DocFlow(.exe|.app/Contents/MacOS/DocFlow)`。

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
```

深色模式：在 `<html>` 上同时设置 `class="dark"` 与 `data-theme="dark"`（HeroUI 两种都认）；`ui` store 里 `theme: 'system' | 'light' | 'dark'`，`system` 时监听 `matchMedia('(prefers-color-scheme: dark)')`；同时把结果通过 IPC 告诉主进程 `nativeTheme.themeSource`，让原生对话框跟随。

### `src/renderer/index.html`

```html
<!doctype html>
<html lang="zh-CN" class="light" data-theme="light">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: docflow:; font-src 'self' data:; frame-src docflow:; connect-src 'self' blob: data:; worker-src 'self' blob:" />
    <title>DocFlow</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

`raster.html` 同结构，脚本 `../raster/main.ts`，CSP 里不需要 `frame-src`。

## 2.10 版本策略

- `package.json.version` 是唯一版本源；`app.getVersion()` 读取它。首个发布 `4.0.0`，之前用 `4.0.0-beta.N` 标签演练发布流程。
- 打标签：`git tag v4.0.0 && git push origin v4.0.0`；`release.yml` 校验标签 == 版本。
- CHANGELOG 在打标签前把 Unreleased 改为版本号与日期。
