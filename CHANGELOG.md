# 更新日志

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增

- 工程骨架：Electron 44 + React 19 + HeroUI 3 空窗口可启动，含 lint/单测/图标与 `dist:dir` 打包。
- 翻译子系统：共享类型与设置存储、请求构造与错误分类、密钥轮换（600 s 下架）和自适应并发池（100→50→62→77→96→100）。
- 本地 mock 大模型服务（OpenAI / Anthropic / Gemini 接口与 08.3 故障注入）。

### 变更

- 项目重建：主分支清空，旧代码移至 `old` 分支；新建标准仓库结构与 4.0 规划（Electron + React + HeroUI 3）。

## [3.1.0] - 2026-09-12

旧版本线（Rust 引擎 + BabelDOC）。见 `old` 分支与 GitHub Releases。

[Unreleased]: https://github.com/Uniseem/docflow/compare/v3.1.0...HEAD
[3.1.0]: https://github.com/Uniseem/docflow/releases/tag/v3.1.0
