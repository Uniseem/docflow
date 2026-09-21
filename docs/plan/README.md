# DocFlow 4.0 规划总览

> 面向执行者（人或 AI 代理）的完整规划。目标是**一次性、不回头地**把 4.0 做出来。每一章都尽量给出可以直接照抄的决定：版本号、目录、类型定义、算法参数、文案。不确定的地方规划已经替你选了；如果执行中发现规划不可行，改规划、写 ADR/worklog，再继续，不要私下绕过。

## 章节

| 章 | 内容 | 什么时候读 |
| --- | --- | --- |
| [01 目标与范围](01-goals-and-scope.md) | 做什么、不做什么、成功标准、来自 3.x 的硬性要求 | 开工前 |
| [02 架构与工程](02-architecture.md) | 进程模型、目录结构、`package.json` 全文、各配置文件全文、依赖版本 | M0 |
| [03 PDF 流水线](03-pdf-pipeline.md) | 检查 → 解析 → 段落合并 → 公式识别 → 翻译 → 写回 → 双语 → 校验，含所有阈值 | M2、M3 |
| [04 翻译子系统](04-translation.md) | 服务商预设、请求/响应、错误分类、密钥轮换、并发池、批处理、占位符、重试阶梯、缓存、提示词原文 | M1 |
| [05 IPC 与数据](05-ipc-and-data.md) | 文档库目录、`manifest.json`、`settings.json`、密钥存储、事件文件、IPC 通道与 zod schema、任务调度 | M1、M4 |
| [06 界面规格](06-ui-spec.md) | 每个页面的布局、组件（HeroUI 3）、状态、文案、交互流程、快捷键、主题 | M5 |
| [07 构建、CI 与发布](07-build-ci-release.md) | electron-builder 配置、图标、工作流、版本与标签、发布说明 | M0、M6 |
| [08 测试](08-testing.md) | 单测范围、fixture 生成、mock 大模型服务、E2E、验收清单 | 每个里程碑 |
| [09 里程碑与任务清单](09-milestones.md) | 按顺序的任务清单（带勾选框）与每个里程碑的验收标准 | 每次开工 |

## 一句话架构

Electron 44 单应用：主进程（Node 24）负责文档库、任务调度、大模型请求（`net.fetch`）；PDF 解析与写回在 `worker_threads` 里用 pdf.js + pdf-lib 完成；行内公式通过隐藏窗口里的 pdf.js 栅格化后贴回；渲染进程是 React 19 + HeroUI 3 的单页界面，通过 contextBridge 暴露的类型化 IPC 与主进程通信；数据全部是文件（JSON / JSONL / PDF）。

## 执行顺序（详见 09 章）

```
M0 工程骨架        package.json、electron-vite、HeroUI、lint/test、CI 变绿、空窗口能跑
M1 共享层与翻译    shared 类型 + zod、settings/secrets、providers、translation pool、mock 服务、单测
M2 PDF 解析        inspect + analyze（pdf.js）、fixture 生成器、单测
M3 PDF 写回        compose（pdf-lib）+ raster 窗口 + dual + verify、单测
M4 流水线与文档库  library、scheduler、pipeline 串起来、IPC、事件；命令行冒烟
M5 界面            文档库、新建翻译、文档详情、设置、主题；E2E
M6 打包与发布      electron-builder、图标、README、release 流程、打 v4.0.0-beta.1 标签验证
M7 收尾            通知、更新检查、无障碍、性能、已知问题清单
```

每个里程碑结束：`npm run check` 全绿 → 提交 → 勾选 09 章 → 写 worklog。

## 完成的定义（Definition of Done）

4.0.0 可以发布，当且仅当：

1. 在 Windows 10/11 x64 与 macOS 14+（Apple 芯片与 Intel）上，从 GitHub Release 下载安装包能装、能开、能用；
2. 用 `tests/fixtures/` 里的全部样例 PDF 和至少 5 篇真实 arXiv 论文（两栏、含公式与图表）跑通「拖入 → 翻译 → 中文 PDF + 双语 PDF」，输出页数、尺寸正确，正文段落已翻译，公式与图表完好；
3. 任一段落翻译或写回失败不会让整份文档失败（保留原文并在处理记录里给出警告）；
4. 拔网线 / 无效 Key / 模型不存在 / 加密 PDF / 扫描件，每种情况都有明确的中文错误提示，且应用不崩溃、任务可取消；
5. 关闭应用再打开，进行中的任务从断点继续，已翻译的段落不重新计费；
6. CI 全绿，`release.yml` 从打标签到 Release 出现不超过 20 分钟；
7. `docs/` 与实际实现一致（09 章全部勾选，ADR 与 worklog 齐全）。

## 给执行者的提醒

- 先跑 `npx heroui-cli@latest agents-md --react --output .heroui-docs/AGENTS.md` 把 HeroUI 3 文档拉到本地（`.heroui-docs/` 已在 `.gitignore`），组件用法以它为准；本规划里写的组件 API 来自 3.2.x 文档，如有出入以本地文档为准。**不要**让它覆盖仓库根目录的 `AGENTS.md`。
- 遇到 npm 包版本与 02 章不一致（新的 patch/minor），用 02 章给的 caret 范围内的最新版即可；major 不同时停下来按 02 章的说明处理。
- 所有中文文案以 06 章和 `docs/reference/legacy-notes.md` 为准，不要自己改措辞。
- 一次只开一个 PR/分支也可以，直接在 `main` 上按里程碑提交也可以；发布只认 `v*` 标签。
