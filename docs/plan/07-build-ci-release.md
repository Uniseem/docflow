# 07 构建、CI 与发布

## 7.1 `electron-builder.yml`

```yaml
appId: com.uniseem.docflow
productName: DocFlow
copyright: Copyright © 2026 DocFlow contributors
artifactName: ${productName}-${version}-${os}-${arch}.${ext} # DocFlow-4.0.0-win-x64-setup.exe 由 nsis.artifactName 覆盖
directories:
  output: release
  buildResources: build
files:
  - out/**
  - package.json
  - '!**/*.map'
extraResources:
  - from: resources/fonts
    to: fonts
    filter: ['*.otf']
  - from: node_modules/pdfjs-dist/standard_fonts
    to: pdfjs/standard_fonts
  - from: node_modules/pdfjs-dist/cmaps
    to: pdfjs/cmaps
  - from: THIRD_PARTY_NOTICES.md
    to: THIRD_PARTY_NOTICES.md
  - from: LICENSE
    to: LICENSE
asar: true
compression: normal
npmRebuild: false # 没有原生模块
mac:
  category: public.app-category.productivity
  target:
    - target: dmg
    - target: pkg
    - target: zip
  artifactName: ${productName}-${version}-macos-${arch}.${ext}
  minimumSystemVersion: '14.0'
  hardenedRuntime: false # 未签名；签名时改 true 并配 entitlements
  gatekeeperAssess: false
  extendInfo:
    CFBundleDocumentTypes:
      - CFBundleTypeName: PDF
        CFBundleTypeRole: Viewer
        LSHandlerRank: Alternate
        LSItemContentTypes: [com.adobe.pdf]
    NSHumanReadableCopyright: Copyright © 2026 DocFlow contributors
pkg:
  isRelocatable: false
  overwriteAction: upgrade
  allowAnywhere: false
  allowCurrentUserHome: false
dmg:
  writeUpdateInfo: false
win:
  target:
    - target: nsis
      arch: [x64]
  artifactName: ${productName}-${version}-win-${arch}-setup.${ext}
  fileAssociations:
    - ext: pdf
      name: PDF
      role: Viewer # 只注册「打开方式」，不抢默认
nsis:
  oneClick: false
  perMachine: false
  allowToChangeInstallationDirectory: true
  allowElevation: false
  createDesktopShortcut: always
  createStartMenuShortcut: true
  shortcutName: DocFlow
  deleteAppDataOnUninstall: false
  language: 2052
  installerLanguages: [zh_CN]
  runAfterFinish: true
publish: null
```

主进程读取资源路径：`app.isPackaged ? join(process.resourcesPath, 'fonts') : join(app.getAppPath(), 'resources/fonts')`；pdf.js 的 `standardFontDataUrl`/`cMapUrl` 同理（开发时指向 `node_modules/pdfjs-dist/...`），注意 pdf.js 需要以 `/` 结尾的 URL 或路径字符串。

## 7.2 图标

`build/icon.png`（1024×1024，从 `old` 分支 `apps/shared/AppIcon-1024.png` 取：`git show old:apps/shared/AppIcon-1024.png > build/icon.png`）。`scripts/make-icons.mjs` 用 `png2icons`（devDependency，纯 JS）生成 `build/icon.icns` 与 `build/icon.ico`；三者都提交到仓库，脚本只在换图时跑。

## 7.3 第三方许可

`scripts/third-party-notices.mjs`（在 `npm run build` 前由 `prebuild` 钩子执行）：读取 `package-lock.json` 里 `dependencies` 的生产依赖树，汇总每个包的 `license` 与 `LICENSE` 文件内容到 `THIRD_PARTY_NOTICES.md`；开头固定一段：Electron（MIT）、Chromium（BSD）、Node.js（MIT）、pdf.js（Apache-2.0）、pdf-lib/@cantoo（MIT）、fontkit（MIT）、Noto Sans SC（OFL-1.1）。渲染进程的 devDependencies（React、HeroUI、Tailwind、zustand、lucide）也要列入（它们被打进 bundle）——脚本按 `src/renderer` 的 import 图无法精确得到，简单做法：列一个手工维护的 `scripts/bundled-deps.json` 数组。

## 7.4 CI（`.github/workflows/ci.yml`，已在仓库中）

- 触发：push `main`、PR、手动。`hashFiles('package.json') != ''` 守卫让空仓库阶段自动跳过。
- `check`（ubuntu）：`npm ci` → `npm run check`。目标 ≤ 4 分钟。
- `package`（windows-latest、macos-15）：`npm ci` → `npm run build` → `electron-builder --dir` → `npm run test:e2e`（E2E 用 `--dir` 产物，`DOCFLOW_DATA_DIR` 指向临时目录，mock 服务在 Playwright `globalSetup` 里启动）。缓存 Electron 下载。目标 ≤ 10 分钟。
- 不上传安装包。

## 7.5 发布（`.github/workflows/release.yml`，已在仓库中）

1. 本地：更新 `CHANGELOG.md`（Unreleased → 版本），`npm version 4.0.0 --no-git-tag-version`，提交 `chore: 发布 4.0.0`，`git tag v4.0.0`，`git push origin main v4.0.0`。
2. 工作流：两台 runner 并行打包（Windows x64；macOS 在一台 arm64 runner 上打 arm64 + x64），校验标签 == 版本，跑 `check`，上传工件；`publish` job 合并工件、生成 `SHA256SUMS.txt`、用 `.github/release-notes.md`（`__VERSION__` 替换）建 Release。
3. 产物名：`DocFlow-4.0.0-win-x64-setup.exe`、`DocFlow-4.0.0-macos-arm64.pkg/.dmg/.zip`、`DocFlow-4.0.0-macos-x64.pkg/.dmg/.zip`、`SHA256SUMS.txt`。
4. 先用 `v4.0.0-beta.1` 演练一次（prerelease：在 publish 步骤给 `gh release create` 加 `--prerelease`，当标签含 `-` 时）。

## 7.6 签名（预留，不在 4.0.0 范围）

electron-builder 读取环境变量自动签名：macOS `CSC_LINK`（p12 base64）、`CSC_KEY_PASSWORD`、公证 `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`；Windows `WIN_CSC_LINK`、`WIN_CSC_KEY_PASSWORD`。届时把 `mac.hardenedRuntime` 改 `true`、加 `build/entitlements.mac.plist`（`com.apple.security.cs.allow-jit` 等 Electron 默认项），并在 `release.yml` 里把这些 secrets 映射到 env。

## 7.7 本地打包检查清单

- `npm run dist:dir` 后启动 `release/mac-arm64/DocFlow.app` 或 `release/win-unpacked/DocFlow.exe`，确认：字体路径正确（写回成功）、pdf.js 的 cmaps 路径正确（含 CJK 字体的 PDF 能解析）、`docflow://` 预览正常、日志在文档库 `logs/`。
- 安装包体积 ≤ 130 MB；`npx electron-builder --dir` 的 `app.asar` 里没有 `tests/`、`docs/`、`.map`。
- Windows：安装到含中文的路径也能启动；卸载不删文档库。
- macOS：`sudo installer -pkg … -target /` 后应用能直接打开；`.dmg` 拖入后首次打开需要在隐私设置放行（写在 README）。
