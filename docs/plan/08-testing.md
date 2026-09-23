# 08 测试

## 8.1 层次

| 层   | 工具                       | 范围                                                                                                                                                                                                                                                                                                                                                                                                                        | 何时跑                    |
| ---- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| 单元 | vitest（node 环境）        | `src/shared/**`、`src/main/**` 的纯函数与模块：解析、段落合并、公式识别、排版、翻译请求/响应/错误/池/批处理/占位符、设置与 manifest 的 zod、原子写、调度器（注入 `now` 或用可控 promise）；`src/renderer/**` 里不依赖 DOM 的模块（store、`lib/labels`、`api/errors`、`views/Document/progress`、`views/Library/virtual-list`）；`tests/mock-provider/server.test.ts`。React 组件不做单测（没有 jsdom），界面交互由 E2E 覆盖 | `npm run check`，每次提交 |
| 集成 | vitest（与单元同一次运行） | 流水线 inspect→analyze→假翻译（可翻译段落前加 `译`）→compose→verify 写出中文与双语 PDF（`pipeline/run.test.ts`、`ipc/documents-smoke.test.ts`、`pdf/compose/compose.test.ts`，不启动 Electron，compose 不依赖任何 Electron API）；翻译阶梯与获取/检查模型对 `tests/mock-provider` 本地服务（`translate/translate-document.test.ts`、`translate/providers.test.ts`，用 Node fetch 代替 `net.fetch`）                         | `npm run check`           |
| E2E  | Playwright `_electron`     | 真实应用（`electron-builder --dir` 产物）：首次启动在界面上配置 mock 服务商；其余场景用 IPC 配置服务商、用 `documents:create` 建文档 → 翻译完成 → 预览、导出、失败文案、取消与重新处理、重启续跑、删除、设置持久化与更换文档库                                                                                                                                                                                              | CI `package` job；发布前  |
| 手工 | 人                         | 真实 arXiv 论文 5 篇 + 真实服务商 1 个（DeepSeek）                                                                                                                                                                                                                                                                                                                                                                          | 里程碑 M5、M6             |

现状（2026-09-24）：`npm run test` 共 53 个测试文件、265 个用例；E2E 8 个 spec（8.5）。没有覆盖率门槛：`vitest.config.ts` 里写了 v8 覆盖率配置（只统计 `src/main/**`、`src/shared/**`），但没有安装 `@vitest/coverage-v8`，也没有脚本调用。vitest 的 `globalSetup`（`tests/unit/global-setup.ts`）在 `tests/fixtures/single-column.pdf` 不存在时先跑 `scripts/make-fixtures.mjs`。CI 的 `package` job 在 windows-latest 与 macos-15 上 `npm run build`、`npx electron-builder --dir` 后跑 `npm run test:e2e`。

## 8.2 fixture 生成（`scripts/make-fixtures.mjs`，用 `@cantoo/pdf-lib` + 标准字体）

生成到 `tests/fixtures/`，全部提交（`npm run fixtures`；脚本对每个文件检查 < 200 KB，超了就报错）。页面都是 612×792 pt，正文用真实英文句子（不是 lorem）：

| 文件                  | 内容                                                                                                                                                       | 用来测什么                                     |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `single-column.pdf`   | 3 页，Times-Roman 10 pt，每页 4 段英文，灰色页眉 `Header · page N` 与页码                                                                                  | 行/段合并、页眉页脚跳过、断点                  |
| `two-column.pdf`      | 4 页两栏，首页通栏标题与摘要，`1 Introduction`/`2 Method` 等编号标题，末页参考文献                                                                         | 栏检测、阅读顺序、标题识别                     |
| `inline-formula.pdf`  | 段落里用 `Symbol`（`≤`、`α`）与 `Times-Italic` 单字母（`x`）模拟行内公式，角标用 7 pt 并偏移基线                                                           | 公式项判定、占位符合并、上下标                 |
| `display-math.pdf`    | 独立公式行 `E = mc²` + `(3)` 编号                                                                                                                          | display math 不翻译                            |
| `figure-caption.pdf`  | 嵌入一张 PNG，图内有短文字，下方 `Figure 1: …`                                                                                                             | `inside_image`、`short_isolated`、caption 翻译 |
| `hyphenation.pdf`     | 行尾连字符断词、连字 `ﬁ`                                                                                                                                   | 文本规整                                       |
| `long.pdf`            | 60 页单栏，每页一段                                                                                                                                        | 性能、进度、事件上限；E2E 的取消与重启         |
| `encrypted.pdf`       | 用户口令 `secret`                                                                                                                                          | `pdf_encrypted`                                |
| `scanned.pdf`         | 只有一张整页图片                                                                                                                                           | `scanned_pdf`                                  |
| `empty.pdf`           | 0 页（pdf-lib 无法生成 0 页，用手工构造的最小 PDF 字节）                                                                                                   | `pdf_empty`                                    |
| `colored-text.pdf`    | 红色标题 + 蓝色正文                                                                                                                                        | 颜色提取与颜色保留                             |
| `tj-arrays.pdf`       | 用 `TJ` 数组（字距调整）、`'`、`"` 算子与 `Tc`/`Tw`/`Tz` 绘制的段落（手写内容流）                                                                          | 算子流状态机、词法分析器、删除集合             |
| `cid-font.pdf`        | 嵌入 Noto Sans SC 子集（`resources/fonts/NotoSansSC-Regular.otf`，pdf-lib 生成 Type0/Identity-H，2 字节编码）的中英文段落，与 Times-Italic 的变量 `x` 混排 | 复合字体编码字节数、公式重绘                   |
| `form-wrapped.pdf`    | 整页内容包在一个 Form XObject 里（手工构造）                                                                                                               | 表单递归、页面级追加、字体资源搬运             |
| `shared-form.pdf`     | 2 页都 `Do` 同一个含文字的表单（页眉 `LOGO`）                                                                                                              | shared 表单跳过                                |
| `italic-sentence.pdf` | 斜体的整句 + 单个斜体变量                                                                                                                                  | `.*Ital` 放宽规则                              |
| `invisible-text.pdf`  | 整页图片 + `3 Tr` 隐藏文字层                                                                                                                               | `scanned_pdf`（可见字形为 0）                  |

另放 2 篇真实的 CC-BY-4.0 arXiv 论文（来源与许可记录在 `tests/fixtures/README.md`；各约 0.7–0.9 MB，不受 200 KB 限制，脚本不会覆盖）：`arxiv-2201.11903.pdf`（Chain-of-Thought）、`arxiv-2302.13971.pdf`（LLaMA）。它们只用在 `pdf/analyze.test.ts` 的「真实论文」三个版面断言里（两栏按栏阅读且段落完整、图旁环绕的正文是一段、矢量图里的小字不翻译，来自 [M5 修复 worklog](../worklog/2026-09-23-m5-fixes.md) 的版面修复）；字形、词法、compose/verify 的逐 fixture 循环都跳过 `arxiv-*`，所以目前没有对真实论文跑写回与校验（`tests/fixtures/README.md` 里「不崩溃、页数正确、译页含中文」的说法与实际不符）。

## 8.3 mock 大模型服务（`tests/mock-provider/server.ts`）

移植自 3.x `engine/tests/mock_providers.py`。`npm run mock:provider` 或 `tsx tests/mock-provider/server.ts --port 38111 [--delay <ms>] [--open]`（默认端口 38111，也接受裸数字作端口；默认只监听 `127.0.0.1`）；测试里用 `listenMockProvider(port, { open?, config? })`（端口 0 为随机端口）。提供：

- `POST /v1/chat/completions`（OpenAI）、`GET /v1/models`（`mock-chat`、`mock-model`、`mock-reasoner`）；`POST /anthropic/v1/messages`（缺 `max_tokens` 或 `anthropic-version: 2023-06-01` 时 400）、`GET /anthropic/v1/models`（分两页：`claude-mock`，`after_id=claude-mock` 时 `claude-mock-2`）；`POST /gemini/v1beta/models/:model:generateContent`、`GET /gemini/v1beta/models`（`models/gemini-mock` 支持 `generateContent`，`models/embed-mock` 只支持 `embedContent`，用来测过滤）。没有 Azure 专用接口：Azure 类型会被指到 `<mock>/v1`，OpenAI 接口的 Key 先取 `Authorization: Bearer`，没有时取 Azure 的 `api-key` 头（与 `translate/request.ts` 的 `authHeaders` 一致）。应用通过 `DOCFLOW_MOCK_PROVIDER_URL` 把服务商地址换成 mock（`shared/presets.ts` 的 `mockBaseUrl`：OpenAI 兼容与 Azure → `<mock>/v1`，Anthropic → `<mock>/anthropic`，Gemini → `<mock>/gemini`）。
- 鉴权：OpenAI 读 `Authorization: Bearer`，Anthropic 读 `x-api-key`，Gemini 读 `x-goog-api-key`；没有 Key 时 401（`--open` / `open: true` 时放行），模型列表接口同样检查。
- 默认行为：把每个 `<segment>` 原样返回，正文 = 原文 + `〔测试译文〕`，占位符原样保留；单段请求返回 `原文〔测试译文〕`（空白原文不加标记）。
- 故障注入（按用户消息里的触发词、Key、模型或计数）：
  - 每种接口（OpenAI/Anthropic/Gemini 分别计数）的每第 9 个对话请求返回 429（`Rate limit reached, please retry`，带 `Retry-After: 1`；间隔可用 `rateLimitEvery` 调整，0 表示关闭）；
  - 用户消息 > 3000 字符 → 只返回一半，`finish_reason: length`（Anthropic `stop_reason: max_tokens`，Gemini `finishReason: MAX_TOKENS`）；
  - 含 `DROP_ME` 的段落在回复里缺失（只在多段请求里；单段照常返回）；
  - 含 `DAMAGE_MARKERS` → 把该段所有标记改写成 `` `DOCFLOW KEEP 0 0 0 0 0 1 TOKEN` ``；
  - 含 `LOSE_MARKERS` → 删掉该段第一个标记；
  - 含 `SWAP_MARKERS` → 交换该段前两个标记的顺序；
  - 含 `REFUSE_ME` → 整个请求空回复 + `finish_reason: content_filter`（Anthropic `stop_reason: refusal`，Gemini `promptFeedback.blockReason: SAFETY`）；
  - 模型 `mock-reasoner` → 回复前加一段 `<think>…</think>`（只在 OpenAI 接口）；
  - Key 等于 `bad-key` → 401（按各接口的错误格式）；Key 等于 `poor-key` → 429 + `insufficient balance`（`Retry-After: 1`）；
  - 模型 `missing-model` → 404（`model_not_found`）；OpenAI 接口只接受 `mock-chat`、`mock-model`、`mock-reasoner`，Anthropic 接口另外接受它列出的 `claude-mock`、`claude-mock-2`，其他模型也 404。
- 延迟：每个对话请求读完正文后先等 `delayMs` 再做鉴权与回复（默认 0，上限 600000）。客户端在等待期间断开（取消、退出应用）时不再回写，服务不受影响。
- `GET /config` / `POST /config`（JSON `{ delayMs?, rateLimitEvery? }`，非负整数，`delayMs` ≤ 600000，未知字段或类型不对返回 400）读取或修改上面两个运行时参数；启动值来自 `--delay` 或 `listenMockProvider(port, { config })`，默认 `{ delayMs: 0, rateLimitEvery: 9 }`。
- `GET /stats` 返回每种接口的请求计数、当前与峰值并发（`requests`/`inFlight`/`peak`，测试并发池），以及各故障的触发次数（`rateLimited`、`truncated`、`dropped`、`damaged`、`lostMarkers`、`swapped`、`refused`）。
- `POST /reset` 清零计数，并把运行时参数恢复为启动值。E2E 的 `mockProvider` fixture 在每个测试开始时调用它。
- 其他路径 404。自身的单测在 `tests/mock-provider/server.test.ts`。

## 8.4 单元测试清单（最低要求）

下面是规划时定的最低要求，测试文件与被测文件同目录（`src/main/**`、`src/shared/**`、`src/renderer/**` 下的 `*.test.ts`）。2026-09-24 核对时还没有对应用例的项在条目末尾用「（缺：…）」标出。

- `shared/types`：每个 schema 的合法/非法样例；`Settings` 未知字段拒绝；`ProviderConfig.extraBody` 禁用字段。
- `translate/providers`：4 种类型的 chatUrl/modelsUrl（含 base 已带 `/v1`、尾部 `/`、gemini `models/` 前缀）、鉴权头、请求体、extraBody 深合并。（这些在 `translate/request.test.ts`；`translate/providers.test.ts` 对 mock 服务测获取模型列表与检查模型。）
- `translate/response`：三种接口的正常、截断、拒绝、`<think>`、content 数组形式、200 带 error。
- `translate/errors`：状态码表逐项、正文关键词逐项、Retry-After 秒/日期/上限、`redact`。
- `translate/keys`：拆分（中英文逗号、分号、换行）、掩码、轮询、下架 600 s 后恢复（假时钟）、全部下架。
- `translate/pool`：并发上限（用可控 promise 验证峰值）、429 减半与回升序列 100→50→62→77→96→100、`setConfigured` 降低时不打断。
- `translate/batch`：分批边界（段数、字符数、超长拆分与拼回）、`parseBatch` 各种格式。
- `translate/protect + validate`：占位符替换与还原、损坏修复样例、数量不符、编号变化拒绝、PDF 序列校验（交换/新增/大小写）、isolated 模式禁标记。（都在 `translate/validate.test.ts`，另测 `TranslationCache`；缺：PDF 序列校验的「新增」「大小写」。）
- `translate/translate-document`（对 mock 服务）：正常、DROP_ME 触发逐段、DAMAGE 触发修复、LOSE 触发 strict 再拆分再隔离、REFUSE 保留原文、mostly_untranslated、连续拒绝、缓存命中不请求、取消。（另有：重试等待中取消立即结束、`DOCFLOW_FAKE_PROVIDERS` 假 fetch；缺：LOSE、连续拒绝。）
- `pdf/analyze/glyphs`：每个 fixture 的字形 x/y/size/adv 与 pdf.js `getTextContent` 的位置一致（容差 0.05 pt）；`TJ` 数字间距、`'`/`"`、`Tz`/`Tc`/`Tw`/`Ts`、表单矩阵、`Tr 3`、复合字体编码字节数、颜色（数组与 `#rrggbb` 两种输入）。
- `pdf/analyze/*`：每个 fixture 的行数/段数/栏数/公式片段数与角色（用快照 JSON），阈值边界；「同一算子的字形同行同段」不变量。（实际：`pdf/analyze.test.ts` 只对 `single-column.pdf` 的统计做快照，快照在 `src/main/pdf/__snapshots__/analyze.test.ts.snap`，不在 `tests/unit/__snapshots__/`；两栏、行内公式、独立公式、斜体整句、表单 shared 判定与两篇真实论文用针对性断言；`analyze/normalize.test.ts` 测连字符与连字。缺：其余 fixture 的快照、「同一算子的字形同行同段」不变量。）
- `pdf/compose/content-lexer`：fixture 内容流分词后原样拼回逐字节相等；字符串转义/嵌套括号/十六进制串/字典/内联图像/注释的边角样例。
- `pdf/compose/content-walker`：每个 show-text 算子的起点与字形记录的首字形一致（容差 0.5 pt）；表单递归与 shared 跳过；删除集合数量与段落 `opSeqs` 一致；`op_mismatch` 超阈值时整页放弃。（超过 10% 整页放弃与删除集合在 `pdf/compose/emit.test.ts` 的 `rewrite` 组里。）
- `pdf/compose/fonts`：`loadedName → 资源名` 起点匹配、BaseFont 回退、`DFo<n>` 挂载；CJK 子集回退。（实际只测了去掉子集前缀、嵌入 CJK 子集并挂载字典名；缺：`loadedName` 匹配与 BaseFont 回退。）
- `pdf/compose/layout`：换行（避头尾、拉丁词不拆）、行高再字号缩放、justify 分配、`{vN}` 占位宽度。
- `pdf/compose/emit`：译文 `Tj` 的十六进制编码、公式片段合并/拆分规则、1/2 字节编码、颜色 `rg`。
- `pdf` 集成：每个 fixture 跑 inspect→analyze→（假翻译：原文前加 `译`）→compose→verify，断言页数、尺寸、译页含中文、改写页 `getOperatorList` 可执行、未翻译段落的原字节仍在输出流中、无未捕获异常；`encrypted/scanned/empty/invisible-text` 断言错误码。（`pdf/compose/compose.test.ts` 跑除 `arxiv-*`、四个错误文件和 `long.pdf` 之外的合成 fixture；`long.pdf` 单独测 compose+双语+verify 在 30 s 内；`getOperatorList` 可执行在 `pdf/verify.test.ts`，只用 `single-column.pdf`；错误码另见 `pdf/inspect.test.ts`。）
- `settings/atomic-write`：并发写、目标存在、崩溃模拟（写一半的 tmp 文件不影响读取）。
- `library`：manifest 读写、索引重建、事件追加与截断、导出 ZIP 内容。
- `jobs/scheduler`（注入 `now` + 假流水线）：并发数、重试间隔、永久失败不重试、取消、重启恢复。（另有：关停不算取消、取消只对进行中生效且只记一次、取消/删除最多等宽限期、重试清掉上次的计时、意外错误显示通用中文。）

清单之外已有的单测：`app/`（dialogs、menu、notifications、protocol、proxy、window-state）、`ipc/handlers`、`ipc/documents-smoke`、`log/logger`、`pdf/inspect`、`pdf/verify`、`pdf/load-pdf-lib`、`pdf/dom-matrix`、`pdf/worker-host`、`settings/`（host、secrets、settings）、`translate/http`；`shared/`（errors、pdf-types、presets、text）；渲染进程的 `store/documents`（排序与方向键、按 seq 合并处理记录、换库后丢弃旧响应、推送与筛选计数、删除后选中相邻行、只采用最新的 `list()` 响应）、`store/ui`（`openSettings` 的默认页签、换库保留主题、`clearConfirm` 只清自己）、`lib/labels`、`api/errors`（`toDocflowError`）、`views/Document/progress`（阶段状态、用时）、`views/Library/virtual-list`；`tests/mock-provider/server.test.ts`。`tests/unit/placeholder.test.ts` 只是占位。

## 8.5 E2E 场景（`tests/e2e/*.spec.ts`）

前置：`playwright.config.ts` 单 worker、每个测试 180 s、CI 上失败重试 1 次、失败时保留 trace；`globalSetup`（`tests/e2e/global-setup.ts`）在 38111 端口启动 mock 服务，结束时关闭。`tests/e2e/helpers.ts` 导出的 `test` 带 fixture：`mockProvider`（自动，每个测试开始时 `POST /reset`，因此 429 计数、延迟都从头开始；`configure()` 改 `POST /config`，`stats()` 读 `GET /stats`）、`tempDir`/`dataDir`（每个测试独立的临时目录，作为 `DOCFLOW_DATA_DIR`；主进程据此把 Electron `userData` 放到 `<dir>/.electron-user-data`，不碰真实用户目录与 host.json）、`launch`（启动 `release/` 下的打包产物，默认带 `DOCFLOW_MOCK_PROVIDER_URL=http://127.0.0.1:38111`，`mock: false` 时不带；默认带 `DOCFLOW_HIDE_WINDOW=1`，窗口不显示、不占 Dock、不发通知，本地想看界面时设 `E2E_SHOW=1`；等窗口标题为 `DocFlow`、`window.docflow` 就绪、界面出现 `全部文档`、空状态或 `处理引擎未运行` 的文字；设了 `E2E_WINDOW` 时先改窗口大小）。测试结束时 fixture 关闭仍在运行的应用并删除临时目录；失败的测试会先把目录里的 `main.log` 附到报告。

常用 helper：`configureMockProvider(page, { translation? })` 用 IPC 保存 DeepSeek 服务商（模型 `mock-chat`）、Key `test-key` 与默认翻译模型，并等空状态变为已配置文案；`createDocument(page, path, { title?, model? })` 直接调 `documents:create`（不经过「新建翻译」弹窗与文件对话框）并等对应行出现；`waitForStatus`/`waitForDocument`/`documentEvents`/`cachedSegments`（读 `work/translation-cache.json` 的条目数）/`fetchInMain`（在主进程 `net.fetch`）。

CI 的屏幕较窄（窗口 < 1100 px），文档详情是覆盖列表的抽屉：选中文档用 `openDocument(page, id)`（先按 Esc 关掉已打开的抽屉再点行），操作行菜单直接点行内的 `更多`，不要先点行。本地用 `E2E_WINDOW=1000x700 npx playwright test` 按窄窗口跑一遍。

1. `first-run.spec`：启动 → 空状态显示未配置提示 → 点 `添加大模型服务商…` 直达设置 → 翻译服务 → `添加服务商` → DeepSeek 预设 → 填 Key `test-key` 并 `保存` → `获取模型列表…` → 勾选 `mock-chat` → `确定`（轮询 `settings:get`，模型列表恰好是 `['mock-chat']`，没有重复也没有丢）→ `检查` 显示 `可用`，`capabilities.llmReady` 为 true → `返回文档库` → 空状态变为已配置文案。整个流程走界面。
2. `translate.spec`：带 `DOCFLOW_E2E_SAVE_PATH` 启动（主进程保存对话框直接用这个路径）→ `configureMockProvider` → `createDocument(two-column.pdf)` → 轮询到 `completed` 且行的 `data-status` 一致 → 点行、`中文 PDF` 页签：iframe `src` 以 `docflow://library/` 开头，在主进程里 `net.fetch(src)` 断言 200、`application/pdf`、`%PDF-` 开头、大于 1000 字节；等 6 s 后 iframe 仍在，没有出现「无法在应用内预览」兜底 → `处理记录` 页签含 `校验通过` → `导出` → `中文 PDF…` → Toast `已导出`，保存的文件以 `%PDF-` 开头。不测「新建翻译」弹窗与拖放（Electron 的文件对话框无法用 Playwright `setInputFiles` 驱动）。
3. `failure.spec`：`encrypted.pdf` → 失败，提示含 `已加密`；Key 改成 `bad-key` 后 `single-column.pdf` → 失败提示含 `API Key`；Key 改回、服务商的模型换成 `missing-model` 后 → 失败提示含 `模型`（每项 `failure.message` 与界面各断言一次；`providers:save` 只传配置字段，不能把 `settings:get` 的视图对象原样传回）。
4. `cancel-retry.spec`：mock 延迟 500 ms、关闭周期 429，`perDocumentConcurrency: 1`、每批 2 段（`SLOW_TRANSLATION`），`long.pdf` 的翻译阶段约 15 s；用 `documents:get` 轮询到 `stage=translate` 且进度超过 30%、`work/translation-cache.json` 已有条目，再点详情的 `取消处理…` → 确认框里的 `取消处理` → 状态已取消且停在翻译阶段 → mock 延迟改回 0 → `重新处理` → 完成；取消之后的事件里有 `缓存命中 n 段`，整个处理记录只有一条「已取消处理」，`处理记录` 页签上能看到「缓存命中」。
5. `restart.spec`：同样放慢翻译，确认在翻译阶段（`status=processing`、`stage=translate`）且缓存文件已有条目后关闭应用（`app.close()`）→ mock 延迟改回 0、同一文档库重新启动 → 文档完成；处理记录含「应用重新启动，从断点继续」与 `缓存命中 n 段`，且没有「已取消处理」（退出应用不算取消）。
6. `settings.spec`：原文档库目录名为 `DocFlow`（`library:change` 会给其他名字的目录追加 `/DocFlow`，否则「改回原位置」会进到空的子目录）。先完成一篇 `single-column.pdf`；在界面上把主题改成 `深色`、同时处理的文档数改成 3、代理选 `不使用代理`、提示词改掉并 `保存` → 关闭前 `expect.poll` 等 `settings:get`/`app:info` 反映新值 → 重启后 IPC 读到的四项不变，界面上「同时处理的文档数」仍是 3；`更改…`（`DOCFLOW_E2E_FOLDER_PATH` 代替选文件夹对话框）→ 确认框 `更改` → `libraryDir` 变为 `<新目录>/DocFlow`、文档数为 0，文档库显示空状态；再用 IPC `library:change` 改回 → 原文档仍是已完成，同时处理的文档数又是 3（设置跟着文档库走）。
7. `delete.spec`：完成一篇 `single-column.pdf` → 行内 `更多` → `删除…` → 确认框 `删除` → 空状态出现、行消失、`documents/<id>` 目录不存在、`documents:list` 计数为 0。
8. `window-title.spec`：不带 mock（`mock: false`）启动，窗口标题为 `DocFlow`。

2026-09-23 修完复查问题后，`npm run dist:dir` + `npx playwright test` 连续 4 轮 8 passed（约 27 s，见 [M5 修复 worklog](../worklog/2026-09-23-m5-fixes.md)）。

约定（M5 实测，见 `docs/worklog/2026-09-22-m5-ui.md`、`docs/worklog/2026-09-23-m5-e2e.md`、`docs/worklog/2026-09-23-m5-review.md`）：

- 启动的是 `electron-builder --dir` 产物（`npm run dist:dir`；macOS 找 `release/mac-arm64` 或 `release/mac`，Windows 找 `release/win-unpacked`），不是 `npm run dev`。改 `src/renderer` 后必须重打，否则 DOM 与源码不一致。
- HeroUI 3 的 `Button` 渲染原生 `<button>`，会转发 `data-testid` 与 `aria-label`（M5 时「找不到 testid」是打包产物过期）。按钮优先 `getByRole('button', { name, exact: true })` 或 testid，页签用 `getByRole('tab', …)`，菜单项用 `getByRole('menuitem', …)`，确认框里的按钮先限定在 `getByRole('alertdialog')` 内；列表行用 `data-testid="document-row-<id>"` 与 `data-status`。界面上的其他 testid：`document-list`、`library-empty`、`drop-overlay`、`add-provider`、`preset-<预设 id>`。
- 同一段文字按设计会同时出现在状态标签、进度行和处理记录里（如 `已加密`、`API Key`、`校验通过`、`缓存命中`），Playwright 严格模式下要 `.first()`。
- 等状态用 IPC：`waitForStatus(page, id, status)` / `waitForDocument(page, id, predicate)` 轮询 `documents:get`（到了别的终态立即失败并给出 failure），再断言对应行的 `data-status`。不要用界面上常驻的文字当同步点（侧栏筛选「已完成」、按钮「新建翻译」里的「翻译」都一直在）。
- 需要「处理到一半」的场景用 `mockProvider.configure({ delayMs })` 放慢请求，并在创建文档前用 `configureMockProvider(page, { translation: SLOW_TRANSLATION })` 让批次串行；不要靠固定等待去猜阶段。
- 确认写盘：设置改动是异步 IPC，关窗前用 `expect.poll` 等 `settings:get` / `app:info` 反映新值（写入完成后才会更新内存值）。
- 改文档库位置：`DOCFLOW_E2E_FOLDER_PATH` 绕过选文件夹对话框；有它时 `dataDirFromEnv` 为 false，设置页的 `更改…` 可点。导出：`DOCFLOW_E2E_SAVE_PATH` 绕过保存对话框。

## 8.6 验收清单（发布前人工）

- [ ] 5 篇真实论文（两栏、含公式图表；至少一篇有彩色标题背景、一篇有表格）用 DeepSeek 跑通，逐页翻看：正文全部翻译、公式位置合理、图表未被覆盖、标题与图注翻译。
- [ ] 断网时新建翻译：事件里有重试 warning，恢复网络后自动继续。
- [ ] Windows 与 macOS 各安装一次、升级安装一次（数据保留）。
- [ ] 深浅主题切换无闪烁；窗口尺寸记忆。
- [ ] 应用运行 2 小时、翻译 20 篇后主进程内存 < 500 MB。
