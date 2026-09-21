# ADR-0007：不签名分发；macOS 用 pkg + dmg，Windows 用 NSIS；CI 只依赖 Node

- 状态：已采纳
- 日期：2026-09-21
- 相关：docs/plan/07-build-ci-release.md

## 背景

没有 Apple Developer 与 Windows 代码签名证书。3.x 的经验：未签名的 `.pkg` 通过终端 `sudo installer` 安装后不会被 Gatekeeper 隔离，应用能直接打开；`.dmg` 里的应用则会被标记为「已损坏」。Windows 的 NSIS 安装包未签名只会有 SmartScreen 提示。

## 决定

- 打包用 electron-builder：
  - macOS：`pkg` + `dmg` + `zip`，分别出 `arm64` 与 `x64`，在一台 `macos-15` runner 上交叉打包（纯 JS 应用可以）。不做 universal（包翻倍）。
  - Windows：NSIS，按用户安装（不要管理员权限），可选安装目录，`DocFlow-<version>-win-x64-setup.exe`。
- README 与 Release 说明继续提供 macOS 的一行终端安装命令。
- 自动更新：不接 electron-updater（未签名的 macOS 应用不能自动更新）；「关于」页做一个「检查更新」，请求 GitHub Releases API，有新版本就给下载链接。
- CI（GitHub Actions）：`ci.yml` 跑 check + 两平台打包冒烟 + E2E；`release.yml` 在 `v*` 标签时打安装包并 `gh release create`。只需要 `actions/setup-node`，缓存 npm 与 Electron 二进制。目标：CI 10 分钟内，发布 15 分钟内。
- 签名与公证以后加：electron-builder 在检测到 `CSC_LINK` / `CSC_KEY_PASSWORD` / `APPLE_ID` 等环境变量时会自动签名与公证，工作流预留这些 secrets 的读取即可。

## 备选方案

- 只出 dmg：用户要手动 `xattr`，体验差。放弃。
- universal 二进制：包 2 倍大，下载慢。放弃。

## 后果

- 好处：构建流程只有 `npm ci && npm run build && electron-builder`；CI 从 30–75 分钟降到几分钟。
- 代价：SmartScreen / Gatekeeper 提示仍在；macOS 用户要用终端或到隐私设置里放行。
