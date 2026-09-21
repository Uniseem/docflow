# 08 测试

## 8.1 层次

| 层 | 工具 | 范围 | 何时跑 |
| --- | --- | --- | --- |
| 单元 | vitest（node 环境） | `src/shared/**`、`src/main/**` 的纯函数与模块：解析、段落合并、公式识别、排版、翻译请求/响应/错误/池/批处理/占位符、设置与 manifest 的 zod、原子写、调度器（用假时钟） | `npm run check`，每次提交 |
| 集成 | vitest + `tests/mock-provider` | 从 fixture PDF 到输出 PDF 的完整流水线（不启动 Electron：`net.fetch` 换成 Node fetch，栅格化换成「假贴图」——用 pdf-lib 画一个灰色占位矩形代替 PNG） | `npm run check` |
| E2E | Playwright `_electron` | 真实应用：拖入/选择文件 → 设置里配置 mock 服务商 → 翻译完成 → 预览、导出、取消、重试、删除、设置持久化 | CI `package` job；发布前 |
| 手工 | 人 | 真实 arXiv 论文 5 篇 + 真实服务商 1 个（DeepSeek）| 里程碑 M5、M6 |

## 8.2 fixture 生成（`scripts/make-fixtures.mjs`，用 `@cantoo/pdf-lib` + 标准字体）

生成到 `tests/fixtures/`，全部提交（每个 < 200 KB）：

| 文件 | 内容 | 用来测什么 |
| --- | --- | --- |
| `single-column.pdf` | 3 页，Times-Roman 10 pt，每页 4 段英文（lorem + 真实句子），页眉页码 | 行/段合并、页眉页脚跳过、断点 |
| `two-column.pdf` | 4 页两栏，通栏标题与摘要，`1 Introduction` 等编号标题，参考文献 | 栏检测、阅读顺序、标题识别 |
| `inline-formula.pdf` | 段落里用 `Symbol` 与 `Times-Italic` 单字母模拟行内公式（`α`, `x`, `≤`, 上下标用缩小字号并偏移基线） | 公式项判定、占位符合并、上下标 |
| `display-math.pdf` | 独立公式行 + `(3)` 编号 | display math 不翻译 |
| `figure-caption.pdf` | 嵌入一张 PNG，图内有短文字，下方 `Figure 1: …` | `inside_image`、`short_isolated`、caption 翻译 |
| `hyphenation.pdf` | 行尾连字符断词、连字 `ﬁ` | 文本规整 |
| `long.pdf` | 60 页单栏 | 性能、进度、事件上限 |
| `encrypted.pdf` | 带用户口令 | `pdf_encrypted` |
| `scanned.pdf` | 只有一张整页图片 | `scanned_pdf` |
| `empty.pdf` | 0 页（pdf-lib 无法生成 0 页，用手工构造的最小 PDF 字节） | `pdf_empty` |
| `colored-text.pdf` | 彩色段落 | 颜色提取 |

另放 2 篇真实的 CC-BY arXiv 论文（选择许可证允许再分发的，记录来源与许可在 `tests/fixtures/README.md`），只用于集成测试的「不崩溃、页数正确、译页含中文」断言，不做精确断言。

## 8.3 mock 大模型服务（`tests/mock-provider/server.ts`）

移植自 3.x `engine/tests/mock_providers.py`。`tsx tests/mock-provider/server.ts --port 38111`，提供：

- `POST /v1/chat/completions`（OpenAI）、`GET /v1/models`；`POST /anthropic/v1/messages`、`GET /anthropic/v1/models`；`POST /gemini/v1beta/models/:model:generateContent`、`GET /gemini/v1beta/models`。
- 默认行为：把每个 `<segment>` 原样返回，正文 = 原文 + `〔测试译文〕`，占位符原样保留；单段请求返回 `原文〔测试译文〕`。
- 故障注入（按请求正文里的触发词或计数）：
  - 每第 9 个请求返回 429（带 `Retry-After: 1`）；
  - 正文 > 3000 字符 → `finish_reason: length` 截断输出；
  - 含 `DROP_ME` 的段落在回复里缺失；
  - 含 `DAMAGE_MARKERS` → 把标记改写成 `` `DOCFLOW KEEP 0 0 0 0 0 1 TOKEN` ``；
  - 含 `LOSE_MARKERS` → 删掉一个标记；
  - 含 `SWAP_MARKERS` → 交换两个标记顺序；
  - 含 `REFUSE_ME` → `finish_reason: content_filter`；
  - 模型 `mock-reasoner` → 回复外包一层 `<think>…</think>`；
  - Key 等于 `bad-key` → 401；Key 等于 `poor-key` → 429 + `insufficient balance`；
  - 模型 `missing-model` → 404。
- `GET /stats` 返回每种接口的峰值并发与请求计数（测试并发池）。
- `POST /reset` 清零。

## 8.4 单元测试清单（最低要求）

- `shared/types`：每个 schema 的合法/非法样例；`Settings` 未知字段拒绝；`ProviderConfig.extraBody` 禁用字段。
- `translate/providers`：4 种类型的 chatUrl/modelsUrl（含 base 已带 `/v1`、尾部 `/`、gemini `models/` 前缀）、鉴权头、请求体、extraBody 深合并。
- `translate/response`：三种接口的正常、截断、拒绝、`<think>`、content 数组形式、200 带 error。
- `translate/errors`：状态码表逐项、正文关键词逐项、Retry-After 秒/日期/上限、`redact`。
- `translate/keys`：拆分（中英文逗号、分号、换行）、掩码、轮询、下架 600 s 后恢复（假时钟）、全部下架。
- `translate/pool`：并发上限（用可控 promise 验证峰值）、429 减半与回升序列 100→50→62→77→96→100、`setConfigured` 降低时不打断。
- `translate/batch`：分批边界（段数、字符数、超长拆分与拼回）、`parseBatch` 各种格式。
- `translate/protect + validate`：占位符替换与还原、损坏修复样例、数量不符、编号变化拒绝、PDF 序列校验（交换/新增/大小写）、isolated 模式禁标记。
- `translate/translate-document`（对 mock 服务）：正常、DROP_ME 触发逐段、DAMAGE 触发修复、LOSE 触发 strict 再拆分再隔离、REFUSE 保留原文、mostly_untranslated、连续拒绝、缓存命中不请求、取消。
- `pdf/analyze/*`：每个 fixture 的行数/段数/栏数/占位符数与角色（用快照 JSON，`tests/unit/__snapshots__/`），阈值边界。
- `pdf/compose/layout`：换行（避头尾、拉丁词不拆）、缩放到能装下、justify 分配、占位符占位。
- `pdf` 集成：每个 fixture 跑 inspect→analyze→（假翻译：原文前加 `译`）→compose→verify，断言页数、尺寸、译页含中文、无未捕获异常；`encrypted/scanned/empty` 断言错误码。
- `settings/atomic-write`：并发写、目标存在、崩溃模拟（写一半的 tmp 文件不影响读取）。
- `library`：manifest 读写、索引重建、事件追加与截断、导出 ZIP 内容。
- `jobs/scheduler`（假时钟 + 假流水线）：并发数、重试间隔、永久失败不重试、取消、重启恢复。

## 8.5 E2E 场景（`tests/e2e/*.spec.ts`）

前置：`globalSetup` 启动 mock 服务；每个测试用独立临时 `DOCFLOW_DATA_DIR`；`DOCFLOW_MOCK_PROVIDER_URL=http://127.0.0.1:38111`。

1. `first-run.spec`：启动 → 空状态显示未配置提示 → 设置 → 翻译服务 → 添加 DeepSeek 预设 → 填 Key `test-key` → 获取模型列表 → 勾选 `mock-chat` → 检查模型显示 `可用` → 返回文档库 → 空状态变为已配置文案。
2. `translate.spec`：新建翻译 → 选择 `tests/fixtures/two-column.pdf`（用 `app:openFiles` 推送模拟拖入，或 Playwright `setInputFiles` 不适用于 Electron 对话框；通过 `page.evaluate(() => window.docflow.invoke('documents:create', …))` 直连）→ 列表出现、进度推进 → 完成 → 详情 `中文 PDF` 页签 iframe 加载（检查 `docflow://` 请求成功）→ 处理记录含 `校验通过` → 导出中文 PDF（主进程对话框用 `DOCFLOW_E2E_SAVE_PATH` 环境变量绕过）→ Toast `已导出`。
3. `failure.spec`：`encrypted.pdf` → 失败，提示含 `已加密`；`bad-key` → 失败提示含 `API Key`；`missing-model` → 失败提示含 `模型`。
4. `cancel-retry.spec`：`long.pdf` 开始后取消 → 状态已取消 → 重新处理 → 完成，且处理记录含 `缓存` 命中事件。
5. `restart.spec`：翻译进行中关闭应用（`electronApp.close()`）→ 重新启动 → 文档从断点继续并完成。
6. `settings.spec`：修改并发、代理、提示词、主题 → 重启后保留；更改文档库位置 → 新库为空、改回后文档还在。
7. `delete.spec`：删除完成的文档 → 目录消失、列表更新。

## 8.6 验收清单（发布前人工）

- [ ] 5 篇真实论文（两栏、含公式图表；至少一篇有彩色标题背景、一篇有表格）用 DeepSeek 跑通，逐页翻看：正文全部翻译、公式位置合理、图表未被覆盖、标题与图注翻译。
- [ ] 断网时新建翻译：事件里有重试 warning，恢复网络后自动继续。
- [ ] Windows 与 macOS 各安装一次、升级安装一次（数据保留）。
- [ ] 深浅主题切换无闪烁；窗口尺寸记忆。
- [ ] 应用运行 2 小时、翻译 20 篇后主进程内存 < 500 MB。
