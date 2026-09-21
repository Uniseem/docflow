# ADR-0001：用 Electron + React + HeroUI 3 重建桌面应用

- 状态：已采纳
- 日期：2026-09-21
- 相关：docs/plan/02-architecture.md

## 背景

3.x 版本由三部分组成：Rust 引擎（stdio JSON-RPC）、macOS SwiftUI 客户端、Windows WinUI 3 客户端，外加一个打包的 Python 运行时（BabelDOC）。两套原生界面要分别维护同一批功能和文案；CI 要装 Rust、.NET、Xcode、Python 并下载 1–2 GB 离线资源，一次构建 30–75 分钟；PDF 收尾阶段（字体子集化、保存）会卡死且难以定位。维护者是一个人，主要靠 AI 代理写代码。

## 决定

- 应用整体用 **Electron 44**（Chromium 152 / Node 24），一份代码同时出 Windows 与 macOS。
- 界面用 **React 19 + `@heroui/react` 3**（基于 React Aria Components + Tailwind CSS 4），状态用 zustand。
- 「后端」就是 Electron 主进程（Node.js），不再有独立引擎进程；CPU 密集的 PDF 解析与写回放在 `worker_threads` 里。
- 工程链：electron-vite 5（Vite 7）、electron-builder 26、vitest、Playwright、eslint + prettier，包管理用 npm。
- 全部 TypeScript，`strict`；主进程与渲染进程之间只通过 zod 校验过的 IPC 契约通信。

## 备选方案

- **Tauri 2（Rust 后端 + WebView）**：包更小，但 PDF 流水线要么写 Rust 要么塞进 WebView，前者回到「AI 写 Rust 编译慢」的老路，后者受浏览器沙箱限制（文件系统、线程）。放弃。
- **保留 Rust 引擎，只换界面为 Electron**：仍要维护 Rust 工具链与跨进程协议，CI 时间省不下来。放弃。
- **UI 库用 shadcn/ui 或 Ant Design**：都可行；选 HeroUI 3 是用户指定，它不需要 Provider、组件齐全、自带 AGENTS.md/llms.txt 便于代理查阅。

## 后果

- 好处：一套代码、一套文案；CI 只要 Node；热更新开发；代理熟悉的技术栈。
- 代价：安装包 ~120 MB（Electron 本体）；内存占用高于原生应用；macOS 上没有 Liquid Glass 等系统原生观感。
- 跟进：Electron 主版本每季度升级一次；关注 HeroUI 3 的 breaking change。
