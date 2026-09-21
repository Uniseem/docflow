# 06 界面规格

> 组件全部来自 `@heroui/react` 3（复合组件 API：`Card.Header`、`Modal.Dialog`、`Select.Trigger`、`Table.Content`、`Tabs.Panel`、`Toast.Provider`……），图标用 `lucide-react`。执行前先用 `npx heroui-cli@latest agents-md --react --output .heroui-docs/AGENTS.md` 拉取本地文档核对每个组件的具体 props。文案以本章为准，一字不改；本章没写到的沿用 `docs/reference/legacy-notes.md` §5。

## 6.1 总体布局

单窗口、单页应用，无路由库。`ui` store 的 `view: 'library' | 'settings'`，`library` 视图内 `selectedId: string | null`。

```
┌──────────────────────────────────────────────────────────────────────┐
│ [macOS 红黄绿留白 80px] DocFlow            搜索[            ] [新建翻译] │  顶栏 h-12，titlebar-drag
├──────────┬───────────────────────────┬───────────────────────────────┤
│ 侧栏 220 │ 文档列表（可滚动）          │ 详情面板（选中时；最小 480）     │
│ 全部文档 │ ┌───────────────────────┐ │  标题 / 状态 / 操作             │
│ 进行中   │ │ 行                    │ │  [中文 PDF][双语对照][处理记录]   │
│ 已完成   │ │ 行                    │ │                               │
│ 失败与取消│ └───────────────────────┘ │  iframe 或 处理面板            │
│          │                           │                               │
│ ⚙ 设置   │                           │                               │
└──────────┴───────────────────────────┴───────────────────────────────┘
```

- 顶栏：macOS 左侧留 80 px 给红绿灯（`titleBarStyle: hiddenInset`），整条 `titlebar-drag`，内部控件 `titlebar-no-drag`。Windows 用系统标题栏，顶栏不留白。
- 侧栏（`Surface`/`div` + `ListBox`）：四个筛选项，右侧 `Chip size="sm"` 显示计数（进行中为 `accent`，其他 `default`）；底部「设置」按钮（`Button variant="ghost"` + `Settings` 图标）。宽 220 px 固定。
- 列表与详情用可拖动分隔（不做拖动，固定：列表 `flex-1 min-w-[360px]`，详情 `w-[52%] min-w-[480px]`；窗口 < 1100 px 时详情改为覆盖式 `Drawer` 从右侧滑出）。
- 键盘：`⌘/Ctrl+N` 新建翻译；`⌘/Ctrl+,` 设置；`⌘/Ctrl+F` 聚焦搜索；`Delete/Backspace` 删除选中；`Esc` 关闭对话框/详情抽屉；`↑↓` 在列表中移动选择。
- 主题：`<html class="dark" data-theme="dark">` 切换；设置 → 通用 → 外观：跟随系统 / 浅色 / 深色。

## 6.2 文档库（`views/Library/`）

### 列表行 `DocumentRow`

- 左：状态图标（`FileText`；进行中用 `Spinner size="sm"`；失败 `AlertTriangle` 红；完成 `CheckCircle2` 绿；取消 `XCircle` 灰）。
- 中：第一行标题（单行截断，`title` 属性给完整）；第二行副标题：`<translator.label> · <大小> · <N 页>（有则显示）· <相对时间>`（相对时间：刚刚 / N 分钟前 / N 小时前 / 昨天 / M月D日 / YYYY年M月D日）。
- 进行中：第三行 `ProgressBar size="sm" value={progress}` + 文字 `排队中` / `处理中 · N%` / `等待重试 · N%`，以及当前阶段名（6.4 的阶段名）。
- 右：`Dropdown` 菜单按钮（`MoreHorizontal`），项：`用默认应用打开`（仅完成）、`在访达中显示`（Windows：`在文件资源管理器中显示`）、分隔、`重新处理`（失败/取消）、`取消处理…`（进行中）、`重命名…`、`删除…`（红）。
- 选中态：`bg-accent/10`；双击 = 用默认应用打开（完成时）。
- 列表虚拟化：文档 > 200 时用简单窗口化（只渲染可见区 ±20 行；自己写，不引库）。

### 空状态

- 库为空且已配置模型：插画（`FileUp` 图标 64px）+ `把 PDF 拖到这里，或点按“新建翻译”。` + `Button variant="primary"` `新建翻译…`。
- 库为空且未配置模型：`DocFlow 用大模型翻译。先在设置中添加一个服务商（DeepSeek、通义千问、Kimi、Claude 等）并填写 API Key，再把文件拖到这里。` + `Button` `添加大模型服务商…`（跳到设置 → 翻译服务）。
- 筛选/搜索无结果：`没有符合条件的文档` / `试试其他筛选条件或搜索词。`

### 拖放

整个窗口是放置目标（`dragover` 时显示全屏半透明浮层 `松开以添加文档`，`Upload` 图标）。放下后：取 `.pdf` 文件路径（用 `webUtils.getPathForFile(file)`，在 preload 里暴露为 `docflow.pathsForFiles(files)`）；非 PDF 的文件用 Toast 警告 `已忽略 N 个非 PDF 文件`；有 PDF 则打开「新建翻译」并预填。macOS `app:openFiles` 推送同样打开。

### 搜索

顶栏 `SearchField`，占位 `搜索标题或文件名`，250 ms 防抖后 `documents:list`。

### 对话框（`AlertDialog`）

- 删除：标题 `删除“<title>”？`（多选 `删除 N 个文档？`），正文 `译文、PDF、处理记录和文档库里的源文件副本都会被删除，你最初选择的文件不受影响。此操作无法撤销。`，按钮 `删除`（danger）/ `取消`。
- 取消处理：标题 `取消处理“<title>”？`，正文 `正在进行的解析、翻译或排版会停止。源文件和已完成的翻译断点会保留，之后可以重新处理。`，按钮 `取消处理`（danger）/ `继续处理`。
- 重命名（`Modal`）：标题 `重命名`，`TextField` 标签 `标题`（预填、全选），按钮 `重命名`（primary，空白时禁用）/ `取消`。

## 6.3 新建翻译（`views/NewTranslation/NewTranslationModal.tsx`）

`Modal`（`size="lg"`，宽 640），标题 `新建翻译`。

1. **文件**区：空时 `DropZone`（虚线框，`将文件拖到这里` + `Button variant="secondary"` `选择文件…`）；有文件时列表：`FileText` 图标、文件名、大小（或红色问题文字）、`CloseButton`（`aria-label` `移除这个文件`）；底部 `Button variant="ghost"` `添加文件…`。区下方说明 `只支持带文本层的 PDF；扫描件、加密文件和 Office 文档无法处理。`
2. **翻译模型**：`Select`，选项按服务商分组（`ListBox.Section` 标题 = 服务商名，项 = 模型名或 id），值 = `providerId/model`；默认 = `settings.defaultTranslator`；无可用模型时显示 `尚未添加` 并禁用提交。说明 `由所选的大模型翻译；速度和费用取决于服务商和模型。`
3. **标题**：仅当恰好一个文件时显示 `TextField`，占位 `默认使用文件名`，预填文件主名。
4. 阻塞提示（`Alert variant="warning"`）：`还没有可用的大模型：请在设置的“翻译服务”中添加服务商、填写 API Key 并获取模型。`（带 `打开设置…` 按钮）；`所选的模型已停用或已删除，请换一个模型。`
5. 提交错误（`Alert variant="danger"`）：`部分文件未能添加`，下面逐行 `<文件名>：<原因>`。
6. 底部：`取消` / `开始翻译`（一个文件）或 `开始翻译 N 个文件`（primary，`isPending` 时转圈）。`Enter` 提交。

文件校验（加入列表时就显示问题，提交时阻止）：`文件不存在`、`只支持 .pdf 文件`、`文件为空`、`文件超过 500 MB`。去重按绝对路径。

提交：`documents:create` 一次传所有路径；成功的从列表移除；全部成功 → 关闭、把筛选切到 `全部文档`（若当前是已完成/失败）、选中第一个新文档、Toast `已添加 N 个文档`；部分失败 → 保留失败项与错误。

## 6.4 文档详情（`views/Document/`）

### 头部

标题（可双击进入重命名）、`Chip` 状态（`排队中`/`处理中`/`等待重试`/`已完成`/`失败`/`已取消`，颜色 default/accent/warning/success/danger/default）、副标题 `<translator.label> · <N 页> · <大小>`。右侧 `ButtonGroup`：

- 完成：`打开`（`ExternalLink`，默认应用打开中文 PDF）、`导出`（`Dropdown`：`中文 PDF…`、`双语对照 PDF…`（有则显示）、`源文件…`、分隔、`全部文件（ZIP）…`）、`Dropdown` 更多：`在访达中显示`/`在文件资源管理器中显示`、`重命名…`、`重新处理`、`删除…`。
- 进行中：`取消处理…`、更多：`重命名…`、`在访达中显示`。
- 失败/取消：`重新处理`（primary）、更多同上 + `删除…`。
- 右上 `文档信息` 按钮（`Info` 图标）打开 `Drawer`（右侧，宽 360）：分组 `文档`（状态、翻译服务、页数、段落数 `已翻译 X / 待翻译 Y，保留原文 K`、用量 tokens）、`源文件`（文件名、大小、SHA-256 前 16 位 + `Tooltip` 全值，可选中）、`时间`（加入、开始、完成、用时；进行中每秒刷新）、按钮 `在访达中显示`、`用默认应用打开`。

### 内容区

`Tabs`：`中文 PDF`、`双语对照`（`settings.pdf.bilingual` 或文件存在时）、`处理记录`。完成时默认 `中文 PDF`；未完成时只有 `处理记录`，并在其上方显示处理面板。

- PDF 页签：`<iframe class="w-full h-full border-0" src={files.mono + '#toolbar=1&navpanes=0'} title="中文 PDF">`。加载失败（`onError` 或 5 s 内无 load）显示 `无法在应用内预览，请用默认应用打开。` + 按钮。删除文档前先把 `src` 设为 `about:blank`。
- 处理面板（未完成时）：
  - `Card` `处理进度`：`ProgressBar value={progress}`（`progress <= 3` 时 `isIndeterminate`）、`N%`、当前阶段名与最近一条事件、已用时。失败时 `Alert variant="danger"` 标题 `处理失败`（取消：`已取消处理`），正文 = `failure.message`，按钮 `重新处理`。等待重试：`Alert variant="warning"` `等待自动重试（第 n 次），<倒计时> 秒后开始`。
  - `Card` `处理阶段`：七行，图标 `CheckCircle2`（已完成）/ `Spinner`（进行中）/ `XOctagon`（失败）/ `Circle`（等待）；名称与说明：

    | 阶段 | 说明 | 进度区间 |
    | --- | --- | --- |
    | 接收与排队 | 复制源文件并加入处理队列 | 0–2 |
    | 检查 PDF | 检查文本层，拒绝扫描件与加密文件 | 3–9 |
    | 分析版面 | 识别段落、栏与公式 | 10–29 |
    | 翻译段落 | `<translator.label>`，共享任务池并发翻译 | 30–79 |
    | 排版译文 | 渲染公式贴图，保留页面版式写入译文 | 80–89 |
    | 校验结果 | 检查两份 PDF 的页数、尺寸与可读性 | 90–93 |
    | 保存到文档库 | 写入译文、PDF 与处理记录 | 94–100 |

- 处理记录页签：头部 `处理记录 · N 条` + `Switch` `只看警告和错误`；列表最新在上，每行：级别图标（info `Info` 灰 / success `CheckCircle2` 绿 / warning `AlertTriangle` 黄 / error `XCircle` 红）、`message`、`detail`（次要色、可选中）、右侧 `HH:mm:ss`、`+用时`（距首条事件）、`N%`、`current/total`。空：`没有警告或错误。` / `暂无记录。`。>1000 条时只渲染最近 1000 条并提示 `只显示最近 1000 条`。

### 导出结果

- 成功：`toast.success('已导出“<文件名>”', { action: { label: '打开所在文件夹', onPress } , timeout: 8000 })`。
- 失败：`AlertDialog` 标题 `导出失败`，正文 `“<文件名>”没有导出：<原因>`。
- 用户取消保存对话框：无提示。

## 6.5 设置（`views/Settings/`）

全页视图（顶栏左侧出现 `返回文档库` 按钮），左侧 `Tabs orientation="vertical"`（宽 180）：`通用`、`翻译服务`、`网络`、`高级`、`关于`。首次打开且 `llmReady=false` 时自动定位到 `翻译服务`。所有修改即时保存（`settings:update`），保存失败 Toast `设置未保存：<原因>`。

### 通用

- `Card` `新建翻译`：`默认翻译模型`（`Select`，同 6.3 分组；无则显示 `尚未添加大模型服务商`）、`同时处理的文档数`（`NumberField` 1–4）。说明：`同时处理更多文档会占用更多 CPU 和内存，翻译请求的并发由各服务商的“并发请求数”控制。`
- `Card` `外观`：`主题` `RadioGroup`：`跟随系统` / `浅色` / `深色`。
- `Card` `文档库`：`位置`（路径，可选中）+ `在访达中显示` + `更改…`（`DOCFLOW_DATA_DIR` 存在时禁用并提示 `由环境变量 DOCFLOW_DATA_DIR 指定`）；`日志` + `打开日志文件夹`。说明 `文档库保存源文件副本、译文、PDF 和处理记录。`
  - 更改流程：`dialog:pickFolder`（title `选择文档库位置`，message `选择存放文档库的文件夹，DocFlow 会在其中使用“DocFlow”文件夹。`）→ `AlertDialog` `更改文档库位置？`，正文 `DocFlow 会在新位置使用独立的文档库，现有文档保留在原位置，改回原位置即可再次看到。进行中的任务会在下次打开对应文档库时继续。`，按钮 `更改` / `取消` → `library:change`。
- `Card` `通知`：`Switch` `翻译完成或失败时发送系统通知`。

### 翻译服务

左右布局：左列表（宽 240）`大模型服务商`：每行名称 + 状态文字（`已停用` / `需要添加模型` / `需要 API Key` / `N 个模型`），底部 `+`（`Dropdown`：分组 `国内服务`、`国际服务`、`本机模型`，分隔，`自定义服务商…`）与 `−`（删除所选，确认对话框正文 `服务商的设置和保存在本机的 API Key 会被删除。已经完成的文档不受影响；使用它排队中的文档将无法继续翻译。`）。

右侧 `ProviderDetail`（`Form`，字段变更 blur 即保存）：

- `Switch` `启用`；`TextField` `名称`；`接口类型`（只读文本：OpenAI 兼容 / Anthropic / Gemini / Azure OpenAI）；`TextField` `API 地址`（占位 `https://…/v1`），下方 `Description` `请求地址：<chatUrl 预览>`（用 `src/shared` 里的纯函数计算，模型名用第一个模型或 `<模型>`）。
- `Card` `API Key`：状态行 `已保存 ••••••••1a2b（共 N 个）` / `本机服务，无需 Key` / `未填写`；`TextField type="password"` 占位 `粘贴 API Key`（已保存时 `输入新的 Key 以替换`）；按钮 `保存`（primary）、`移除`（已保存时）、链接 `获取 API Key`（预设有 keyUrl 时，`shell:openExternal`）。说明 `多个 Key 用英文逗号分隔，请求会轮流使用；某个 Key 失效或余额不足时自动改用其余的。Key 只保存在本机，用系统加密保护。`
- `Card` `模型`：`Table`（列：模型、操作）；每行 `检查`（`Button size="sm"`，`Tooltip` `用这个模型发送一个测试请求`；结果就地显示 `可用 · 812 ms · “你好，世界。”` 绿 / 错误红）、删除图标。底部 `手动添加…`（`Modal` `添加模型`，`TextField` `模型 ID`，说明 `与服务商文档中的模型名称一致，例如 deepseek-chat。`）、`获取模型列表…`（primary）。
  - 获取流程：用当前编辑中的地址与 Key（未保存的 Key 也带上）调 `providers:listModels`；空 → Toast `服务商没有返回任何模型，请手动添加模型 ID。`；否则 `Modal` `<服务商> 的模型`（`SearchField` `在 N 个模型中搜索`，`ListBox selectionMode="multiple"`，行主文 id、副文 `name · owner · 上下文 NK`，已在列表中的预选中；底部 `已选择 N 个模型`，`取消` / `确定`）。确定后：列表里的按勾选增删，手动添加的保留；Toast `已添加 N 个、移除 M 个模型。`
- `NumberField` `并发请求数`（1–2000，步进 10）。说明 `同时发往这个服务商的请求上限，所有文档共用；默认 100。遇到限流（HTTP 429）会自动减半，恢复后逐步回升。`
- `TextArea` `附加请求参数（JSON，可选）`（等宽字体）+ `应用` 按钮；非法 JSON 或含禁用字段时 `FieldError` `不是有效的 JSON` / `不能覆盖 model、messages 等字段`。说明 `合并进每个请求，例如 {"temperature": 0.3}，或关闭思考模式的参数。`
- 自定义服务商 `Modal`：`名称`（占位 `例如 公司网关`）、`接口类型` `Select`（`OpenAI 兼容（最常见）` / `Anthropic` / `Gemini` / `Azure OpenAI`）、`API 地址`。说明 `OpenAI 兼容接口填写到 /v1 为止，程序会在后面加上 /chat/completions。`

### 网络

`RadioGroup` `代理`：`跟随系统` / `不使用代理` / `自定义`；自定义时 `TextField` `代理地址`（占位 `http://127.0.0.1:7890 或 socks5://127.0.0.1:1080`）+ `应用`。说明 `访问大模型服务商时使用的网络代理。“跟随系统”会读取系统设置中的代理。`

### 高级

`Card` `大模型请求`：`每段最多字符`（100–32000，步 100）、`单次请求最多段数`（1–64）、`单次请求最多字符`（500–100000，步 500）、`最大输出 tokens`（0–1000000，步 1024，说明 `0 = 使用服务商默认值`）、`单个文档最多同时发出的请求数`（1–1000）。
`Card` `翻译提示词`：`TextArea` 8 行，计数 `N / 12000`；按钮 `恢复默认` / `保存`。说明 `公式、代码、链接和排版标记由程序在本地保护，提示词无需说明这些规则。新任务使用新参数，进行中的任务保持提交时的设置。`
`Card` `PDF 写回`：`公式贴图清晰度`（`Slider` 2–8，说明 `倍数越高越清晰，文件越大；默认 4`）、`译文最小缩放`（`Slider` 40%–100%，默认 60%，说明 `译文装不下时允许把字号缩小到原字号的这个比例`）、`Switch` `同时生成双语对照 PDF`。

### 关于

应用名、版本、平台；`检查更新`（结果：`已是最新版本` / `有新版本 4.1.0` + `前往下载`）；`Switch` `启动时自动检查更新`；链接 `源代码`（GitHub）、`第三方许可`（打开 `THIRD_PARTY_NOTICES.md`，07 章生成）；`打开日志文件夹`。

## 6.6 Toast 与全局

- `Toast.Provider` 放在 `App` 根；位置右下；默认 `timeout` 6000。
- 全局错误：IPC 返回 `ok:false` 且 `user:false` 时 Toast `发生内部错误，详情见日志`，带 `打开日志` 动作。
- 主进程不可用（极少见，如 preload 失败）：全屏 `处理引擎未运行` + `重新启动`（`app.relaunch()`）。

## 6.7 状态管理（zustand）

- `documents` store：`items: Map<id, DocumentSummary>`、`counts`、`filter`、`query`、`selectedId`、`events: Map<id, ProcessingEvent[]>`；订阅 `document:changed/removed/event`；`list()` 在 filter/query 变化时拉取。
- `settings` store：`view: SettingsView | null`，`load()`, `update(patch)`，订阅 `settings:changed`。
- `ui` store：`view`、`theme`、`modals`（新建翻译开关与预填路径）、`toast` 辅助。

## 6.8 可访问性与细节

- 所有图标按钮有 `aria-label`；对话框首焦点在主要输入或取消按钮；列表可用键盘导航。
- 文案里的引号统一用 `“”`；数字与中文之间不加空格（沿用 3.x 文案习惯）；时间显示本地时区。
- 大小格式：`< 1 MB` 用 KB（整数），否则 MB（一位小数），`≥ 1 GB` 用 GB（两位小数）。
- 长路径用 `直接显示 + title`，不做中间省略。
