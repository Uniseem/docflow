# 05 IPC 与数据

## 5.1 文档库目录

```
<library>/                         默认：macOS ~/Library/Application Support/DocFlow
│                                        Windows %LOCALAPPDATA%\DocFlow
├─ settings.json                   非敏感设置（5.3）
├─ secrets.bin                     safeStorage 加密的 API Key 映射（4.7）
├─ logs/main.log  main.old.log
├─ documents/
│  └─ <id>/                        id = 时间戳前缀 + 随机：`20260921T160000-8f3a2c`（可排序、可读）
│     ├─ manifest.json             文档记录（5.4）
│     ├─ source.pdf                源文件副本
│     ├─ events.jsonl              处理记录，追加写（5.5）
│     ├─ output/
│     │  ├─ mono.pdf               中文 PDF
│     │  └─ dual.pdf               双语对照
│     └─ work/                     可再生中间产物；成功后删除
│        ├─ inspection.json  analysis.json  translation.json
│        ├─ translation-cache.json
│        └─ mono.pdf  dual.pdf     写回产物，verify 通过后 rename 到 output/
└─ .lock                           单实例锁（主进程 `fs.open` 独占 + 写 pid；异常退出后启动时若 pid 不存在则清除）
```

`host.json` 放在 `app.getPath('userData')`（**不在**文档库内，因为它记录文档库在哪）：`{ libraryDir?: string, window?: { width, height, x, y, maximized }, theme?: 'system'|'light'|'dark' }`。优先级：`DOCFLOW_DATA_DIR` 环境变量 > `host.json.libraryDir` > 默认。

原子写：`settings/atomic-write.ts` 的 `writeJsonAtomic(path, value)`：写 `path + '.' + random + '.tmp'` → `fsync` → `rename`；Windows 上 rename 目标存在会失败，先尝试 `rename`，`EPERM/EEXIST` 时 `unlink` 目标再 `rename`（最多 3 次，间隔 50 ms）。

## 5.2 更改文档库位置

设置 → 通用 → 文档库 → 更改…：选文件夹 → 若所选目录名不是 `DocFlow` 则追加 `/DocFlow` → 确认对话框（文案见 06 章）→ **先在新对象里打开新库**：建目录、试写一个临时文件、`settings.load()`、`secrets.load()`、`library.open(newDir)`；任何一步失败都抛用户错误 `无法使用这个文件夹作为文档库：<原因>。请选择其他位置。`（没有权限 / 只读 / 磁盘空间不足 / 文件夹不存在或所在的磁盘已断开），**旧库照常运行，host.json 不变** → 全部成功后才停止旧调度器（等待当前阶段最多 5 s 后 terminate；进行中的文档保持 `processing`，下次打开那个库时续跑，见 5.7）→ 切换到新库、作废全部翻译池（4.8）、按新库设置应用代理 → 写 `host.json.libraryDir` → 通知渲染进程 `library:changed` 重新拉取一切。**不迁移数据**（与 3.x 一致：旧库留在原处）。

启动时 host.json 指向的库打不开（外接盘拔掉、没有权限、文件损坏）→ 回落到默认文档库，窗口出现后弹一次原生提示（原因、原位置、本次使用的默认位置，「可以在 设置 → 通用 → 文档库 中重新选择」）；host.json 不改，下次启动仍先试原位置。默认库也打不开 → 错误框「DocFlow 无法启动」后退出。`secrets.bin` 解不开（换了电脑或系统钥匙串）→ 备份为 `secrets.bin.broken-<时间>`、按没有 Key 处理并写日志，不阻止打开文档库。

## 5.3 `settings.json`

```ts
export const Settings = z
  .object({
    version: z.literal(1),
    providers: z.array(ProviderConfig).max(64),
    defaultTranslator: TranslatorChoice.nullable(),
    workerConcurrency: z.number().int().min(1).max(4).default(2), // 同时处理的文档数
    translation: TranslationRuntime, // 04 章
    proxy: z.discriminatedUnion('mode', [
      z.object({ mode: z.literal('system') }),
      z.object({ mode: z.literal('direct') }),
      z.object({
        mode: z.literal('custom'),
        // 协议由 z.url() 检查（不会抛错），并要求写出 `://`：`127.0.0.1:7890` 不通过
        url: z
          .url({ protocol: /^(https?|socks5h?)$/ })
          .refine((u) => /^[a-z][a-z0-9+.-]*:\/\//i.test(u)),
      }),
    ]),
    pdf: z.object({
      minFontScale: z.number().min(0.4).max(1).default(0.6),
      bilingual: z.boolean().default(true), // 关掉则不生成 dual.pdf
    }),
    notifications: z.boolean().default(true),
    checkUpdates: z.boolean().default(true),
  })
  .strict()
```

- 读取：文件不存在 → 默认值；解析失败 → 备份为 `settings.json.broken-<时间>` 并用默认值，事件日志 warning。
- 未知字段：zod `.strict()` 拒绝 → 视为损坏（同上）。升级版本时用 `version` 做迁移函数链。
- 写入：`settings.update(patch)` 深合并后整体校验再原子写；广播 `settings:changed`。
- `defaultTranslator` 指向的服务商/模型被删除时置 `null`。
- 代理（02 §2.5 第 7 步）：打开文档库时和 `proxy` 变化时 `session.defaultSession.setProxy()`，随后 `closeAllConnections()` 让已建立的连接改走新路由。`system` → `{ mode: 'system' }`；`direct` → `{ mode: 'direct' }`；`custom` → `{ mode: 'fixed_servers', proxyRules: 'scheme://host:port' }`（去掉路径与凭据，`socks5h` 写成 `socks5`：Chromium 的 SOCKS5 本来就在代理端解析域名）。回环地址不走代理（Chromium 默认），本地 mock 服务不受影响。

## 5.4 `manifest.json`（文档记录）

```ts
export const DocumentStatus = z.enum([
  'queued',
  'processing',
  'retrying',
  'completed',
  'failed',
  'cancelled',
])
export const Stage = z.enum([
  'received',
  'inspect',
  'analyze',
  'translate',
  'compose',
  'verify',
  'archive',
  'done',
])

export const DocumentManifest = z
  .object({
    version: z.literal(1),
    id: z.string(),
    title: z.string().min(1).max(300),
    titleCustom: z.boolean(), // 用户改过标题就不再被元数据标题覆盖
    originalFilename: z.string(),
    sourceSize: z.number().int(),
    sourceSha256: z.string().length(64),
    pages: z.number().int().nullable(),
    translator: z.object({ providerId: z.string(), model: z.string(), label: z.string() }),
    settingsSnapshot: TranslationRuntime, // 入队时快照；自动重试沿用，手动重试重新快照
    status: DocumentStatus,
    stage: Stage,
    progress: z.number().min(0).max(100),
    failure: z.object({ code: z.string(), message: z.string(), permanent: z.boolean() }).nullable(),
    attempts: z.number().int(), // 自动重试计数
    nextAttemptAt: z.string().datetime().nullable(),
    stats: z
      .object({
        paragraphs: z.number(),
        translatable: z.number(),
        translated: z.number(),
        kept: z.number(),
        formulaRuns: z.number(),
        opsRemoved: z.number(),
        usage: z.object({ input: z.number(), output: z.number() }),
      })
      .nullable(),
    outputs: z.object({
      mono: z.object({ bytes: z.number() }).nullable(),
      dual: z.object({ bytes: z.number() }).nullable(),
    }),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    startedAt: z.string().datetime().nullable(),
    completedAt: z.string().datetime().nullable(),
  })
  .strict()
```

渲染进程看到的是 `DocumentSummary`（manifest 去掉 `settingsSnapshot`，加 `files: { source, mono, dual }`（`docflow://` URL，仅存在时给）、`suggestedNames: { mono, dual, bundle, source }`、`running: boolean`）。

`suggestedNames`：`stem = sanitize(title)`（去掉 `\/:*?"<>|` 与控制字符换 `_`，去首尾空白与点，空则 `文档`，最长 120 字符）→ `${stem}-中文译文.pdf`、`${stem}-双语对照.pdf`、`${stem}-完整文件.zip`、源文件用 `originalFilename`。

内存索引（`library/index.ts`）：`Map<id, DocumentManifest>`；`list({filter, query})` 在内存里过滤（`query` 对 `title` 与 `originalFilename` 做不区分大小写的包含匹配，多个空格分隔的词全部匹配），按 `createdAt` 降序；`counts` 同时返回四个分组数。

## 5.5 `events.jsonl`

一行一个 JSON：

```ts
export const ProcessingEvent = z.object({
  seq: z.number().int(), // 文档内递增
  at: z.string().datetime(), // UTC，毫秒
  stage: Stage,
  level: z.enum(['info', 'success', 'warning', 'error']),
  progress: z.number().min(0).max(100).optional(),
  message: z.string(), // 给用户看的中文
  detail: z.string().optional(), // 次要信息（错误的技术原因、计数）
  current: z.number().optional(),
  total: z.number().optional(),
})
```

- 追加写用 `fs.appendFile`（同一文档的写入串行化）。
- 上限 `MAX_EVENTS (5000)`：超过时把文件重写为最近 4000 条（保留首条「加入队列」）。
- 读取 `documents:events({ id, afterSeq, limit })` 返回 `afterSeq` 之后的最多 `limit (500)` 条；渲染进程首次取最近 500 条，之后靠推送增量。
- 每条 progress 类事件同时更新 manifest 的 `stage/progress`（只在 `status === 'processing'` 时；防止取消后被复活）。
- 每个阶段**开始**时也写一次 `{ stage, progress: 起点 }`（只改 manifest、不记事件）：列表与失败图标指向正在运行的阶段，而不是上一个完成的阶段。manifest 的更新按文档串行执行，每次在上一次写入的结果上合并；带条件的更新（`updateWhen`）在轮到它时才判断条件，基于过期状态做的决定不会覆盖更新的状态。

事件文案（stage → message，`detail` 视情况）：

| stage     | message                                                                                                                                                                                                                                              |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| received  | `已复制源文件并加入处理队列`（detail：大小、SHA-256 前 16 位）                                                                                                                                                                                       |
| inspect   | `检查 PDF：N 页`／失败信息                                                                                                                                                                                                                           |
| analyze   | `分析版面：识别到 N 个段落，其中 M 个待翻译，公式 K 处`；warning：`第 P 页没有识别到可翻译段落`                                                                                                                                                      |
| translate | `开始翻译：<translator>，共 N 段`；进度 `已翻译 X / N 段`；warning：重试与保留原文（04 章）；`翻译完成：N 段，保留原文 K 段，用量 输入 A / 输出 B tokens`                                                                                            |
| compose   | `改写内容流：写入 N 段译文，重绘公式 K 处，删除文字指令 M 条`；warning：`第 P 页第 Q 段译文超出原段落范围`、`第 P 页第 Q 段排版失败，已保留原文`、`第 P 页有 N 条文字指令无法对应到段落，已跳过该页`、`第 P 页第 Q 段的公式字体无法映射，已保留原文` |
| verify    | `校验通过：中文 PDF N 页，双语 PDF 2N 页`                                                                                                                                                                                                            |
| archive   | `已保存到文档库`                                                                                                                                                                                                                                     |
| 任意      | error：`处理失败：<message>`；`已取消处理`；`等待自动重试（第 n 次）`                                                                                                                                                                                |

## 5.6 IPC 契约（`src/shared/ipc.ts`）

设计：一个 `channels` 对象，每个通道一个 `{ request: zodSchema, response: zodSchema }`；`preload` 用它生成 `window.docflow.invoke(channel, payload)`，并把常用通道包装成方法；主进程 `ipc/register.ts` 遍历表注册 `ipcMain.handle`，统一 `request.parse()`、调用 handler、`response.parse()`（开发模式）与错误转换（`UserError` → `{ ok:false, error:{ code, message, user:true } }`；其他 → `user:false`、message `发生内部错误，详情见日志`，并写日志含堆栈）。返回统一信封 `{ ok: true, data } | { ok: false, error }`。

调用型通道（renderer → main）：

| 通道                     | 请求                                                                            | 响应                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `app:info`               | —                                                                               | `{ version, platform: 'darwin' \| 'win32', libraryDir, logsDir, arch, theme, dataDirFromEnv }`                                                                                                                                                                                                                                                                                                         |
| `app:setTheme`           | `{ theme }`                                                                     | `{}`（同步 `nativeTheme.themeSource` 并写 host.json）                                                                                                                                                                                                                                                                                                                                                  |
| `app:checkUpdates`       | —                                                                               | `{ latest: string, url: string, newer: boolean } \| { error }`（GitHub API `repos/Uniseem/docflow/releases/latest`，10 s 超时）                                                                                                                                                                                                                                                                        |
| `app:relaunch`           | —                                                                               | `{}`（`app.relaunch()` + `app.quit()`；preload 失败时「重新启动」）                                                                                                                                                                                                                                                                                                                                    |
| `app:takePendingFiles`   | —                                                                               | `{ paths: string[] }`：取走启动参数、macOS `open-file`、第二实例带来但渲染进程订阅前到达的 PDF。渲染进程订阅 `app:openFiles` 后调用一次；此后主进程直接推送 `app:openFiles`，页面重新加载或窗口关闭后重新排队                                                                                                                                                                                          |
| `settings:get`           | —                                                                               | `SettingsView`（= Settings 去掉 secrets + `providers[].keyConfigured/keyMasked/keyOptional/keyUrl` + `presets` + `limits` + `capabilities: { llmReady, fakeProviders }`）                                                                                                                                                                                                                              |
| `settings:update`        | `Partial<Settings>`（zod `.partial()` 深合并）                                  | `SettingsView`                                                                                                                                                                                                                                                                                                                                                                                         |
| `secrets:set`            | `{ providerId, value: string \| null }`                                         | `SettingsView`（之后作废该服务商的翻译池，4.8）                                                                                                                                                                                                                                                                                                                                                        |
| `providers:save`         | `{ provider: ProviderConfig }`                                                  | `SettingsView`（同上）                                                                                                                                                                                                                                                                                                                                                                                 |
| `providers:delete`       | `{ id }`                                                                        | `SettingsView`（同上）                                                                                                                                                                                                                                                                                                                                                                                 |
| `providers:listModels`   | `{ providerId?, type, baseUrl, key?: string }`（key 为 undefined 时用已保存的） | `{ models: ModelInfo[] }`                                                                                                                                                                                                                                                                                                                                                                              |
| `providers:check`        | 同上 + `model`                                                                  | `{ ok: true, latencyMs, reply } \| { ok: false, message }`                                                                                                                                                                                                                                                                                                                                             |
| `documents:create`       | `{ paths: string[], title?: string, translator: TranslatorChoice }`             | `{ created: DocumentSummary[], failed: { path, message }[] }`                                                                                                                                                                                                                                                                                                                                          |
| `documents:list`         | `{ filter: 'all' \| 'active' \| 'completed' \| 'failed', query?: string }`      | `{ items: DocumentSummary[], counts: { all, active, completed, failed } }`                                                                                                                                                                                                                                                                                                                             |
| `documents:get`          | `{ id }`                                                                        | `DocumentSummary`                                                                                                                                                                                                                                                                                                                                                                                      |
| `documents:events`       | `{ id, afterSeq?: number, limit?: number }`                                     | `{ items: ProcessingEvent[], lastSeq }`                                                                                                                                                                                                                                                                                                                                                                |
| `documents:rename`       | `{ id, title }`                                                                 | `DocumentSummary`                                                                                                                                                                                                                                                                                                                                                                                      |
| `documents:retry`        | `{ id }`                                                                        | `DocumentSummary`                                                                                                                                                                                                                                                                                                                                                                                      |
| `documents:cancel`       | `{ id }`                                                                        | `DocumentSummary`（只对 queued/processing/retrying 生效，见 5.7）                                                                                                                                                                                                                                                                                                                                      |
| `documents:delete`       | `{ ids: string[] }`                                                             | `{ deleted: string[] }`                                                                                                                                                                                                                                                                                                                                                                                |
| `documents:export`       | `{ id, kind: 'mono' \| 'dual' \| 'source' \| 'bundle' }`                        | `{ cancelled: true } \| { path }`（主进程弹保存对话框，默认名 `suggestedNames[kind]`；bundle 用 fflate 打 ZIP：`source/`、`output/`、`manifest.json`、`events.jsonl`、`README.txt`。文件不在文档库里 → `not_found`；写入失败 → 用户错误，只含原因与下一步：`没有写入权限，请换一个位置。`、`磁盘空间不足，请清理后重试。`、`文件被其他程序占用，请关闭后重试或换一个位置。` 等，界面在前面加上文件名） |
| `documents:reveal`       | `{ id, kind?: 'mono' \| 'dual' \| 'source' \| 'folder' }`                       | `{}`（`shell.showItemInFolder`；文件不存在 → `not_found`，说明缺什么）                                                                                                                                                                                                                                                                                                                                 |
| `documents:openExternal` | `{ id, kind: 'mono' \| 'dual' \| 'source' }`                                    | `{}`（`shell.openPath`；文件不存在 → `not_found`，例如「这篇文档没有双语对照 PDF…」；打开失败 → `无法打开文件：<原因>`）                                                                                                                                                                                                                                                                               |
| `dialog:pickPdfs`        | —                                                                               | `{ paths: string[] }`（过滤 `.pdf`，多选）                                                                                                                                                                                                                                                                                                                                                             |
| `dialog:pickFolder`      | `{ title, message }`                                                            | `{ path } \| { cancelled: true }`                                                                                                                                                                                                                                                                                                                                                                      |
| `library:change`         | `{ path }`                                                                      | `{ libraryDir }`（5.2；新库打不开时抛用户错误，旧库继续运行）                                                                                                                                                                                                                                                                                                                                          |
| `shell:openExternal`     | `{ url }`                                                                       | `{}`（仅 https/mailto）                                                                                                                                                                                                                                                                                                                                                                                |
| `shell:revealExport`     | `{ path }`                                                                      | `{}`（在访达/资源管理器中显示导出的文件。只接受本次运行中 `documents:export` 写出过的路径，其他路径一律 `not_found`；文件已被移动或删除 → `not_found`）                                                                                                                                                                                                                                                |
| `shell:openLogs`         | —                                                                               | `{}`                                                                                                                                                                                                                                                                                                                                                                                                   |
| `shell:openNotices`      | —                                                                               | `{}`（打开 `THIRD_PARTY_NOTICES.md`）                                                                                                                                                                                                                                                                                                                                                                  |

推送型通道（main → renderer，`webContents.send`，preload 暴露 `on(channel, cb) → unsubscribe`）：

| 通道               | 载荷                                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `document:changed` | `DocumentSummary`（状态、进度、阶段任一变化；节流 200 ms/文档）                                                           |
| `document:removed` | `{ id }`                                                                                                                  |
| `document:event`   | `ProcessingEvent & { documentId }`                                                                                        |
| `settings:changed` | `SettingsView`                                                                                                            |
| `library:changed`  | `{ libraryDir }`                                                                                                          |
| `app:openFiles`    | `{ paths: string[] }`（macOS open-file / 第二实例命令行 / Dock 拖入；渲染进程取走 `app:takePendingFiles` 之后才直接推送） |
| `app:command`      | `{ name: 'new-translation' \| 'settings' \| 'focus-search' }`（菜单）                                                     |

preload 里所有 `on` 回调都用 `ipcRenderer.on` 包装并 `structuredClone` 载荷；不暴露 `ipcRenderer` 本身。`window.docflow` 类型 `DocflowApi` 由 `channels` 表推导：`invoke<K extends keyof Channels>(k: K, req: z.input<Channels[K]['request']>): Promise<z.output<Channels[K]['response']>>`。

失败时 `invoke` 以普通对象 `IpcFailure = { code, message, user }` reject，而不是 `Error`：contextBridge 复制 `Error` 时只保留 `message`，`code`/`user` 会丢，渲染进程就分不清用户错误和内部错误（M5 实测）。`renderer/api/invoke.ts` 用 `toDocflowError` 把它还原成带 `code`、`user` 的 `Error`；界面代码只通过这个封装调用。

## 5.7 任务调度（`jobs/scheduler.ts`）

- 状态：`queued → processing → completed | failed | cancelled`；失败且可重试 → `retrying`（`nextAttemptAt = now + 20 × attempts s`，最多 `MAX_ATTEMPTS (3)`）→ 到时回 `queued`。
- 并发：最多 `settings.workerConcurrency` 个 `processing`；调度器每 1 s 与每次状态变化时检查队列（按 `nextAttemptAt ?? createdAt` 升序）。
- 每个任务一个 `AbortController`，abort 带原因区分两种中断：
  - **用户取消**（`documents:cancel`）：只对 `queued/processing/retrying` 生效，其他状态原样返回、不写事件。先 abort，再按条件写 `cancelled`、`failure`、`completedAt` 与**一条**事件 `已取消处理`（两次取消只记一次）；随后最多等任务函数返回 `STOP_GRACE_MS`（5 s），worker 被 terminate，`work/` 保留（缓存复用）。进入 `archive` 阶段（输出正在替换 `work/`）后不再接受取消，文档照常完成。
  - **关停**（`scheduler.stop()`：退出应用、更改文档库）：中断进行中的文档但**不算取消**，状态保持 `processing`，下次打开这个文档库时由启动恢复续跑。退出应用时 `before-quit` 先等 `stop()`（最多 5 s）再真正退出。
  - 被中断的任务自己不再写状态，不会覆盖取消或更新的状态；流水线在中断后才返回时（已归档）照常记为完成。
- 重试等待（04 §4.11）与并发池排队都随 abort 立即结束，取消与删除不会被退避等待卡住。
- 失败：用户错误与服务商错误按原文（服务商错误见 04 §4.5 的文案表）；其他意外错误写日志（含堆栈），界面显示 `处理时发生内部错误，详情见日志。`（磁盘写满时 `磁盘空间不足，请清理磁盘后重新处理。`），原始错误文字放进事件 `detail`。
- `documents:retry`：仅 `failed/cancelled` 可用；`attempts = 0`、`failure = null`、`startedAt = completedAt = null`（「已用时」从新的一次算起）、重新快照 `settingsSnapshot`、状态 `queued`。
- `documents:delete`：进行中先中断（不写 `cancelled`）并等待任务函数返回（最多 5 s），再从索引移除并 `rm -rf documents/<id>`（`maxRetries: 5`，Windows 上 PDF 查看器或杀毒软件短暂占用文件时重试）；删除后仍在收尾的任务写 manifest 会得到 `not_found`，不会让文档「复活」。预览 iframe 需先卸载：渲染进程在发起删除前把预览 `src` 置空。
- 启动恢复：`processing/retrying` → `queued`（事件 `应用重新启动，从断点继续`），`work/` 保留即断点。
- 单文档流程 `pipeline/run.ts`：

```
received(0–2)  → 复制源文件（已在 create 时完成，此处只写事件）
inspect(3–9)   → worker.inspect → work/inspection.json；标题：!titleCustom && inspection.title 存在时更新标题
analyze(10–29) → worker.analyze → work/analysis.json；stats 写 manifest；translatable=0 → no_paragraphs
translate(30–79) → translateDocument(...) → work/translation.json；kept/usage 写 manifest
compose(80–89) → worker.compose → work/mono.pdf, work/dual.pdf（bilingual=false 时不生成）；warnings 写事件
verify(90–93)  → worker.verify
archive(94–100)→ rename 到 output/、outputs 写 manifest、删除 work/、status completed、completedAt；通知
```

每个阶段开始时若 `work/<stage>.json` 已存在且其 `sourceSha256`/`fingerprint` 匹配则跳过（断点续传：inspect/analyze 产物按 `sourceSha256`，translation 按 04 章指纹并且 `results.length === translatable`）。

## 5.8 通知

任务完成/失败且主窗口不在前台时，`new Notification({ title: '翻译完成' | '处理失败', body: title })`，点击后前置窗口并选中该文档。`settings.notifications=false` 时不发。macOS Dock 徽标 = 进行中文档数（`app.dock.setBadge`），Windows 任务栏用 `win.setProgressBar(总体进度)`，无进行中时清除。
