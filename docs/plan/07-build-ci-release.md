# 07 构建、CI 与发布

## 7.1 `electron-builder.yml`

```yaml
appId: com.uniseem.docflow
productName: DocFlow
copyright: Copyright © 2026 DocFlow contributors
artifactName: ${productName}-${version}-${os}-${arch}.${ext}
directories:
  output: release
  buildResources: build
files:
  - out/**
  - package.json
  - '!**/*.map'
  - '!**/node_modules/@napi-rs/**' # pdf.js optional native canvas; DOMMatrix is polyfilled
  # onnxruntime-web: only the Node entry and the SIMD+threads WebAssembly build are loaded.
  - '!**/node_modules/onnxruntime-web/dist/**'
  - '**/node_modules/onnxruntime-web/dist/ort.node.min.mjs'
  - '**/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs'
  - '**/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm'
  # mupdf (MuPDF.js): the page renderer pdf2zh uses, as WebAssembly; types are not needed.
  - '!**/node_modules/mupdf/dist/*.d.ts'
asarUnpack:
  # WebAssembly and the worker threads onnxruntime-web starts itself load these from disk.
  - '**/node_modules/onnxruntime-web/dist/**'
  - '**/node_modules/mupdf/dist/**'
extraResources:
  - from: resources/fonts
    to: fonts
    filter: ['*.ttf']
  - from: resources/models
    to: models
    filter: ['*.onnx']
  - from: THIRD_PARTY_NOTICES.md
    to: THIRD_PARTY_NOTICES.md
  - from: LICENSE
    to: LICENSE
asar: true
compression: normal
npmRebuild: false
mac:
  category: public.app-category.productivity
  target:
    - target: dmg
    - target: pkg
    - target: zip
  artifactName: ${productName}-${version}-macos-${arch}.${ext}
  minimumSystemVersion: '14.0'
  hardenedRuntime: false
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
      role: Viewer
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

`extraResources` 按 `*.ttf` 复制 `resources/fonts/` 下的全部字体，即 `src/main/pdf/babeldoc/fonts.json` 列出的 BabelDOC 15 个字体（思源宋体、思源黑体各常规/粗体，Noto Serif、Noto Sans 各常规/粗体/斜体/粗斜体，霞鹜文楷 GB，Go Noto Kurrent 常规/粗体；共约 109 MB 未压缩，ADR-0018）；除 `SourceHanSerifCN-Regular.ttf` 外都不在 git 里，打包前必须先 `npm run assets`（`prebuild` 会自动跑，缺文件或哈希不对时脚本失败）。

主进程读取资源路径：字体为 `app.isPackaged ? join(process.resourcesPath, 'fonts') : join(app.getAppPath(), 'resources/fonts')`（`AppSession` 算好后传给 `createPipelineHooks({ fontsDir })`，再交给 `src/main/pipeline/run.ts` 的 `bundledFonts(root)`；单测与脚本不传，默认 `<cwd>/resources/fonts`。2026-09-24 前按 `process.resourcesPath` 是否存在判断，未打包的 Electron 也有这个值，`npm run dev` 下找不到字体）。pdf.js 的 `standardFontDataUrl`/`cMapUrl` 在开发与打包后都用 `require.resolve('pdfjs-dist/package.json')` 定位 `node_modules/pdfjs-dist/{standard_fonts,cmaps}`（打包后在 `app.asar` 里，`src/main/pdf/pdfjs.ts`），并转成以 `/` 结尾的 `file:` URL（pdf.js 要求）。因此 extraResources 不再复制 `pdfjs/{standard_fonts,cmaps}`（原先那份没有被读取，与 asar 里的重复，约 2.4 MB；2026-09-24 删除，见 worklog 2026-09-23-m5-fixes）。

E2E 启动的是 `electron-builder --dir` 产物，改渲染进程或主进程后必须重新 `npm run dist:dir`，否则测的是旧代码。

## 7.2 图标

`build/icon.png`（1024×1024，从 `old` 分支 `apps/shared/AppIcon-1024.png` 取：`git show old:apps/shared/AppIcon-1024.png > build/icon.png`）。`scripts/make-icons.mjs` 用 `png2icons`（devDependency，纯 JS）生成 `build/icon.icns` 与 `build/icon.ico`；三者都提交到仓库，脚本只在换图时跑。

## 7.3 第三方许可

`scripts/third-party-notices.mjs`（在 `npm run build` 前由 `prebuild` 钩子执行）：读取 `package.json` 的 `dependencies` 与 `package-lock.json` 里所有非 dev 的顶层包，汇总每个包的 `license` 与 `LICENSE` 文件内容到 `THIRD_PARTY_NOTICES.md`（生成物，已 gitignore）；不随应用分发的包不列：`electron-builder.yml` 排除的 `@napi-rs/*`（ADR-0010），以及 lock 里标为 optional 且本机没装的平台二进制包；开头固定一段：Electron（MIT）、Chromium（BSD）、Node.js（MIT）；PDF 部分说明处理逻辑移植自 PDFMathTranslate 1.9.11（AGPL-3.0）与 pdfminer.six（MIT），排版、翻译提示词、术语表、字体选择、双语输出与扫描件判定移植自 BabelDOC 0.6.4（AGPL-3.0，PDFMathTranslate-next 的引擎），列出 MuPDF.js（AGPL-3.0-or-later，含该组件的安装包按 AGPL-3.0 分发）、onnxruntime-web（MIT）、DocLayout-YOLO-DocStructBench 权重（Apache-2.0）、pdf.js（Apache-2.0）、pdf-lib/@cantoo（MIT）、fontkit（MIT）、gpt-tokenizer（MIT，o200k_base 编码来自 OpenAI tiktoken，MIT）、BabelDOC-Assets 的字体（SIL OFL 1.1，见 `resources/fonts/LICENSE-OFL.txt`：Adobe 的思源宋体、思源黑体 CN，Noto Project 的 Noto Serif、Noto Sans、Go Noto Kurrent，LXGW 的霞鹜文楷 GB）、Adobe Glyph List（BSD-3-Clause）。`gpt-tokenizer` 是 devDependency（打进主进程 bundle），在「Bundled main-process dependencies」一节附 LICENSE 全文。渲染进程的 devDependencies 也要列入（它们被打进 bundle）——脚本按 `src/renderer` 的 import 图无法精确得到，所以读手工维护的 `scripts/bundled-deps.json` 数组（现为 react、react-dom、@heroui/react、@heroui/styles、tailwindcss、zustand、lucide-react、clsx）；渲染进程新增依赖时要同步加进去。

## 7.4 CI（`.github/workflows/ci.yml`，已在仓库中）

- 触发：push `main`、PR、手动；同一 ref 的新运行会取消旧运行；`permissions: contents: read`。（原规划的 job 级 `hashFiles('package.json')` 守卫在 Actions 里不合法，M0 已删除，见 worklog 2026-09-22-m0-skeleton。）
- 两个 job 都用 `actions/setup-node`（版本取 `.nvmrc`，缓存 npm）。
- `check`（ubuntu-latest，超时 15 分钟）：`npm ci` → 缓存 `resources/models` 与 `resources/fonts/*.ttf`（步骤名 `缓存版面模型与字体`，key 为 `assets-` 加 `hashFiles('scripts/fetch-assets.mjs', 'src/main/pdf/babeldoc/fonts.json')`）→ `npm run assets`（步骤名 `下载版面模型与 BabelDOC 字体（约 170 MB）`；已缓存则只校验 SHA3-256）→ `npm run check`。单测里有真实的版面检测（MuPDF.js + 模型）与字体，`npm run check` 的第一步 `verify:fonts` 也要求字体齐全，所以要先下载。目标 ≤ 5 分钟。
- `package`（`needs: check`；windows-latest、macos-15；超时 30 分钟）：`npm ci` → 缓存并下载模型与字体（同上）→ `npm run build` → `npx electron-builder --dir --publish never` → `npm run test:e2e`（E2E 用 `--dir` 产物，`DOCFLOW_DATA_DIR` 由 `tests/e2e/helpers.ts` 指向临时目录，mock 服务在 Playwright `globalSetup` 里启动）。缓存 Electron 与 electron-builder 的下载（key 为 `package-lock.json` 的哈希）。目标 ≤ 10 分钟。
- 不上传安装包，也不上传 Playwright 报告。

## 7.5 发布（`.github/workflows/release.yml`，已在仓库中）

1. 本地：更新 `CHANGELOG.md`（Unreleased → 版本），`npm version 4.1.0 --no-git-tag-version`，提交 `chore: 发布 4.1.0`，`git tag v4.1.0`，`git push origin main v4.1.0`（4.0.0、4.0.1 同样这样发布）。
2. 工作流：`build` job（超时 40 分钟）三台 runner 并行打包（Windows x64：windows-latest，`--win --x64`；macOS arm64 与 x64 各一台 macos-15（arm64）runner，分别 `--mac --arm64`、`--mac --x64`）。macOS 不能在一次运行里同时打两个架构：pkg 目标把中间组件包 `<appId>.pkg` 与 `distribution.xml` 以固定文件名写在 `release/` 下，两个架构并行时互相删文件（2026-09-25 演练时 `unlink … com.uniseem.docflow.pkg` ENOENT），还可能串架构。每台依次缓存 Electron 下载（key 为 `electron-<win-x64|macos-arm64|macos-x64>-` 加 `package-lock.json` 的哈希）→ `npm ci` → 缓存并下载版面模型与字体（`npm run assets`，缓存 key 同 7.4）→ 校验标签 == `package.json` 版本 → `npm run check` → `npm run build` → `npx electron-builder <参数> --publish never`，把 `release/DocFlow-*.{exe,dmg,pkg,zip}` 上传为工件 `installers-<win-x64|macos-arm64|macos-x64>`（保留 7 天，缺文件即失败）；`publish` job（ubuntu-latest）合并工件、`sha256sum` 生成 `SHA256SUMS.txt`、用 `.github/release-notes.md`（`__VERSION__` 替换）`gh release create --verify-tag` 建 Release。工作流也能手动触发（`workflow_dispatch`）：选 `v*` 标签时与推送标签完全一样；选分支时跳过标签校验、不跑 `publish` job，只打包并上传工件（用来演练打包）。标签校验步骤与 `publish` job 都以 `startsWith(github.ref, 'refs/tags/v')` 为条件，发布只由 `v*` 标签触发。
3. 产物名（以 4.1.0 为例）：`DocFlow-4.1.0-win-x64-setup.exe`、`DocFlow-4.1.0-macos-arm64.pkg/.dmg/.zip`、`DocFlow-4.1.0-macos-x64.pkg/.dmg/.zip`、`SHA256SUMS.txt`。
4. 先用 `v4.0.0-beta.1` 演练一次：版本号含 `-` 时 publish 步骤自动给 `gh release create` 加 `--prerelease`。（4.0.0 实际没有打 beta 标签：维护者决定直接发布，改为在 `main` 上手动触发一次 release.yml 只打包不发布作为演练，通过后打 `v4.0.0`；见 worklog 2026-09-25-release。）

## 7.6 签名（预留，不在 4.0.0 范围）

electron-builder 读取环境变量自动签名：macOS `CSC_LINK`（p12 base64）、`CSC_KEY_PASSWORD`、公证 `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`；Windows `WIN_CSC_LINK`、`WIN_CSC_KEY_PASSWORD`。届时把 `mac.hardenedRuntime` 改 `true`、加 `build/entitlements.mac.plist`（`com.apple.security.cs.allow-jit` 等 Electron 默认项），并在 `release.yml` 里把这些 secrets 映射到 env。

## 7.7 本地打包检查清单

- `npm run dist:dir` 后启动 `release/mac-arm64/DocFlow.app` 或 `release/win-unpacked/DocFlow.exe`，确认：`Resources/models/` 有版面模型、`Resources/fonts/` 有 `fonts.json` 列出的全部 15 个字体（缺文件时写回查字形就出错，文档以内部错误失败）；`app.asar.unpacked/node_modules/` 下有 `mupdf/dist` 与 `onnxruntime-web/dist`（只含 `ort.node.min.mjs`、`ort-wasm-simd-threaded.{mjs,wasm}`）；版面检测与写回成功、pdf.js 的 cmaps 路径正确、`docflow://` 预览正常、日志在文档库 `logs/`。
- 安装包体积：2026-09-26 起含 75 MB 版面模型、约 11 MB 的 MuPDF.js、约 14 MB 的 onnxruntime-web wasm（ADR-0016，维护者选择打包），原 130 MB 目标不再适用；`npx electron-builder --dir` 的 `app.asar` 里没有 `tests/`、`docs/`、`.map`，`app.asar.unpacked` 里没有 `.node`（ADR-0010）。
  - 2026-09-23 实测（macOS arm64，`npm run dist`）：dmg 155.6 MB、pkg 155.8 MB、zip 155.8 MB，超出目标；是调整目标还是只带一个字重，待维护者决定（worklog 2026-09-23-m5-fixes）。2026-09-25 维护者决定 4.0.0 按现有体积发布，目标留待之后再议。
  - 4.1.0 起另带 BabelDOC 的 14 个字体（4.0.x 已有思源宋体常规，约 14 MB；新增约 95 MB 未压缩，ADR-0018）。4.1.0 安装包的实测体积还没有记录，发布后补在这里。
- Windows：安装到含中文的路径也能启动；卸载不删文档库。
- macOS：`sudo installer -pkg … -target /` 后应用能直接打开；`.dmg` 拖入后首次打开需要在隐私设置放行（写在 README）。
