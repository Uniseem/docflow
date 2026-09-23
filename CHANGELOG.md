# 更新日志

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增

- 工程骨架：Electron 44 + React 19 + HeroUI 3 空窗口可启动，含 lint/单测/图标与 `dist:dir` 打包。
- 翻译子系统：共享类型与设置存储、请求构造与错误分类、密钥轮换（600 s 下架）和自适应并发池（100→50→62→77→96→100）。
- 本地 mock 大模型服务（OpenAI / Anthropic / Gemini 接口与 08.3 故障注入）。
- 翻译批处理、占位符保护、回复校验、缓存、文档翻译阶梯与假服务商。
- 主进程日志（electron-log，文件滚动 8 MiB）。
- PDF 测试 fixture：08.2 合成样例与两篇 CC-BY arXiv 论文。
- PDF 解析：inspect、字形/行/栏/公式/段落、表单引用、analyze worker 与调试脚本。
- PDF 写回：内容流词法分析与遍历、CJK 字体嵌入、译文排版、公式重绘、双语 PDF 与校验。
- 文档库、任务调度、PDF 流水线与 IPC：`documents:create` 可跑通 inspect→翻译→写回，产出中文 PDF 与双语 PDF。
- 渲染进程界面：文档库、新建翻译、详情预览与导出、设置（服务商/网络/高级/关于）；E2E 七个场景通过。
- 打包后窗口可挂上 React：沙箱 preload 把 zod 打进 CJS（见 ADR-0009）。
- 代理设置生效；窗口大小与位置记忆；菜单「检查更新…」给出结果；双击 PDF 冷启动也能打开新建翻译。
- 服务商调研笔记：DeepSeek、Groq、月之暗面、小米 MiMo（`docs/reference/providers/`）。预设与请求代码尚未按调研结果修改。

### 变更

- 项目重建：主分支清空，旧代码移至 `old` 分支；新建标准仓库结构与 4.0 规划（Electron + React + HeroUI 3）。
- 设置了 `DOCFLOW_DATA_DIR` 时 Electron `userData` 也改到该目录下，E2E 不再改写真实用户目录里的 `host.json`。
- 退出或更换文档库不再把进行中的文档标成「已取消」，下次打开时从断点继续；取消与删除最多等待 5 秒。
- README 改为 4.0 的安装与使用说明；安装包不再包含 pdf.js 的可选原生模块。

### 修复

- 修复 M5 复查发现的 48 个问题：文档库打不开导致应用无法启动、处理记录为空或重复、列表随进度跳动、筛选计数错乱、获取模型列表静默失败、导出与错误提示等。
- 写回的每一页内容流混入压缩字节（MuPDF 等阅读器报错）；间接长度的图片流被截掉一个字节。
- 两栏论文被逐行打散：分栏检测、阅读顺序、斜体句子、图内文字、环绕图的段落合并。
- Ollama、LM Studio 等本机服务无需 API Key 时无法翻译。

## [3.1.0] - 2026-09-12

旧版本线（Rust 引擎 + BabelDOC）。见 `old` 分支与 GitHub Releases。

[Unreleased]: https://github.com/Uniseem/docflow/compare/v3.1.0...HEAD
[3.1.0]: https://github.com/Uniseem/docflow/releases/tag/v3.1.0
