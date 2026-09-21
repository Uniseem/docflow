# 旧版本（3.x，`old` 分支）参考笔记

> 这些是从 `old` 分支（最后一次提交 `239d554`）整理出来的事实，供 4.0 复用文案、接口设计与经验。凡是与 `docs/plan/` 冲突的，以规划为准。文中的路径都是 `old` 分支里的路径。

## 1. 架构

- 三部分：Rust 引擎 `engine/`（tokio + sqlx/SQLite + reqwest + typst），macOS SwiftUI 客户端 `apps/macos/`，Windows WinUI 3 客户端 `apps/windows/`。客户端把引擎作为子进程启动，通过 **stdin/stdout 的换行分隔 JSON-RPC**（协议版本 3，单行最大 4 MiB）通信；引擎在 stdin 关闭时退出。**没有 HTTP 服务、没有端口**。
- PDF 原生翻译由引擎再启动一个打包的 CPython 3.12 子进程运行 BabelDOC 0.6.4（`engine/native-pdf/runner.py`），Python 侧把每个段落通过 stdout JSONL 交给 Rust 翻译（`{"type":"translate","request_id":1,"text":"Source {v0}"}` → `{"type":"translation",...}`），进度用 `{"type":"progress","stage":"Translate Paragraphs","current":1,"total":3,"percent":33.3}` 上报。
- 数据：`<data>/docflow.db`（SQLite，WAL）、`<data>/work/<uuid>/`（可再生工作区，归档后删除）、`<data>/archives/<storage_key>/`（永久）。macOS 默认 `~/Library/Application Support/DocFlow`，Windows `%LOCALAPPDATA%\DocFlow`。

## 2. RPC 方法（供 4.0 IPC 设计参照）

`engine.initialize`（带 secrets）、`engine.shutdown`、`settings.get`、`settings.update`、`secrets.set`、`secrets.verify`、`providers.save`、`providers.delete`、`providers.models`、`providers.check`、`documents.create|list|get|events|rename|retry|cancel|delete|exportBundle`。错误码：`parse_error | invalid_params | user_error | method_not_found | failed`，`user_error` 与 `invalid_params` 的 message 直接展示给用户。通知：`event`（处理记录）、`document.changed`、`document.removed`。

`documents.list` 参数 `{filter: all|active|completed|failed, query, limit, offset}`，返回 `{items, total, counts: {all, active, completed, failed}}`。

`DocumentView` 字段：`id, title, original_filename, source_size, source_sha256, mime_type, processing_mode, translator_label, status, stage, progress, failure_reason, queue_attempts, pages_processed, pages_total, created_at, updated_at, started_at, completed_at, files{source, mono_pdf, dual_pdf, ...}, suggested_names{mono_pdf, dual_pdf, bundle, source}, running`。

导出建议文件名（由标题生成，非法字符换 `_`，空标题用「文档」）：`<title>-中文译文.pdf`、`<title>-双语对照.pdf`、`<title>-完整文件.zip`，源文件保留原名。

## 3. 状态机与事件

- 状态：`queued | processing | retrying | completed | failed | cancelled`。界面分组：进行中 = queued/processing/retrying；已完成；失败与取消 = failed/cancelled。
- 自动重试：非永久性错误最多 3 次，间隔 `20 × 次数` 秒；永久性错误（用户可解决的：文件不对、Key 无效、模型不存在……）直接失败。启动时把 `processing` 的文档重新排队（`resumed_after_restart`）。手动「重新处理」会用当前设置重新快照；自动重试沿用提交时的快照。
- 事件记录：`{id, document_id, stage, state: running|completed|warning|failed, level: info|success|warning|error, progress, message, detail, current, total, created_at}`，时间戳 UTC RFC-3339 带毫秒。
- 原生路线进度分配：接收 0–4 → 检查 PDF 5–9 → 分析版面 10–29 → 翻译段落 30–79 → 排版译文 80–89 → 校验结果 90–93 → 保存 94–100。界面上的阶段名与说明：
  - `接收与排队`／`复制源文件并加入处理队列`
  - `检查 PDF`／`检查文本层，拒绝扫描件与加密文件`
  - `分析版面`／`分析页面、段落与公式`
  - `翻译段落`／`<翻译服务>，共享任务池并发翻译`
  - `排版译文`／`保留页面版式，生成中文与双语 PDF`
  - `校验结果`／`检查两份 PDF 的页数、尺寸与可读性`
  - `保存到文档库`／`写入译文、PDF 与处理记录`

## 4. 翻译子系统（4.0 直接移植）

详见 `docs/plan/04-translation.md`，那里已经把预设表、提示词、占位符规则、错误分类、重试阶梯、并发池、缓存指纹全部按旧实现写清。旧实现位置：`engine/src/providers.rs`、`engine/src/pipeline/translate.rs`、`engine/src/pipeline/translate_native.rs`、`engine/src/translation_pool.rs`、`engine/src/secrets.rs`、`engine/src/http.rs`。

`engine/tests/mock_providers.py` 是一个故意制造各种故障（429、截断、丢段、损坏占位符、拒绝、`<think>` 包裹）的假服务商，4.0 用 TypeScript 重写成 `tests/mock-provider/`。

## 5. 界面文案（可直接复用）

### 文档库

- 筛选：`全部文档`／`进行中`／`已完成`／`失败与取消`；搜索框提示 `搜索标题或文件名`；标题下方 `N 个文档`。
- 行副标题：`<翻译服务> · <大小> · <N 页> · <相对时间>`；进行中显示 `排队中`／`处理中 · N%`／`等待重试 · N%`；状态标签 `排队中／处理中／等待重试／已完成／失败／已取消`。
- 右键/菜单：`用默认应用打开`、`在访达中显示`（Windows：`在文件资源管理器中显示`）、`重新处理`、`取消处理…`、`重命名…`、`删除…`。
- 拖放浮层：`松开以添加文档`；拖拽提示（Windows）`添加到 DocFlow`。
- 空状态：已配置模型时 `把 PDF 拖到这里，或点按“新建翻译”。`；未配置时 `DocFlow 用大模型翻译。先在设置中添加一个服务商（DeepSeek、通义千问、Kimi、Claude 等）并填写 API Key，再把文件拖到这里。` + 按钮 `添加大模型服务商…`。
- 删除确认：`删除“<title>”？`／`删除 N 个文档？`，正文 `译文、PDF、处理记录和文档库里的源文件副本都会被删除，你最初选择的文件不受影响。此操作无法撤销。`
- 取消确认：`取消处理“<title>”？`，正文 `正在进行的解析、翻译或排版会停止。源文件和已完成的翻译断点会保留，之后可以重新处理。`，按钮 `取消处理`／`继续处理`。
- 重命名：标题 `重命名`，字段 `标题`，按钮 `重命名`／`取消`。

### 新建翻译

- 标题 `新建翻译`；文件区 `将文件拖到这里`／`选择文件…`；每个文件一行（名称、大小或红色问题文字、移除按钮 `移除这个文件`）。
- 字段：`翻译模型`（选项 `<服务商> · <模型名>`，无可用时 `尚未添加`），`标题`（只有一个文件时出现，占位 `默认使用文件名`）。
- 文件问题：`文件不存在`、`PDF 原生翻译只支持 .pdf 文件`、`不支持 .xyz 文件`、`不支持无扩展名的文件`、`文件为空`、`文件超过 N MB`。
- 阻塞问题：`还没有可用的大模型：请在设置的“翻译服务”中添加服务商、填写 API Key 并获取模型。`、`所选的模型已停用或已删除，请换一个模型。`
- 按钮：`添加文件…`、`取消`、`开始翻译`／`开始翻译 N 个文件`。逐个文件创建，成功的从列表移除，失败的留在列表并显示 `<文件>：<原因>`。

### 文档详情

- 视图切换：`中文 PDF`／`双语对照`／`处理记录`。
- 操作：`重新处理`、`取消处理`、`用默认应用打开`、`导出`（`中文 PDF…`、`双语对照 PDF…`、`源文件…`、`全部文件（ZIP）…`）、`文档信息`。
- 导出结果：成功提示 `已导出“<文件名>”` + `在访达中显示`／`打开所在文件夹`（6–8 秒自动消失）；失败弹窗 `导出失败`，正文 `“<文件名>”没有导出：<原因>`。
- 处理面板：`处理进度`、`处理阶段`、`处理记录 · N 条`、开关 `只看警告和错误`、空状态 `没有警告或错误。`／`暂无记录。`；失败框 `处理失败`／`已取消处理` + `重新处理`。
- 文档信息：`文档`（状态、翻译服务、页数）、`源文件`（文件名、大小、SHA-256 前 16 位，完整值放提示）、`时间`（加入、开始、完成、用时）。

### 设置

- 页签：`通用`、`翻译服务`、`网络`、`高级`（旧版还有 `文档解析`，4.0 去掉）。
- 通用：`默认翻译模型`（无则 `尚未添加大模型服务商`）、`同时处理的文档数` 1–4（说明：`同时处理更多文档会占用更多 CPU 和内存，翻译请求的并发由各服务商的“并发请求数”控制。`）、`文档库`：`位置`、`在访达中显示`、`更改…`、`日志`。
- 更改文档库：选择文件夹提示 `选择存放文档库的文件夹，DocFlow 会在其中使用“DocFlow”文件夹。`；确认 `更改文档库位置？`，正文 `DocFlow 会在新位置使用独立的文档库，现有文档保留在原位置，改回原位置即可再次看到。进行中的任务会在下次打开对应文档库时继续。`，按钮 `更改`／`取消`。
- 翻译服务：左列表 `大模型服务商`，行状态 `已停用`／`需要添加模型`／`需要 API Key`／`N 个模型`；添加菜单分组 `国内服务`／`国际服务`／`本机模型`／`自定义服务商…`。详情：`启用`、`名称`、`接口类型`（只读）、`API 地址`（占位 `https://…/v1`，下方 `请求地址：<计算出的完整地址>`）、`API Key`（状态 `已保存 ••••••••1a2b`／`本机服务，无需 Key`／`未填写`；占位 `粘贴 API Key`／`输入新的 Key 以替换`；链接 `获取 API Key`；按钮 `移除`、`保存`；说明 `多个 Key 用英文逗号分隔，请求会轮流使用；某个 Key 失效或余额不足时自动改用其余的。Key 只保存在本机。`）、`模型`（每行 `检查` 与删除；按钮 `手动添加…`、`获取模型列表…`；检查结果 `可用 · <ms> ms · “<回复>”`）、`并发请求数`（1–2000，说明 `同时发往这个服务商的请求上限，所有文档共用；默认 100。遇到限流（HTTP 429）会自动减半，恢复后逐步回升。`）、`附加请求参数（JSON，可选）`（说明 `合并进每个请求，例如 {"temperature": 0.3}，或关闭思考模式的参数。`）、`删除服务商`（确认 `服务商的设置和保存在本机的 API Key 会被删除。已经完成的文档不受影响；使用它排队中的文档将无法继续翻译。`）。
- 获取模型列表弹窗：标题 `<服务商> 的模型`，搜索 `在 N 个模型中搜索`，行 `id` + `name · owner · 上下文 NK`，底部 `已选择 N 个模型`，按钮 `取消`／`确定`；结果 `已添加 N 个、移除 M 个模型。`；空结果 `服务商没有返回任何模型，请手动添加模型 ID。`
- 手动添加模型：标题 `添加模型`，字段 `模型 ID`，说明 `与服务商文档中的模型名称一致，例如 deepseek-chat。`
- 自定义服务商：`名称`（占位 `例如 公司网关`）、`接口类型`（`OpenAI 兼容（最常见）`／`Anthropic`／`Gemini`／`Azure OpenAI`）、`API 地址`，说明 `OpenAI 兼容接口填写到 /v1 为止，程序会在后面加上 /chat/completions。`
- 网络：`代理`：`跟随系统`／`不使用代理`／`自定义`，`代理地址`（占位 `http://127.0.0.1:7890 或 socks5://127.0.0.1:1080`），说明 `访问大模型服务商时使用的网络代理。“跟随系统”会读取系统设置中的代理。`
- 高级：`每段最多字符`（100–32000）、`单次请求最多段数`（1–64）、`单次请求最多字符`（500–100000）、`最大输出 tokens`（0–1000000，0 = 服务商默认）、`单个文档最多同时发出的请求数`（1–1000）、`翻译提示词（大模型）`（≤ 12000 字，说明 `公式、代码、链接和排版标记由程序在本地保护，提示词无需说明这些规则。新任务使用新参数，进行中的任务保持提交时的设置。`）、按钮 `恢复默认`／`保存`。

## 6. 教训

1. **收尾卡死的根因**（ADR-0003）：BabelDOC 的字体子集化与保存被改成进程内同步调用并去掉了 120 s 看门狗，同时把 `pdf_creater` 模块的 WARNING 升级为致命错误，还把异常文本藏起来。4.0 的原则：每个阶段有超时、每个段落独立容错、日志保留完整堆栈。
2. **构建慢的根因**：Python wheel 安装、离线资源下载（CDN 429）、逐文件 min-OS 扫描与签名、1–2 GB 工件在 job 间传递、Rust 全量编译、Inno Setup LZMA 压缩 1.5 GB。4.0 全部消失。
3. **BabelDOC 的 ASCII 路径限制**导致 Windows 上要把工作区搬到 `%ProgramData%`、还要硬链接镜像资源。4.0 没有此问题。
4. **两套原生客户端**的文案与逻辑要写两遍。4.0 只有一套。
5. Key 轮换与 429 自适应降并发的设计是好的，保留。
6. 占位符损坏修复（`DOCFLOW KEEP 0 0 0 0 0 0 TOKEN` 这类被模型拆开的标记能被容错正则复原）救回了很多段落，保留。
7. 用户明确要求过：导出后要有明确的成功提示并能一键打开所在文件夹；失败要说明原因。
