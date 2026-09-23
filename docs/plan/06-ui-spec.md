# 06 界面规格

> 组件全部来自 `@heroui/react` 3（复合组件 API：`Card.Header`、`Modal.Dialog`、`Select.Trigger`、`Drawer.Dialog`、`Tabs.Panel`、`AlertDialog.Footer`……），图标用 `lucide-react`。执行前先用 `npx heroui-cli@latest agents-md --react --output .heroui-docs/AGENTS.md` 拉取本地文档核对每个组件的具体 props。文案以本章为准，一字不改；本章没写到的沿用 `docs/reference/legacy-notes.md` §5。
>
> 2026-09-24（M7-5）按 `src/renderer/**` 的实现逐条校对过；与最初规划不同的地方就地写明原因。HeroUI 3 的几个用法坑（`Toast.Provider` 不能包住界面、`Tabs.Indicator` 要放在每个 `Tabs.Tab` 里、`Tooltip.Trigger` 会渲染可聚焦的 `div role="button"`、`Radio`/`Switch` 的 `Control` 要放在 `Content` 里）见 [2026-09-23 M5 E2E worklog](../worklog/2026-09-23-m5-e2e.md) 与 [M5 修复 worklog](../worklog/2026-09-23-m5-fixes.md)。

## 6.1 总体布局

单窗口、单页应用，无路由库。`ui` store 的 `view: 'library' | 'settings'`，`library` 视图的选中项是 `documents` store 的 `selectedId: string | null`。

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

- 顶栏：macOS 左侧留 80 px（`w-20`）给红绿灯（`titleBarStyle: hiddenInset`，`trafficLightPosition` 16/16），整条 `titlebar-drag`，内部控件 `titlebar-no-drag`。Windows 用系统标题栏，顶栏左侧只留 8 px。文档库视图：左侧文字 `DocFlow`，右侧 `SearchField`（宽 224）+ `Button variant="primary" size="sm"` `新建翻译`；设置视图：左侧换成 `返回文档库`（`variant="ghost"`），不显示搜索与新建。弹出层（backdrop、popover）设为 `no-drag`，否则压在顶栏上的部分点不动。
- 侧栏（`aside` + `ListBox aria-label="文档筛选"`）：四个筛选项，右侧 `Chip size="sm"` 显示计数（`进行中` 且计数 > 0 时为 `accent`，其他 `default`）；底部「设置」按钮（`Button variant="ghost"` + `Settings` 图标）。宽 220 px 固定。
- 列表与详情不做拖动分隔，固定：列表 `flex-1 min-w-[360px]`，详情 `w-[52%] min-w-[480px]`。窗口 < 1100 px 时详情改为覆盖式 `Drawer` 从右侧滑出，宽度写在 `Drawer.Dialog` 上（`w-[min(52%,720px)] min-w-[480px]`；`Drawer.Content` 是铺满窗口的定位层）。抽屉只在用户点行（点行内按钮除外）或在列表上按 `Enter`/`Space` 时打开，不跟随自动选中（启动和 `list()` 会自动选中第一项、没有选中时推送来的文档也会被选中，跟随的话抽屉会自己弹出来）。
- 键盘：`⌘/Ctrl+N` 新建翻译；`⌘/Ctrl+,` 设置；`⌘/Ctrl+F` 聚焦搜索；`Delete/Backspace` 删除选中（弹 6.2 的删除确认）；`Esc` 关闭文档信息抽屉与窄窗口详情抽屉（对话框自己处理 Esc）；`↑↓` 在列表中移动选择。macOS 只认 `⌘`，Windows 只认 `Ctrl`（输入框里的 Control-N/F 是移动光标，不能被劫持）。`Delete`/`↑↓` 只在文档库视图、没有打开对话框/抽屉/弹出菜单、焦点不在输入框与对话框里时生效；焦点在自带方向键导航的控件（选项、页签、单选、菜单项等）上时 `↑↓` 留给控件。
- 打开设置（侧栏 `设置`、`⌘/Ctrl+,`、macOS 菜单「设置…」）统一走 `ui.openSettings()`：尚未配置可用的大模型时定位到 `翻译服务`，否则 `通用`。
- 主题：`<html>` 上切换 `class="dark"`/`"light"` 与 `data-theme="dark"`/`"light"`；设置 → 通用 → 外观：跟随系统 / 浅色 / 深色。主题存在 host.json（`app:setTheme` 设置 `nativeTheme.themeSource`），所以首帧前 `main.tsx` 按 `prefers-color-scheme` 同步应用一次，`index.html` 内联了两种主题的背景色，深色模式启动不闪白。

## 6.2 文档库（`views/Library/`）

### 列表行 `DocumentRow`

- 左：状态图标（进行中——排队、处理中、等待重试——用 `Spinner size="sm"`；失败 `AlertTriangle` 红；完成 `CheckCircle2` 绿；取消 `XCircle` 灰；`FileText` 只是兜底）。
- 中：第一行标题（单行截断，`title` 属性给完整）；第二行副标题：`<translator.label> · <大小> · <N 页>（有则显示）· <相对时间>`（相对时间按 `updatedAt` 计算：刚刚 / N 分钟前 / 昨天 / N 小时前（同一天）/ M月D日 / YYYY年M月D日，见 `shared/text.ts` 的 `formatRelativeTime`）。
- 进行中：第三行 `ProgressBar size="sm" value={progress}`（`progress <= 3` 时 `isIndeterminate`）+ 文字 `排队中` / `处理中 · N%` / `等待重试 · N%`，后接 ` · <当前阶段名>`（6.4 的阶段名）。
- 右：`Dropdown` 菜单按钮（`Dropdown.Trigger aria-label="更多"`，内放 `MoreHorizontal` 图标，不再套 `Button`，避免按钮套按钮），项：`用默认应用打开`（仅完成）、`在访达中显示`（Windows：`在文件资源管理器中显示`）、分隔、`重新处理`（失败/取消）、`取消处理…`（进行中）、`重命名…`、`删除…`（红，任何状态都有）。
- 选中态：`bg-accent/10`；双击 = 用默认应用打开（完成时）。
- 顺序：`createdAt` 降序、`id` 降序（`store/documents.ts` 的 `sortDocuments()`，列表与方向键共用）；进度更新不改变行的位置。
- 行高固定：空闲 56 px，进行中 76 px（多一行进度）。
- 键盘：列表容器（`data-testid="document-list"`）可用 Tab 聚焦，用 `aria-activedescendant` 指向选中行；`↑↓`、`PageUp/PageDown`、`Home/End` 移动选择；窄窗口下 `Enter`/`Space` 打开详情抽屉。相对时间每分钟刷新。
- 列表虚拟化：文档 > 200 时用简单窗口化（只渲染可见区 ±20 行；自己写，不引库）；按固定行高计算位置，键盘选中时直接设置 `scrollTop`，让未渲染的行也能滚到可见区。

### 空状态

- 判定：`counts.all === 0` 且搜索词为空。
- 库为空且已配置模型：插画（`FileUp` 图标 64px）+ `把 PDF 拖到这里，或点按“新建翻译”。` + `Button variant="primary"` `新建翻译…`。
- 库为空且未配置模型：同样的 `FileUp` 图标 + `DocFlow 用大模型翻译。先在设置中添加一个服务商（DeepSeek、通义千问、Kimi、Claude 等）并填写 API Key，再把文件拖到这里。` + `Button variant="primary"` `添加大模型服务商…`（`ui.openSettings('providers')`，跳到设置 → 翻译服务）。
- 两种空状态的容器都带 `data-testid="library-empty"`。
- 筛选/搜索无结果：`没有符合条件的文档` / `试试其他筛选条件或搜索词。`

### 拖放

整个窗口是放置目标（`dragover` 时显示全屏半透明浮层 `松开以添加文档`，`Upload` 图标，`data-testid="drop-overlay"`；浮层显示期间由它接收拖放事件，拖到 PDF 预览上也能放下——否则事件会被预览 iframe 截走；3 秒没有 `dragover`、或拖动结束后鼠标一动就自动收起，`dragleave` 离开窗口时也收起）。放下后：按文件名取 `.pdf`，用 `webUtils.getPathForFile(file)`（preload 暴露为 `docflow.pathsForFiles(files)`）换成本地路径；非 PDF 与拿不到本地路径的文件（例如从浏览器拖出来的）一起计数，Toast 警告 `已忽略 N 个非 PDF 文件`；有 PDF 则打开「新建翻译」并预填（弹窗已打开时并入它的文件列表）。macOS `app:openFiles` 推送同样打开；窗口订阅之前到达的文件（命令行参数、open-file、第二个实例）在启动时用 `app:takePendingFiles` 取一次。

### 搜索

顶栏 `SearchField`（`aria-label` 与占位都是 `搜索标题或文件名`，输入框 `id="library-search"` 供 `⌘/Ctrl+F` 聚焦），250 ms 防抖后 `documents:list`。多个词用空格分开时要求全部命中（标题或原文件名，不区分大小写，`shared/library-filter.ts`）。

### 对话框（`AlertDialog`）

- 所有确认框共用 `components/ConfirmDialog.tsx`（`AlertDialog`，`size="sm"`）：左边 `取消`（或调用方给的文字，`variant="ghost"`），右边确认按钮（`danger` 时 `variant="danger"`，否则 `primary`）。文档库的删除与取消处理经 `ui` store 的 `confirm` 由 `GlobalConfirm` 统一显示。
- 删除：标题 `删除“<title>”？`，正文 `译文、PDF、处理记录和文档库里的源文件副本都会被删除，你最初选择的文件不受影响。此操作无法撤销。`，按钮 `删除`（danger）/ `取消`。界面没有多选，只有单篇删除（3.x 的 `删除 N 个文档？` 没有沿用；`deleteDocuments(ids)` 本身接受多个 id）。
- 取消处理：标题 `取消处理“<title>”？`，正文 `正在进行的解析、翻译或排版会停止。源文件和已完成的翻译断点会保留，之后可以重新处理。`，按钮 `取消处理`（danger）/ `继续处理`。
- 重命名（`Modal`，`size="sm"`，入口：行菜单、详情「更多」菜单、双击详情标题）：标题 `重命名`，`TextField` 标签 `标题`（预填、获得焦点时全选），按钮 `取消`（ghost）/ `重命名`（primary，空白时禁用，提交中转圈）；`Enter` 提交（输入法组字时除外）；提交中不能关闭。
- 确认框执行中（按钮转圈）不能用 Esc、点背景或 `取消` 关闭；执行失败时对话框保持打开，用户错误用 Toast 提示；每个确认框只清除它自己，不会关掉之后打开的另一个（每个确认对象有自己的 `key`）。

## 6.3 新建翻译（`views/NewTranslation/NewTranslationModal.tsx`）

受控的 `Modal.Backdrop`（`isDismissable`）+ `Modal.Container size="lg"`（HeroUI 的 lg 是 `max-width: var(--container-lg)`，即 32rem ≈ 512 px，没有另设 640），标题 `新建翻译`。每次打开重新挂载，不保留上次的内容。

1. **文件**区（小标题 `文件`）：空时虚线框（普通 `div`，不是 HeroUI `DropZone`；文件由 6.2 的整窗拖放接收），`将文件拖到这里` + `Button variant="secondary"` `选择文件…`（`dialog:pickPdfs`）；有文件时列表：`FileText` 图标、文件名（`title` 为完整路径）、红色问题文字（有则显示）、`CloseButton`（`aria-label` `移除这个文件`）；底部 `Button variant="ghost"` `添加文件…`。区下方说明 `只支持带文本层的 PDF；扫描件、加密文件和 Office 文档无法处理。`
2. **翻译模型**：`components/TranslatorSelect.tsx` 的 `Select`（标签 `翻译模型`），选项按服务商分组（`ListBox.Section` + `Header` = 服务商名，项 = 模型名或 id），只列出已启用且有 Key（或本机服务无需 Key）的服务商的模型；值 = `providerId/model`；默认 = `settings.defaultTranslator`，它不可用时取第一个可用模型；未选时占位 `请选择模型`；无可用模型时占位 `尚未添加` 并禁用。说明 `由所选的大模型翻译；速度和费用取决于服务商和模型。`
3. **标题**：仅当恰好一个文件时显示 `TextField`（标签 `标题`），占位 `默认使用文件名`，预填文件主名；用户改动前随文件增删更新。只有用户改过且非空时才作为 `title` 发出，否则由 PDF 元数据标题或文件名决定（05 §5.7）。
4. 阻塞提示（`Alert status="warning"`）：`还没有可用的大模型：请在设置的“翻译服务”中添加服务商、填写 API Key 并获取模型。`（带 `Button size="sm" variant="secondary"` `打开设置…`，关闭弹窗并打开设置 → 翻译服务）；`所选的模型已停用或已删除，请换一个模型。`
5. 提交错误（`Alert status="danger"`）：`部分文件未能添加`，下面逐行 `<文件名>：<原因>`。整个请求被拒绝时（例如模型刚被删除），所有文件都列出同一个原因。
6. 底部：`取消`（ghost）/ `开始翻译`（一个文件）或 `开始翻译 N 个文件`（primary，`isPending` 时转圈；没有文件、有问题文件或模型不可用时禁用）。`Enter` 提交（输入法组字时除外）。

文件校验：加入列表时渲染进程只能检查扩展名，不是 `.pdf` 的显示 `只支持 .pdf 文件` 并阻止提交；沙箱里拿不到文件大小，所以列表不显示大小，代码里的 `文件为空`、`文件超过 500 MB` 两个分支目前不会触发（[M5 E2E worklog](../worklog/2026-09-23-m5-e2e.md)）。读不到、不是文件、超过 500 MB 由主进程在 `documents:create` 时逐个拒绝（`无法读取这个文件。`、`请选择 PDF 文件。`、`文件太大，请选择小于 500 MB 的 PDF。`，其他异常 `无法添加这个文件。`），显示在第 5 项里。去重按路径（不区分文件来源）。

提交：`documents:create` 一次传所有路径。只要有成功的：Toast `已添加 N 个文档`、把筛选切到 `全部文档`（若当前是已完成/失败）、把新文档并入列表并选中第一个。全部成功 → 关闭；部分失败 → 列表只留下失败的文件并显示第 5 项的错误。

## 6.4 文档详情（`views/Document/`）

未选中文档时详情区显示 `选择一篇文档查看详情`。

### 头部

标题（单行截断，`title` 给完整；可双击进入重命名）、`Chip size="sm"` 状态（`排队中`/`处理中`/`等待重试`/`已完成`/`失败`/`已取消`，颜色 default/accent/warning/success/danger/default）、副标题 `<translator.label> · <N 页>（有则显示）· <大小>`。右侧 `ButtonGroup`：

- 完成：`打开`（`variant="secondary"`，`ExternalLink` 图标，默认应用打开中文 PDF）、`导出`（`variant="secondary"` 的 `Button` 直接放在 `Dropdown` 里当触发器，菜单 `中文 PDF…`、`双语对照 PDF…`（有则显示）、`源文件…`、分隔、`全部文件（ZIP）…`）、`更多`（`variant="ghost"` 的文字按钮，不设 `aria-label`，免得和列表行的 `更多` 冲突）菜单：`在访达中显示`/`在文件资源管理器中显示`、`重命名…`、`删除…`。已完成的文档不提供 `重新处理`（05 §5.7：只有失败或已取消的文档可以重新处理）。
- 进行中：`取消处理…`（`variant="danger"`）、`更多`：`在访达中显示`、`重命名…`（进行中不能从详情删除；列表行菜单仍有 `删除…`）。确认框打开期间文档完成或失败（离开排队/处理/等待重试）时，确认框自动关闭，不会去取消一篇已经结束的文档。
- 失败/取消：`重新处理`（primary）、`更多`：`在访达中显示`、`重命名…`、`删除…`。
- 按钮触发的操作（打开、重新处理、在访达中显示等）失败时，用户错误用 Toast 显示原因（`notifyError`），内部错误只有 6.6 的全局 Toast。
- `ButtonGroup` 右边是 `文档信息` 图标按钮（`Button isIconOnly variant="ghost"`，`Info` 图标，`aria-label="文档信息"`），打开 `Drawer`（右侧，宽 360；宽度写在 `Drawer.Dialog` 上，`Drawer.Content` 是铺满窗口的定位层；有 `Drawer.CloseTrigger`），标题 `文档信息`：分组 `文档`（`状态：`、`翻译服务：`、`页数：`、`段落数：已翻译 X / 待翻译 Y，保留原文 K`、`用量 tokens：<输入> / <输出>`，没有数据时显示 `—`）、`源文件`（文件名（可选中，`title` 给完整）、大小、SHA-256 前 16 位 + `Tooltip` 全值，可选中）、`时间`（`加入：`、`开始：`、`完成：`、`用时：`；进行中每秒刷新，完成、失败、取消后停在 `completedAt`，旧记录没有时用 `updatedAt`）；底部按钮 `在访达中显示`（secondary）、`用默认应用打开`（没有中文 PDF 时禁用）。

### 内容区

`Tabs`：`中文 PDF`、`双语对照`（只在双语 PDF 存在时，即 `files.dual`；关闭「同时生成双语对照 PDF」时完成的文档没有这个页签）、`处理记录`。完成时默认 `中文 PDF`；未完成时只有 `处理记录`，并在 `Tabs` 上方显示处理面板。用户选过的页签消失时（例如文档重新进入处理）回到默认页签。每个 `Tabs.Tab` 里各放一个 `Tabs.Indicator`：放在 `Tabs.List` 里与 `Tabs.Tab` 并列会让 React Aria 抛错、整棵树卸载（[M5 E2E worklog](../worklog/2026-09-23-m5-e2e.md)）。

- PDF 页签：`<iframe class="h-full w-full border-0" src={files.mono + '#toolbar=1&navpanes=0'} title="中文 PDF">`（双语页签 `title="双语对照 PDF"`）。加载失败（`onError` 或 5 s 内无 load）显示 `无法在应用内预览，请用默认应用打开。` + 按钮 `用默认应用打开`；失败状态由每个预览按自己的 `src` 记录，一个预览失败不影响另一个，`src` 变化时重新尝试。删除文档前先把 `src` 设为 `about:blank`：所有删除入口（详情、列表菜单、`Delete` 键）都调用 `views/Document/actions.ts` 的 `deleteDocuments()`，它先同步提交「删除中」状态（`useDeletingStore`）让预览换成 `about:blank`，再调用 `documents:delete`（Windows 上 PDF 查看器持有文件句柄会导致删除失败）；删除失败时恢复预览。
- 处理面板（未完成时；两个带边框的面板，是普通 `div` 而不是 HeroUI `Card`，窗口宽度到 Tailwind `md` 断点时并排，否则上下排）：
  - `处理进度`：`ProgressBar value={progress}`（`progress <= 3` 时 `isIndeterminate`），下面一行 `N% · <阶段名> · <最近一条事件的 message> · 已用时 <m:ss>`（最近事件按 `seq` 取最新；已用时从 `startedAt` 起算，还在排队时从加入时起算；失败、取消后停止走动）。失败时 `Alert status="danger"` 标题 `处理失败`（取消：同样 `status="danger"`，标题 `已取消处理`），正文 = `failure.message`，按钮 `重新处理`（`size="sm"`）。等待重试：`Alert status="warning"` 标题 `等待自动重试（第 n 次），<倒计时> 秒后开始`（n = `attempts`，倒计时按 `nextAttemptAt` 每秒刷新）。
  - `处理阶段`：七行，图标 `CheckCircle2`（已完成）/ `Spinner`（进行中）/ `XOctagon`（失败）/ `XCircle` 灰（取消）/ `Circle`（等待）。图标由 manifest 的 `stage` 决定，不按进度区间推算（`views/Document/progress.ts` 的 `stageState`）：主进程在每个阶段**开始**时写入 `{ stage, progress: 该阶段起点 }`（只改 manifest，不记事件），所以 `stage` 就是正在进行的阶段——它之前的阶段已完成，之后的在等待；失败或取消时，`XOctagon`/`XCircle` 标在停下的那个阶段（例如 Key 无效标在「翻译段落」而不是「分析版面」）。名称与说明（`lib/labels.ts` 的 `STAGES`）：

    | 阶段         | 说明                                                                           | 进度区间 |
    | ------------ | ------------------------------------------------------------------------------ | -------- |
    | 接收与排队   | 复制源文件并加入处理队列                                                       | 0–2      |
    | 检查 PDF     | 检查文本层，拒绝扫描件与加密文件                                               | 3–9      |
    | 分析版面     | 识别段落、栏与公式                                                             | 10–29    |
    | 翻译段落     | 显示 `<translator.label>`（`STAGES` 里的「共享任务池并发翻译」在面板上不显示） | 30–79    |
    | 排版译文     | 改写页面内容流，写入译文并重绘公式                                             | 80–89    |
    | 校验结果     | 检查两份 PDF 的页数、尺寸与可读性                                              | 90–93    |
    | 保存到文档库 | 写入译文、PDF 与处理记录                                                       | 94–100   |

- 处理记录页签：头部 `处理记录 · N 条`（N 为筛选后的条数）+ `Switch` `只看警告和错误`；列表最新在上，每行：级别图标（info `Info` 灰 / success `CheckCircle2` 绿 / warning `AlertTriangle` 黄 / error `XCircle` 红）、`message`、`detail`（次要色、可选中）、右侧 `HH:mm:ss`（本地时间，24 小时制）、`+用时`（距首条事件，`m:ss`）、`N%`、`current/total`（有则显示）。空：`没有警告或错误。` / `暂无记录。`。>1000 条时只渲染最近 1000 条并提示 `只显示最近 1000 条`。

### 导出结果

- 成功：`notify.success('已导出“<文件名>”', { actionProps: { children: '打开所在文件夹', onPress }, timeout: 8000 })`。`<文件名>` 是实际保存的文件名（保存对话框返回路径的 basename，不是建议名）；`打开所在文件夹` 调用 `shell:revealExport({ path })`，在访达/资源管理器中选中这份导出的文件（主进程只接受本次会话 `documents:export` 写出过的路径），而不是文档库里的副本。
- 失败：确认框（`ConfirmDialog`）标题 `导出失败`，正文 `“<建议文件名>”没有导出：<原因>`（此时没有实际保存路径，用 `suggestedNames`），按钮 `确定` / `取消`，两个都只是关闭。写入失败（没有权限、磁盘已满、文件被占用）由主进程转成带原因的用户错误，界面只弹这一次；内部错误只有 6.6 的全局 Toast，不再弹这个对话框。
- 用户取消保存对话框：无提示。

## 6.5 设置（`views/Settings/`）

全页视图（顶栏左侧出现 `返回文档库` 按钮），左侧 `Tabs orientation="vertical"`（`Tabs.ListContainer` 宽 180，每个 `Tabs.Tab` 内各放一个 `Tabs.Indicator`，原因同 6.4）：`通用`、`翻译服务`、`网络`、`高级`、`关于`。经 `ui.openSettings()` 打开时（6.1），`llmReady=false` 定位到 `翻译服务`，否则 `通用`；空状态的 `添加大模型服务商…` 直接指定 `翻译服务`。设置项修改后即时保存（`settings:update`），用户错误 Toast `设置未保存：<原因>`（内部错误只有 6.6 的全局 Toast）；例外写在各项里：主题走 `app:setTheme`，服务商走 `providers:save`/`providers:delete`/`secrets:set`，提示词、自定义代理、附加请求参数要按按钮才保存。

### 通用

- `Card` `新建翻译`：`默认翻译模型`（`TranslatorSelect`，同 6.3 分组；无则占位 `尚未添加大模型服务商`）、`同时处理的文档数`（`NumberField` 1–4，带增减按钮，清空输入不保存）。说明：`同时处理更多文档会占用更多 CPU 和内存，翻译请求的并发由各服务商的“并发请求数”控制。`
- `Card` `外观`：`主题` `RadioGroup`：`跟随系统` / `浅色` / `深色`。主题存在 host.json（`app:setTheme`），不随文档库切换；换文档库时 `setAppInfo` 保留当前主题。
- `Card` `文档库`：`位置`（路径，可选中，`title` 给完整）+ `在访达中显示`（Windows `在文件资源管理器中显示`）+ `更改…`（`DOCFLOW_DATA_DIR` 存在时禁用并提示 `由环境变量 DOCFLOW_DATA_DIR 指定`；E2E 设了 `DOCFLOW_E2E_FOLDER_PATH` 时不禁用）；`日志` + `打开日志文件夹`。说明 `文档库保存源文件副本、译文、PDF 和处理记录。`
  - 更改流程：`dialog:pickFolder`（title `选择文档库位置`，message `选择存放文档库的文件夹，DocFlow 会在其中使用“DocFlow”文件夹。`）→ 确认框 `更改文档库位置？`，正文 `DocFlow 会在新位置使用独立的文档库，现有文档保留在原位置，改回原位置即可再次看到。进行中的任务会在下次打开对应文档库时继续。`，按钮 `更改`（primary）/ `取消` → `library:change`，成功后更新位置并重新 `documents:list`。
- `Card` `通知`：`Switch` `翻译完成或失败时发送系统通知`。

### 翻译服务

左右布局：左列（宽 240）头部是小标题 `大模型服务商` 和右侧的 `添加服务商` 文字按钮（`Dropdown.Trigger`，外层 `data-testid="add-provider"`；菜单分组 `国内服务`、`国际服务`、`本机模型`（`Dropdown.Section` + `Header`，每项 `data-testid="preset-<id>"`），最后是 `自定义服务商…`，中间没有分隔线）。下面是服务商 `ListBox`：每行名称 + 状态文字（`已停用` / `需要添加模型` / `需要 API Key` / `N 个模型`，按这个顺序判断；本机服务无需 Key），选中行 `bg-accent-soft`。底栏只有 `−`（`Button isIconOnly variant="ghost"`，`Minus` 图标，`aria-label="删除服务商"`，没有选中时禁用），确认框标题 `删除“<名称>”？`，正文 `服务商的设置和保存在本机的 API Key 会被删除。已经完成的文档不受影响；使用它排队中的文档将无法继续翻译。`，按钮 `删除`（danger）/ `取消`。

选预设后立即保存一个新服务商（启用、没有模型、并发 100、地址用预设的；预设没有地址时用 `http://127.0.0.1:11434/v1`），并选中它。没有任何服务商时右侧显示 `添加一个服务商以开始翻译。`

右侧 `ProviderDetail`（原生 `<form>`，不是 HeroUI `Form`；文本字段失焦即保存）：

- 字段失焦时校验，错误显示在字段下方：`请填写名称`、`名称不能超过 64 个字符`、`请填写以 http:// 或 https:// 开头的完整地址`；保存总是基于已保存的配置，一个字段的无效草稿不会影响其他控件的保存。保存前在渲染进程用 `ProviderConfig.safeParse` 校验，失败 Toast `设置未保存：<原因>`（如 `API 地址无效：…`、`并发请求数需在 1–2000 之间`、`模型 ID 重复或无效`）。
- `Switch` `启用`；`TextField` `名称`；`接口类型`（只读文本：`OpenAI 兼容` / `Anthropic` / `Gemini` / `Azure OpenAI`）；`TextField` `API 地址`（占位 `https://…/v1`），下方 `Description` `请求地址：<chatUrl 预览>`（用 `src/shared/provider-url.ts` 的 `chatUrl` 按正在编辑的地址计算，模型名用第一个模型或 `<模型>`）。
- `Card` `API Key`：状态行 `本机服务，无需 Key`（本机服务优先显示）/ `已保存 ••••••••1a2b（共 N 个）` / `未填写`；`TextField`（`aria-label="API Key"`）内 `Input type="password"`，占位 `粘贴 API Key`（已保存时 `输入新的 Key 以替换`）；按钮 `保存`（primary，空白时禁用，保存后清空输入）、`移除`（ghost，已保存时）、`获取 API Key`（ghost 按钮而不是链接，预设有 keyUrl 时，`shell:openExternal`）。说明 `多个 Key 用英文逗号分隔，请求会轮流使用；某个 Key 失效或余额不足时自动改用其余的。Key 只保存在本机，用系统加密保护。`
- `Card` `模型`：没有用 `Table`，是简单的行列表；每行模型名（没有名称时显示 id）、`检查`（`Button size="sm"`，检查中转圈；外包 `Tooltip` `用这个模型发送一个测试请求`，`Tooltip.Trigger` 设 `role="presentation" tabIndex={-1}` 只响应悬停——它默认渲染可聚焦的 `div role="button"`，包住按钮会成为按钮套按钮，见 [M5 修复 worklog](../worklog/2026-09-23-m5-fixes.md)）、`CloseButton`（`aria-label="删除 <模型 ID>"`），检查结果就地显示在行尾 `可用 · 812 ms · “你好，世界。”` 绿 / 错误原因红。`检查` 用正在编辑的地址（先校验）与未保存的 Key。底部 `手动添加…`（secondary；`Modal` `添加模型`，`size="sm"`，`TextField` `模型 ID`（自动获得焦点），说明 `与服务商文档中的模型名称一致，例如 deepseek-chat。`；错误 `这个模型已在列表中` / `模型 ID 不能超过 256 个字符`；按钮 `取消` / `添加`（空白或有错误时禁用）；每次打开重新挂载，都是空白）、`获取模型列表…`（primary，请求中转圈）。
  - 获取流程：先校验地址，再用当前编辑中的地址与 Key（未保存的 Key 也带上）调 `providers:listModels`；空 → `notify.info` `服务商没有返回任何模型，请手动添加模型 ID。`；否则 `Modal` `<服务商> 的模型`（`size="lg"`；`SearchField`（`aria-label="搜索模型"`）占位 `在 N 个模型中搜索`，按 id、名称、owner 过滤；`ListBox selectionMode="multiple"`，行主文 id、副文 `<name> · <owner> · <N>K`（有则显示，上下文长度除以 1000 取整），已保存且出现在远端列表里的模型预选中；「全选」只加上当前筛选出来的行；底部 `已选择 N 个模型`，`取消` / `确定`）。确定后：远端列表里有的按勾选增删，手动添加（远端没有）的保留，已有的保持原顺序，新勾选的按远端顺序追加；Toast `已添加 N 个、移除 M 个模型。`
  - 保存模型后若还没有默认翻译模型，自动把这个服务商的第一个模型设为默认（`settings:update` 的 `defaultTranslator`）。
- `并发请求数`：`TextField`（不是 `NumberField`，没有步进），失焦时是 1–2000 的整数且有变化才保存，否则恢复为已保存的值。说明 `同时发往这个服务商的请求上限，所有文档共用；默认 100。遇到限流（HTTP 429）会自动减半，恢复后逐步回升。`
- `TextField` `附加请求参数（JSON，可选）`（`TextArea`，等宽字体）+ 下方 `应用` 按钮；非法 JSON、不是对象或含禁用字段（`EXTRA_BODY_FORBIDDEN`）时 `FieldError` `不是有效的 JSON` / `不能覆盖 model、messages 等字段`；清空后按 `应用` 删除附加参数。说明 `合并进每个请求，例如 {"temperature": 0.3}，或关闭思考模式的参数。`
- 自定义服务商 `Modal`（标题 `自定义服务商`，`size="md"`，每次打开重新挂载）：`名称`（占位 `例如 公司网关`）、`接口类型` `Select`（`OpenAI 兼容（最常见）` / `Anthropic` / `Gemini` / `Azure OpenAI`，默认 OpenAI 兼容）、`API 地址`（无占位，失焦校验）。说明 `OpenAI 兼容接口填写到 /v1 为止，程序会在后面加上 /chat/completions。` 按钮 `取消` / `添加`（名称或地址为空时禁用，提交中转圈）；添加成功后关闭并选中新服务商（id 以 `custom` 开头）。

### 网络

`RadioGroup` `代理`：`跟随系统` / `不使用代理` / `自定义`；选前两项立即保存。自定义时 `TextField` `代理地址`（占位 `http://127.0.0.1:7890 或 socks5://127.0.0.1:1080`）+ `应用`。选「自定义」本身不保存任何东西；只有按 `应用` 且地址通过 `ProxyConfig` 校验才保存（地址为空时 `应用` 禁用，无效时字段错误 `请填写完整的代理地址，例如 http://127.0.0.1:7890`）；从自定义切回其他项时保留刚才的地址草稿。说明 `访问大模型服务商时使用的网络代理。“跟随系统”会读取系统设置中的代理。`

### 高级

`Card` `大模型请求`：`每段最多字符`（100–32000，步 100）、`单次请求最多段数`（1–64）、`单次请求最多字符`（500–100000，步 500）、`最大输出 tokens`（0–1000000，步 1024，说明 `0 = 使用服务商默认值`）、`单个文档最多同时发出的请求数`（1–1000）。都是 `NumberField`，清空输入不保存。
`Card` `翻译提示词`：`TextArea` 8 行（等宽字体，`aria-label="翻译提示词"`），下方一行 `N / 12000。公式、代码、链接和排版标记由程序在本地保护，提示词无需说明这些规则。新任务使用新参数，进行中的任务保持提交时的设置。`（计数与说明在同一个 `Description` 里）；按钮 `恢复默认`（secondary，只把默认提示词填进输入框，仍要按 `保存`）/ `保存`。
`Card` `PDF 写回`：`译文最小缩放`（`Slider` 40%–100%，步 1%，默认 60%，旁边显示 `N%`；拖动时只改本地值，松手才保存，避免每一步都发 IPC；说明 `译文装不下时允许把字号缩小到原字号的这个比例`）、`Switch` `同时生成双语对照 PDF`。

### 关于

标题 `DocFlow`，下面 `版本 <version> · <platform> · <arch>`（平台是 `darwin`/`win32` 原值）；`检查更新`（请求中转圈；结果：`已是最新版本` / `有新版本 4.1.0` + `前往下载`（secondary 按钮，`shell:openExternal`）/ 主进程返回的错误文字，如 `无法检查更新，请稍后重试。`）；`Switch` `启动时自动检查更新`；`Link` `源代码`（不带 `href`，`onPress` 调 `shell:openExternal` 打开 `https://github.com/Uniseem/docflow`，避免窗口导航后再打开一次）、`第三方许可`（ghost 按钮，`shell:openNotices` 打开 `THIRD_PARTY_NOTICES.md`，07 章生成）、`打开日志文件夹`（ghost 按钮）。

## 6.6 Toast 与全局

- `Toast.Provider` 在 `App` 根部与界面并列单独渲染 `<Toast.Provider placement="bottom end" />`（右下），不能把界面包在里面：HeroUI 3 的 `Toast.Provider` 是 toast 区域，`children` 是每条 toast 的渲染模板，没有 toast 时什么都不渲染，包住界面会让窗口整片空白（[M5 E2E worklog](../worklog/2026-09-23-m5-e2e.md)）。HeroUI 的 `toast` 默认 4 s，所以渲染进程统一用 `lib/notify.ts`：`notify.success/info/warning/danger` 默认 6000 ms（个别场景如导出成功显式传 8000），`notifyError(error, prefix?)` 只提示用户错误（内部错误已由下一条的全局 Toast 提示，避免弹两次）。
- 全局错误：主进程返回 `ok:false` 时 preload 以普通对象 `IpcFailure { code, message, user }` reject（contextBridge 复制 `Error` 会丢掉 `code`/`user`），`api/errors.ts` 的 `toDocflowError` 还原成 Error；`api/invoke.ts` 遇到 `user:false` 时 Toast `发生内部错误，详情见日志`，带 `打开日志` 动作（`shell:openLogs`）。
- 渲染错误：`main.tsx` 的根错误边界显示 `界面出现错误，请重新加载。`、错误信息（可选中）与 `重新加载` 按钮（`location.reload()`），不再整窗变白。
- 主进程不可用（极少见，如 preload 失败，`window.docflow` 不存在）：全屏 `处理引擎未运行` + `重新启动`。按钮在 `window.docflow` 存在时调 `app:relaunch`，否则重新加载页面；由于只有 `window.docflow` 缺失时才会出现这个画面，实际执行的是重新加载。

## 6.7 状态管理（zustand）

- `documents` store（`store/documents.ts`）：`items: Map<id, DocumentSummary>`、`counts`、`filter`、`query`、`selectedId`、`events: Map<id, ProcessingEvent[]>`（按 `seq` 升序、去重，内存里最多 `MAX_EVENTS` 5000 条），另有 `eventCursors`、`eventsLoaded`。订阅 `document:changed/removed/event` 与 `library:changed`（换库时丢掉旧库的选中、处理记录与未完成的加载，重新 `list()` 并重载设置）。`list()` 在 filter 变化时立即、query 变化时 250 ms 防抖后拉取，只采用最新一次的响应；选中项不在结果里时自动选中第一项；没有选中时，推送来的可见文档会被选中。推送的文档不符合当前筛选或搜索时从列表移除；筛选为 `全部文档` 时本地重算计数，其他筛选下除了同一分组内的进度更新，都节流（400 ms）重新 `list()` 以校正计数与成员。顺序由 `sortDocuments()`（`createdAt`、`id` 降序）决定，列表与方向键共用。`ensureEvents(id)`：选中变化（点击、方向键、`list()`、删除、换库）与文档详情挂载时调用，每篇文档加载一次处理记录（最新 500 条），与推送事件按 `seq` 合并（请求期间到达的推送不会被覆盖）。
- `settings` store（`store/settings.ts`）：`view: SettingsView | null`、`selectedProviderId`，`load()`、`apply(view)`、`update(patch)`（不抛错，失败时提示 `设置未保存：<原因>` 并返回 false）、`selectProvider(id)`，订阅 `settings:changed`。
- `ui` store（`store/ui.ts`）：`view`、`theme`、`settingsTab`、`appInfo`、`newTranslationOpen` 与 `newTranslationPaths`（新建翻译开关与预填路径）、`confirm`（全局确认框，`clearConfirm` 只清自己）、`rename`、`searchFocused`（`⌘/Ctrl+F` 计数）、`narrow`（窗口 < 1100 px）、`infoOpen`、`engineReady`；`openSettings(tab?)`、`setTheme()`（调 `app:setTheme`）、`setAppInfo()`（只有第一次采用 `appInfo.theme`）。Toast 不在 store 里，统一走 `lib/notify.ts`。
- 另有 `views/Document/actions.ts` 的 `useDeletingStore`（正在删除的文档 id，用来卸载预览）。
- zustand 5 的 selector 不能每次返回新引用（`?? []`、`.filter()`），否则无限重渲染；空数组用模块级常量（[M5 E2E worklog](../worklog/2026-09-23-m5-e2e.md)）。

## 6.8 可访问性与细节

- 所有图标按钮有 `aria-label`；对话框首焦点在主要输入或取消按钮；列表可用键盘导航。
- 文案里的引号统一用 `“”`；数字与中文之间加一个空格（`3 页`、`5 分钟前`、`已添加 2 个文档`，与 3.x 文案一致），日期 `M月D日`、`YYYY年M月D日` 除外；时间显示本地时区。
- 大小格式：`< 1 MB` 用 KB（整数，不足 1 KB 显示 `1 KB`，0 字节显示 `0 KB`），否则 MB（一位小数），`≥ 1 GB` 用 GB（两位小数）。
- 长路径用 `直接显示 + title`，不做中间省略。
