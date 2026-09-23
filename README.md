# DocFlow

PDF 论文翻译桌面应用（Windows / macOS）。把带文本层的 PDF 拖进来，DocFlow 在本机分析版面，用你自己配置的大模型 API（DeepSeek、通义、Kimi、智谱、OpenAI、Claude、Gemini、Ollama 等）翻译正文，再按原版式写回，生成 **中文 PDF** 和 **双语对照 PDF**。公式、图表、表格保持原样。

4.0 是一次完全重写：Electron + React + HeroUI 3，全部 TypeScript，不再需要 MinerU、Python 或 BabelDOC。

## 下载与安装

安装包在 [Releases](https://github.com/Uniseem/docflow/releases)。应用没有代码签名，下面的步骤会绕过系统的「未知开发者」拦截。

### Windows 10 / 11（x64）

下载 `DocFlow-<版本>-win-x64-setup.exe` 双击安装。Windows 提示「Windows 已保护你的电脑」时，点「更多信息 → 仍要运行」。更新时直接安装新版本，文档库和设置都会保留。

### macOS 14 及以上（Apple 芯片或 Intel）

打开「终端」，粘贴下面这行命令并回车，然后输入这台 Mac 的登录密码（输入时不显示字符）：

```bash
ARCH=$([ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = 1 ] && echo arm64 || echo x64); URL=$(curl -fsSL https://api.github.com/repos/Uniseem/docflow/releases/latest | grep -o "https://[^\"]*-macos-$ARCH\.pkg" | head -1); curl -fL -o /tmp/DocFlow.pkg "$URL" && sudo installer -pkg /tmp/DocFlow.pkg -target / && rm -f /tmp/DocFlow.pkg
```

命令会下载适合这台 Mac 的最新正式版并装到「应用程序」；终端显示 `The install was successful.` 即完成。每个版本的 Release 说明里也有一行带版本号的命令，测试版（beta）要用那一行。

也可以下载 `.dmg` 拖进「应用程序」，但第一次打开会被拦下，需要到「系统设置 → 隐私与安全性」点「仍要打开」。

## 使用

1. **配置翻译服务**：第一次打开会进入「设置 → 翻译服务」。点 `+` 选一个服务商（推荐 DeepSeek，便宜且快），粘贴 API Key，点「获取模型列表…」勾选模型，再点模型旁的「检查」确认可用。多个 Key 用英文逗号分隔，请求会轮流使用。
2. **翻译**：把 PDF 拖进窗口（或点「新建翻译」），选择模型后开始。可以一次拖入多份，同时处理的文档数在「设置 → 通用」里调整。
3. **查看与导出**：处理完成后在右侧预览「中文」「双语对照」「原文」，用「导出」保存 PDF 或打包 ZIP。处理记录里能看到每个阶段的进展、用量和警告。
4. **失败与重试**：网络中断、限流会自动重试；Key 无效、模型不存在、加密 PDF、扫描件等会直接给出原因和下一步。失败或已取消的文档可以「重新处理」，已翻译的段落不会重复计费。关闭应用后再打开，进行中的任务从断点继续。

需要代理时在「设置 → 网络」选择「跟随系统」「不使用代理」或填写自定义代理地址。

## 数据与隐私

- 文档库默认在 macOS `~/Library/Application Support/DocFlow`、Windows `%APPDATA%\DocFlow`，可在「设置 → 通用 → 文档库」更改。里面是源文件副本、译文 PDF、处理记录和日志，都是普通文件。
- API Key 只保存在本机，用系统加密（macOS 钥匙串 / Windows DPAPI）保护。
- 应用只访问你配置的大模型服务商；「检查更新」会访问 GitHub。没有统计或上报。

## 已知问题

1. 没有版面模型：表格内的长单元格会被当作段落翻译，可能与表格线重叠；三栏及以上、复杂浮动排版的阅读顺序可能错乱。
2. 行内分式的横线是图形而不是文字，公式搬动后横线会留在原处。
3. 斜体、等宽字体的短片段按公式处理、保留原文；三个单词以上的斜体句子才翻译。
4. 页眉页脚、图表轴标签、图例不翻译。
5. 译文比原文长时可能溢出到下一段的位置（不截断）。
6. 旋转页面、竖排、从右到左的文字、多页共用的表单里的文字不翻译；扫描件（没有文本层）不支持，也没有 OCR。

## 开发

需要 Node.js 24 与 npm。

```bash
npm ci
npm run dev      # 开发模式
npm run check    # typecheck + lint + 单元测试
npm run dist     # 打当前平台的安装包到 release/
```

其余命令、目录约定与提交规范见 [AGENTS.md](AGENTS.md)，规划与进度见 [docs/plan/](docs/plan/README.md)。

旧版本 3.x（Rust 引擎 + BabelDOC，SwiftUI / WinUI 客户端）的源码在 [`old` 分支](https://github.com/Uniseem/docflow/tree/old)，不再维护。

## 许可

[MIT](LICENSE)。第三方组件的许可见随应用分发的 `THIRD_PARTY_NOTICES.md`（「设置 → 关于」里可以打开）。
