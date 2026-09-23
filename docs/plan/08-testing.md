# 08 测试

## 8.1 层次

| 层   | 工具                           | 范围                                                                                                                                                                   | 何时跑                    |
| ---- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| 单元 | vitest（node 环境）            | `src/shared/**`、`src/main/**` 的纯函数与模块：解析、段落合并、公式识别、排版、翻译请求/响应/错误/池/批处理/占位符、设置与 manifest 的 zod、原子写、调度器（用假时钟） | `npm run check`，每次提交 |
| 集成 | vitest + `tests/mock-provider` | 从 fixture PDF 到输出 PDF 的完整流水线（不启动 Electron：`net.fetch` 换成 Node fetch；compose 不依赖任何 Electron API，可直接在 vitest 里跑）                          | `npm run check`           |
| E2E  | Playwright `_electron`         | 真实应用：拖入/选择文件 → 设置里配置 mock 服务商 → 翻译完成 → 预览、导出、取消、重试、删除、设置持久化                                                                 | CI `package` job；发布前  |
| 手工 | 人                             | 真实 arXiv 论文 5 篇 + 真实服务商 1 个（DeepSeek）                                                                                                                     | 里程碑 M5、M6             |

## 8.2 fixture 生成（`scripts/make-fixtures.mjs`，用 `@cantoo/pdf-lib` + 标准字体）

生成到 `tests/fixtures/`，全部提交（每个 < 200 KB）：

| 文件                  | 内容                                                                                                | 用来测什么                                     |
| --------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `single-column.pdf`   | 3 页，Times-Roman 10 pt，每页 4 段英文（lorem + 真实句子），页眉页码                                | 行/段合并、页眉页脚跳过、断点                  |
| `two-column.pdf`      | 4 页两栏，通栏标题与摘要，`1 Introduction` 等编号标题，参考文献                                     | 栏检测、阅读顺序、标题识别                     |
| `inline-formula.pdf`  | 段落里用 `Symbol` 与 `Times-Italic` 单字母模拟行内公式（`α`, `x`, `≤`, 上下标用缩小字号并偏移基线） | 公式项判定、占位符合并、上下标                 |
| `display-math.pdf`    | 独立公式行 + `(3)` 编号                                                                             | display math 不翻译                            |
| `figure-caption.pdf`  | 嵌入一张 PNG，图内有短文字，下方 `Figure 1: …`                                                      | `inside_image`、`short_isolated`、caption 翻译 |
| `hyphenation.pdf`     | 行尾连字符断词、连字 `ﬁ`                                                                            | 文本规整                                       |
| `long.pdf`            | 60 页单栏                                                                                           | 性能、进度、事件上限                           |
| `encrypted.pdf`       | 带用户口令                                                                                          | `pdf_encrypted`                                |
| `scanned.pdf`         | 只有一张整页图片                                                                                    | `scanned_pdf`                                  |
| `empty.pdf`           | 0 页（pdf-lib 无法生成 0 页，用手工构造的最小 PDF 字节）                                            | `pdf_empty`                                    |
| `colored-text.pdf`    | 彩色段落                                                                                            | 颜色提取与颜色保留                             |
| `tj-arrays.pdf`       | 用 `TJ` 数组（字距调整）、`'`、`"` 算子绘制的段落（手写内容流）                                     | 算子流状态机、词法分析器、删除集合             |
| `cid-font.pdf`        | 嵌入 TrueType 子集（pdf-lib 生成的 Type0/Identity-H，2 字节编码）的段落与公式                       | 复合字体编码字节数、公式重绘                   |
| `form-wrapped.pdf`    | 整页内容包在一个 Form XObject 里（手工构造）                                                        | 表单递归、页面级追加、字体资源搬运             |
| `shared-form.pdf`     | 每页都 `Do` 同一个含文字的表单（页眉 logo）                                                         | shared 表单跳过                                |
| `italic-sentence.pdf` | 斜体的整句 + 单个斜体变量                                                                           | `.*Ital` 放宽规则                              |
| `invisible-text.pdf`  | 整页图片 + `3 Tr` 隐藏文字层                                                                        | `scanned_pdf`（可见字形为 0）                  |

另放 2 篇真实的 CC-BY arXiv 论文（选择许可证允许再分发的，记录来源与许可在 `tests/fixtures/README.md`），只用于集成测试的「不崩溃、页数正确、译页含中文」断言，不做精确断言。

## 8.3 mock 大模型服务（`tests/mock-provider/server.ts`）

移植自 3.x `engine/tests/mock_providers.py`。`tsx tests/mock-provider/server.ts --port 38111 [--delay <ms>] [--open]`，提供：

- `POST /v1/chat/completions`（OpenAI）、`GET /v1/models`；`POST /anthropic/v1/messages`、`GET /anthropic/v1/models`；`POST /gemini/v1beta/models/:model:generateContent`、`GET /gemini/v1beta/models`。
- 默认行为：把每个 `<segment>` 原样返回，正文 = 原文 + `〔测试译文〕`，占位符原样保留；单段请求返回 `原文〔测试译文〕`。
- 故障注入（按请求正文里的触发词或计数）：
  - 每第 9 个请求返回 429（带 `Retry-After: 1`；间隔可用 `rateLimitEvery` 调整，0 表示关闭）；
  - 正文 > 3000 字符 → `finish_reason: length` 截断输出；
  - 含 `DROP_ME` 的段落在回复里缺失；
  - 含 `DAMAGE_MARKERS` → 把标记改写成 `` `DOCFLOW KEEP 0 0 0 0 0 1 TOKEN` ``；
  - 含 `LOSE_MARKERS` → 删掉一个标记；
  - 含 `SWAP_MARKERS` → 交换两个标记顺序；
  - 含 `REFUSE_ME` → `finish_reason: content_filter`；
  - 模型 `mock-reasoner` → 回复外包一层 `<think>…</think>`；
  - Key 等于 `bad-key` → 401；Key 等于 `poor-key` → 429 + `insufficient balance`；
  - 模型 `missing-model` → 404。
- 延迟：每个对话请求先等 `delayMs` 再回复（默认 0）。客户端在等待期间断开（取消、退出应用）时不再回写，服务不受影响。
- `GET /config` / `POST /config`（JSON `{ delayMs?, rateLimitEvery? }`，非负整数，未知字段返回 400）读取或修改上面两个运行时参数；启动值来自 `--delay` 或 `listenMockProvider(port, { config })`。
- `GET /stats` 返回每种接口的峰值并发与请求计数（测试并发池）。
- `POST /reset` 清零计数，并把运行时参数恢复为启动值。

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
- `pdf/analyze/glyphs`：每个 fixture 的字形 x/y/size/adv 与 pdf.js `getTextContent` 的位置一致（容差 0.05 pt）；`TJ` 数字间距、`'`/`"`、`Tz`/`Tc`/`Tw`/`Ts`、表单矩阵、`Tr 3`、复合字体编码字节数、颜色（数组与 `#rrggbb` 两种输入）。
- `pdf/analyze/*`：每个 fixture 的行数/段数/栏数/公式片段数与角色（用快照 JSON，`tests/unit/__snapshots__/`），阈值边界；「同一算子的字形同行同段」不变量。
- `pdf/compose/content-lexer`：fixture 内容流分词后原样拼回逐字节相等；字符串转义/嵌套括号/十六进制串/字典/内联图像/注释的边角样例。
- `pdf/compose/content-walker`：每个 show-text 算子的起点与字形记录的首字形一致（容差 0.5 pt）；表单递归与 shared 跳过；删除集合数量与段落 `opSeqs` 一致；`op_mismatch` 超阈值时整页放弃。
- `pdf/compose/fonts`：`loadedName → 资源名` 起点匹配、BaseFont 回退、`DFo<n>` 挂载；CJK 子集回退。
- `pdf/compose/layout`：换行（避头尾、拉丁词不拆）、行高再字号缩放、justify 分配、`{vN}` 占位宽度。
- `pdf/compose/emit`：译文 `Tj` 的十六进制编码、公式片段合并/拆分规则、1/2 字节编码、颜色 `rg`。
- `pdf` 集成：每个 fixture 跑 inspect→analyze→（假翻译：原文前加 `译`）→compose→verify，断言页数、尺寸、译页含中文、改写页 `getOperatorList` 可执行、未翻译段落的原字节仍在输出流中、无未捕获异常；`encrypted/scanned/empty/invisible-text` 断言错误码。
- `settings/atomic-write`：并发写、目标存在、崩溃模拟（写一半的 tmp 文件不影响读取）。
- `library`：manifest 读写、索引重建、事件追加与截断、导出 ZIP 内容。
- `jobs/scheduler`（假时钟 + 假流水线）：并发数、重试间隔、永久失败不重试、取消、重启恢复。

## 8.5 E2E 场景（`tests/e2e/*.spec.ts`）

前置：`globalSetup` 启动 mock 服务；`tests/e2e/helpers.ts` 导出的 `test` 带 fixture：`mockProvider`（自动，每个测试开始时 `POST /reset`，因此 429 计数、延迟都从头开始）、`tempDir`/`dataDir`（每个测试独立的临时目录，作为 `DOCFLOW_DATA_DIR`）、`launch`（启动打包产物，`DOCFLOW_MOCK_PROVIDER_URL=http://127.0.0.1:38111`）。测试结束时 fixture 关闭仍在运行的应用并删除临时目录；失败的测试会先把目录里的 `main.log` 附到报告。

CI 的屏幕较窄（窗口 < 1100 px），文档详情是覆盖列表的抽屉：选中文档用 `openDocument(page, id)`（先关掉已打开的抽屉再点行），操作行菜单直接点行内的 `更多`，不要先点行。本地用 `E2E_WINDOW=1000x700 npx playwright test` 按窄窗口跑一遍。

1. `first-run.spec`：启动 → 空状态显示未配置提示 → 设置 → 翻译服务 → 添加 DeepSeek 预设 → 填 Key `test-key` → 获取模型列表 → 勾选 `mock-chat` → 检查模型显示 `可用` → 返回文档库 → 空状态变为已配置文案。
2. `translate.spec`：新建翻译 → 选择 `tests/fixtures/two-column.pdf`（用 `app:openFiles` 推送模拟拖入，或 Playwright `setInputFiles` 不适用于 Electron 对话框；通过 `page.evaluate(() => window.docflow.invoke('documents:create', …))` 直连）→ 列表出现、进度推进 → 完成 → 详情 `中文 PDF` 页签 iframe 加载：在主进程里 `net.fetch(iframe.src)` 断言 200、`application/pdf`、`%PDF-` 开头，6 s 后仍没有出现「无法在应用内预览」兜底 → 处理记录含 `校验通过` → 导出中文 PDF（主进程对话框用 `DOCFLOW_E2E_SAVE_PATH` 环境变量绕过）→ Toast `已导出`，导出的文件是 PDF。
3. `failure.spec`：`encrypted.pdf` → 失败，提示含 `已加密`；`bad-key` → 失败提示含 `API Key`；`missing-model` → 失败提示含 `模型`（`failure.message` 与界面各断言一次）。
4. `cancel-retry.spec`：mock 延迟 500 ms、关闭周期 429，`perDocumentConcurrency: 1`、每批 2 段（`SLOW_TRANSLATION`），`long.pdf` 的翻译阶段约 15 s；用 `documents:get` 轮询到 `stage=translate` 且进度超过 30%、`work/translation-cache.json` 已有条目，再点「取消处理…」→ 状态已取消且停在翻译阶段 → 重新处理 → 完成；取消之后的事件里有 `缓存命中 n 段`，整个处理记录只有一条「已取消处理」。
5. `restart.spec`：同样放慢翻译，确认在翻译阶段且缓存文件已有条目后关闭应用（`electronApp.close()`）→ 重新启动 → 文档完成；处理记录含「应用重新启动，从断点继续」与 `缓存命中 n 段`，且没有「已取消处理」（退出应用不算取消）。
6. `settings.spec`：修改主题、同时处理的文档数、代理、提示词 → 关闭前轮询 `settings:get`/`app:info` 确认已写入 → 重启后保留（IPC 与界面各断言一次）；更改文档库位置 → 新库为空、改回后文档还在，设置也随文档库回来。
7. `delete.spec`：删除完成的文档 → 目录消失、列表更新。

约定（M5 实测，见 `docs/worklog/2026-09-22-m5-ui.md`、`docs/worklog/2026-09-23-m5-review.md`）：

- 启动的是 `electron-builder --dir` 产物，不是 `npm run dev`。改 `src/renderer` 后必须重打，否则 DOM 与源码不一致。
- HeroUI 3 的 `Button` 渲染原生 `<button>`，会转发 `data-testid` 与 `aria-label`（M5 时「找不到 testid」是打包产物过期）。按钮优先 `getByRole('button', { name, exact: true })` 或 testid，页签用 `getByRole('tab', …)`，菜单项用 `getByRole('menuitem', …)`，确认框里的按钮先限定在 `getByRole('alertdialog')` 内；列表行用 `data-testid="document-row-<id>"` 与 `data-status`。
- 等状态用 IPC：`waitForStatus(page, id, status)` / `waitForDocument(page, id, predicate)` 轮询 `documents:get`（到了别的终态立即失败并给出 failure），再断言对应行的 `data-status`。不要用界面上常驻的文字当同步点（侧栏筛选「已完成」、按钮「新建翻译」里的「翻译」都一直在）。
- 需要「处理到一半」的场景用 `mockProvider.configure({ delayMs })` 放慢请求，并在创建文档前用 `configureMockProvider(page, { translation: SLOW_TRANSLATION })` 让批次串行；不要靠固定等待去猜阶段。
- 确认写盘：设置改动是异步 IPC，关窗前用 `expect.poll` 等 `settings:get` / `app:info` 反映新值（写入完成后才会更新内存值）。
- 改文档库位置：`DOCFLOW_E2E_FOLDER_PATH` 绕过选文件夹对话框；有它时 `dataDirFromEnv` 为 false，设置页「更改位置」可点。

## 8.6 验收清单（发布前人工）

- [ ] 5 篇真实论文（两栏、含公式图表；至少一篇有彩色标题背景、一篇有表格）用 DeepSeek 跑通，逐页翻看：正文全部翻译、公式位置合理、图表未被覆盖、标题与图注翻译。
- [ ] 断网时新建翻译：事件里有重试 warning，恢复网络后自动继续。
- [ ] Windows 与 macOS 各安装一次、升级安装一次（数据保留）。
- [ ] 深浅主题切换无闪烁；窗口尺寸记忆。
- [ ] 应用运行 2 小时、翻译 20 篇后主进程内存 < 500 MB。
