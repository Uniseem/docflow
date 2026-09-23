# 文档索引

| 目录                                    | 放什么                                                                                 | 何时写                                      |
| --------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------- |
| [plan/](plan/README.md)                 | 4.0 的完整规划：目标、架构、算法、接口、界面、构建、测试、里程碑。**执行的唯一依据。** | 规划变更时改；执行中勾选 `09-milestones.md` |
| [adr/](adr/README.md)                   | 架构决策记录（Architecture Decision Record）：做了什么选择、备选方案、代价             | 每做一个不容易回头的技术决定                |
| [worklog/](worklog/README.md)           | 工作日志：每个会话做了什么、验证了什么、卡在哪、下一步                                 | 每个会话结束前                              |
| [reference/](reference/legacy-notes.md) | 参考资料：旧版本教训，以及 [服务商调研](reference/providers/README.md)（改预设前先更新） | 旧版本基本只读；服务商页随官方文档重核      |

约定：

- 全部用简体中文写，代码、路径、标识符保持原文。
- 文件名用 ASCII：`docs/plan/03-pdf-pipeline.md`、`docs/adr/0003-typescript-pdf-pipeline.md`、`docs/worklog/2026-09-21-bootstrap.md`。
- 文档里引用代码用相对路径加行号（`src/main/pipeline/analyze.ts:120`），方便点开。
- 改规划时保留原文的编号，不要重排章节号，其他文档都靠编号引用。
