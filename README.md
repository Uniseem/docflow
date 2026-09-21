# DocFlow

PDF 论文翻译桌面应用（Windows / macOS）。把带文本层的 PDF 拖进来，DocFlow 在本机分析版面，用你自己配置的大模型 API（DeepSeek、OpenAI、Claude、Gemini、通义、Kimi、智谱、Ollama 等）翻译正文，再按原版式写回，生成 **中文 PDF** 和 **双语对照 PDF**。公式、图表、表格原样保留。

## 状态

**4.0 重建中。** 本分支正在从零重写为 Electron + React + HeroUI 3 的纯 TypeScript 应用，目标是：

- 去掉 MinerU 依赖，只保留 PDF 原生翻译；
- 用自研的解析 / 写回流水线替代 BabelDOC + Python，解决翻译收尾阶段卡死的问题；
- 构建只需要 Node，CI 从几十分钟缩到几分钟。

规划文档在 [docs/plan/](docs/plan/README.md)，进度在 [docs/plan/09-milestones.md](docs/plan/09-milestones.md)。

旧版本 3.1.0（Rust 引擎 + BabelDOC，SwiftUI / WinUI 客户端）的源码在 [`old` 分支](https://github.com/Uniseem/docflow/tree/old)，安装包在 [Releases](https://github.com/Uniseem/docflow/releases)。

## 开发

需要 Node.js 24 与 npm。`package.json` 建好后：

```bash
npm ci
npm run dev
```

其余命令、目录约定与提交规范见 [AGENTS.md](AGENTS.md)。

## 许可

[MIT](LICENSE)。
