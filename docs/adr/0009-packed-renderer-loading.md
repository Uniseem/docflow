# ADR-0009：沙箱 preload 把 zod 打进 CJS；渲染进程保持 module 脚本与严格 CSP

- 状态：已采纳（2026-09-23 修订：撤销内联经典脚本方案）
- 日期：2026-09-22，修订 2026-09-23
- 相关：M5-7、docs/plan/02-architecture.md、docs/plan/07-build-ci-release.md

## 背景

M5 用 Playwright 启动 `--dir` 产物时，窗口一直空白。排查中确认了一个真实问题，另有一个误判。

1. **沙箱 preload 不能 `require('zod')`（真实问题）。** `sandbox: true` 的 preload 只能用 Electron 允许的内置模块。`src/shared/ipc.ts` 顶层 import zod，preload 再 import 通道表，electron-vite 默认 `externalizeDepsPlugin()` 把 zod 留在 `node_modules`。打包后 preload 报错，`window.docflow` 不存在。
2. **「asar 里的 ES module 脚本不执行」（误判）。** 修好 preload 后 `#root` 仍然为空，当时（2026-09-22 会话）归因于 asar/`file://` 上的 module 脚本，于是把 JS/CSS 内联成经典脚本、CSP 放开 `'unsafe-inline'`、`asarUnpack: out/renderer/**`，还试了自定义 `dfapp://` 协议。
   2026-09-23 复查：module 脚本在 asar 里正常加载并执行（`onload` 触发、`import()` 成功，React 已挂上 `#root`）。空白的真正原因是 `App.tsx` 把整个界面包在 `<Toast.Provider>` 里——HeroUI 3 的 `Toast.Provider` 是 toast 区域，`children` 是每条 toast 的渲染模板，不是应用内容，没有 toast 时什么都不渲染。开发模式同样空白。
   内联方案本身还有缺陷：`scripts/inline-renderer.mjs` 用 `String.replace` 的字符串替换参数，bundle 里的 `$$`、`` $` ``、`$&` 被当成替换模式，把 HTML 头部拼进了 JS，界面显示成一堆源码（乱码）。

## 决定

- preload：`externalizeDepsPlugin({ exclude: ['zod'] })`，把 zod 打进 `out/preload/index.cjs`（约 197 KB）。
- 渲染进程：维持规划原样——`npm run build` = `electron-vite build`；生产窗口 `loadFile(out/renderer/index.html)`，文件留在 asar 里；Vite 产出的 `<script type="module" crossorigin>` 不做改写；CSP 维持 `script-src 'self'`，不加 `'unsafe-inline'`、`file:`。
- `Toast.Provider` 作为独立节点放在应用根部（与界面并列），不包任何内容。
- 删除 `scripts/inline-renderer.mjs`、`asarUnpack`、`dfapp://` 协议与 `stripCrossorigin` 插件。

## 备选方案

- **内联经典脚本 + `'unsafe-inline'`**：没有解决任何真实问题，还削弱 CSP、引入替换模式破坏 bundle 的风险。撤销。
- **自定义协议加载 renderer（`dfapp://`）**：同上，撤销。
- **关掉 sandbox**：能 `require('zod')`，但与 2.6 安全设定冲突。放弃。
- **preload 不 import `src/shared/ipc.ts`，手写通道名白名单**：能避开 zod，但通道表会分叉。放弃。

## 后果

- 好处：打包与开发一致，CSP 保持严格；构建没有额外步骤。
- 代价：preload 变大（zod 约 190 KB）。控制台会有一条 zod 试探 `new Function` 被 CSP 拦下的报告，无害。
- 教训：界面空白先看 React 是否挂上 `#root`、组件树是否渲染了内容，再怀疑加载链路。HeroUI 3 的 Provider 类组件要看文档确认 `children` 的含义。
