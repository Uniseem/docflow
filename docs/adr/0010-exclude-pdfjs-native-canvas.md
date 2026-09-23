# ADR-0010：安装包排除 pdf.js 的可选原生依赖，DOMMatrix 用纯 JS 补齐

- 状态：已采纳
- 日期：2026-09-23
- 相关：M6-1、docs/plan/02-architecture.md、docs/plan/07-build-ci-release.md、worklog 2026-09-23-m5-e2e / m5-fixes

## 背景

pdfjs-dist 6 在 Node 环境下会尝试加载可选依赖 `@napi-rs/canvas`，用它提供 `DOMMatrix`、`Path2D` 等浏览器对象。npm 安装时它按当前平台带进一个预编译的 `.node` 文件，electron-builder 再把它放进 `app.asar.unpacked`。

这违反 AGENTS.md「不引入原生模块」的约定，而且在同一台 Mac 上先后打 arm64 与 x64 包时，x64 包里带的是 arm64 的 `.node`。

DocFlow 只用 pdf.js 解析（算子流、文本、字体），不在主进程或 worker 里渲染页面。实际用到浏览器对象的地方只有 worker 为 Type3 位图字形构造轮廓时的 `new DOMMatrix().scaleSelf(…).translateSelf(…)`，即 2D 仿射矩阵运算。

## 决定

- `electron-builder.yml` 的 `files` 排除 `**/node_modules/@napi-rs/**`，安装包不含任何 `.node` 文件。
- 新增 `src/main/pdf/dom-matrix.ts`：纯 JS 的 2D 仿射矩阵（`AffineMatrix`），在全局没有 `DOMMatrix` 时挂上去；`src/main/pdf/pdfjs.ts` 在加载 pdf.js 之前先 `import './dom-matrix'`。
- 开发环境里 `@napi-rs/canvas` 仍会随 npm 安装（它是 pdfjs-dist 的可选依赖），但运行时不依赖它；单测覆盖补齐后的矩阵运算。

## 备选方案

- **保留 `@napi-rs/canvas`，按架构分别安装**：需要为每个目标平台单独 `npm ci`，CI 与本地打包都变复杂，且仍是原生模块。放弃。
- **`npm install --omit=optional`**：会连带去掉其他平台相关的可选依赖（如 esbuild/rollup 的平台包），开发环境无法构建。放弃。
- **给 pdf.js 打补丁去掉 canvas 探测**：每次升级 pdfjs-dist 都要重做。放弃。

## 后果

- 好处：安装包不含原生二进制，arm64 / x64 / Windows 包内容与平台无关；遵守「不引入原生模块」。
- 代价 / 风险：如果以后要在主进程用 pdf.js 渲染页面（缩略图、栅格化），纯 JS 矩阵不够，需要重新评估（届时写新 ADR）。pdfjs-dist 升级后若用到 `DOMMatrix` 的其他方法，会在解析时抛错，需要补齐。
- 需要跟进的事：升级 pdfjs-dist 时跑一遍 `npm run dist:dir` 并检查 `app.asar.unpacked` 里没有 `.node`。
