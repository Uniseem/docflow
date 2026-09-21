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
│        ├─ raster/<pid>#<n>.png
│        └─ mono.pdf  dual.pdf     写回产物，verify 通过后 rename 到 output/
└─ .lock                           单实例锁（主进程 `fs.open` 独占 + 写 pid；异常退出后启动时若 pid 不存在则清除）
```

`host.json` 放在 `app.getPath('userData')`（**不在**文档库内，因为它记录文档库在哪）：`{ libraryDir?: string, window?: { width, height, x, y, maximized }, theme?: 'system'|'light'|'dark' }`。优先级：`DOCFLOW_DATA_DIR` 环境变量 > `host.json.libraryDir` > 默认。

原子写：`settings/atomic-write.ts` 的 `writeJsonAtomic(path, value)`：写 `path + '.' + random + '.tmp'` → `fsync` → `rename`；Windows 上 rename 目标存在会失败，先尝试 `rename`，`EPERM/EEXIST` 时 `unlink` 目标再 `rename`（最多 3 次，间隔 50 ms）。

## 5.2 更改文档库位置

设置 → 通用 → 文档库 → 更改…：选文件夹 → 若所选目录名不是 `DocFlow` 则追加 `/DocFlow` → 确认对话框（文案见 06 章）→ 写 `host.json.libraryDir` → 停止调度器（等待当前阶段最多 5 s 后 terminate）→ 关闭栅格窗口 → 重新 `library.open(newDir)`、`settings.load()`、`secrets.load()` → 通知渲染进程 `library:changed` 重新拉取一切。**不迁移数据**（与 3.x 一致：旧库留在原处）。

## 5.3 `settings.json`

```ts
export const Settings = z.object({
  version: z.literal(1),
  providers: z.array(ProviderConfig).max(64),
  defaultTranslator: TranslatorChoice.nullable(),
  workerConcurrency: z.number().int().min(1).max(4).default(2),      // 同时处理的文档数
  translation: TranslationRuntime,                                     // 04 章
  proxy: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('system') }),
    z.object({ mode: z.literal('direct') }),
    z.object({ mode: z.literal('custom'), url: z.string().url().refine(u => /^(https?|socks5h?):$/.test(new URL(u).protocol)) }),
  ]),
  pdf: z.object({
    rasterScale: z.number().int().min(2).max(8).default(4),
    minFontScale: z.number().min(0.4).max(1).default(0.6),
    bilingual: z.boolean().default(true),                              // 关掉则不生成 dual.pdf
  }),
  notifications: z.boolean().default(true),
  checkUpdates: z.boolean().default(true),
}).strict()
```

- 读取：文件不存在 → 默认值；解析失败 → 备份为 `settings.json.broken-<时间>` 并用默认值，事件日志 warning。
- 未知字段：zod `.strict()` 拒绝 → 视为损坏（同上）。升级版本时用 `version` 做迁移函数链。
- 写入：`settings.update(patch)` 深合并后整体校验再原子写；广播 `settings:changed`。
- `defaultTranslator` 指向的服务商/模型被删除时置 `null`。

## 5.4 `manifest.json`（文档记录）

```ts
export const DocumentStatus = z.enum(['queued', 'processing', 'retrying', 'completed', 'failed', 'cancelled'])
export const Stage = z.enum(['received', 'inspect', 'analyze', 'translate', 'compose', 'verify', 'archive', 'done'])

export const DocumentManifest = z.object({
  version: z.literal(1),
  id: z.string(),
  title: z.string().min(1).max(300),
  titleCustom: z.boolean(),                      // 用户改过标题就不再被元数据标题覆盖
  originalFilename: z.string(),
  sourceSize: z.number().int(),
  sourceSha256: z.string().length(64),
  pages: z.number().int().nullable(),
  translator: z.object({ providerId: z.string(), model: z.string(), label: z.string() }),
  settingsSnapshot: TranslationRuntime,          // 入队时快照；自动重试沿用，手动重试重新快照
  status: DocumentStatus,
  stage: Stage,
  progress: z.number().min(0).max(100),
  failure: z.object({ code: z.string(), message: z.string(), permanent: z.boolean() }).nullable(),
  attempts: z.number().int(),                    // 自动重试计数
  nextAttemptAt: z.string().datetime().nullable(),
  stats: z.object({ paragraphs: z.number(), translatable: z.number(), translated: z.number(), kept: z.number(), placeholders: z.number(), usage: z.object({ input: z.number(), output: z.number() }) }).nullable(),
  outputs: z.object({ mono: z.object({ bytes: z.number() }).nullable(), dual: z.object({ bytes: z.number() }).nullable() }),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(), completedAt: z.string().datetime().nullable(),
}).strict()
```

渲染进程看到的是 `DocumentSummary`（manifest 去掉 `settingsSnapshot`，加 `files: { source, mono, dual }`（`docflow://` URL，仅存在时给）、`suggestedNames: { mono, dual, bundle, source }`、`running: boolean`）。

`suggestedNames`：`stem = sanitize(title)`（去掉 `\/:*?"<>|` 与控制字符换 `_`，去首尾空白与点，空则 `文档`，最长 120 字符）→ `${stem}-中文译文.pdf`、`${stem}-双语对照.pdf`、`${stem}-完整文件.zip`、源文件用 `originalFilename`。

内存索引（`library/index.ts`）：`Map<id, DocumentManifest>`；`list({filter, query})` 在内存里过滤（`query` 对 `title` 与 `originalFilename` 做不区分大小写的包含匹配，多个空格分隔的词全部匹配），按 `createdAt` 降序；`counts` 同时返回四个分组数。

## 5.5 `events.jsonl`

一行一个 JSON：

```ts
export const ProcessingEvent = z.object({
  seq: z.number().int(),                 // 文档内递增
  at: z.string().datetime(),             // UTC，毫秒
  stage: Stage,
  level: z.enum(['info', 'success', 'warning', 'error']),
  progress: z.number().min(0).max(100).optional(),
  message: z.string(),                   // 给用户看的中文
  detail: z.string().optional(),         // 次要信息（错误的技术原因、计数）
  current: z.number().optional(), total: z.number().optional(),
})
```

- 追加写用 `fs.appendFile`（同一文档的写入串行化）。
- 上限 `MAX_EVENTS (5000)`：超过时把文件重写为最近 4000 条（保留首条「加入队列」）。
- 读取 `documents:events({ id, afterSeq, limit })` 返回 `afterSeq` 之后的最多 `limit (500)` 条；渲染进程首次取最近 500 条，之后靠推送增量。
- 每条 progress 类事件同时更新 manifest 的 `stage/progress`（只在 `status === 'processing'` 时；防止取消后被复活）。

事件文案（stage → message，`detail` 视情况）：

| stage | message |
| --- | --- |
| received | `已复制源文件并加入处理队列`（detail：大小、SHA-256 前 16 位） |
| inspect | `检查 PDF：N 页`／失败信息 |
| analyze | `分析版面：识别到 N 个段落，其中 M 个待翻译，公式 K 处`；warning：`第 P 页没有识别到可翻译段落` |
| translate | `开始翻译：<translator>，共 N 段`；进度 `已翻译 X / N 段`；warning：重试与保留原文（04 章）；`翻译完成：N 段，保留原文 K 段，用量 输入 A / 输出 B tokens` |
| compose | `渲染公式贴图 N 处`；`排版译文并写入 N 段`；warning：`第 P 页第 Q 段溢出 / 排版失败，已保留原文` |
| verify | `校验通过：中文 PDF N 页，双语 PDF 2N 页` |
| archive | `已保存到文档库` |
| 任意 | error：`处理失败：<message>`；`已取消处理`；`等待自动重试（第 n 次）` |

## 5.6 IPC 契约（`src/shared/ipc.ts`）

设计：一个 `channels` 对象，每个通道一个 `{ request: zodSchema, response: zodSchema }`；`preload` 用它生成 `window.docflow.invoke(channel, payload)`，并把常用通道包装成方法；主进程 `ipc/register.ts` 遍历表注册 `ipcMain.handle`，统一 `request.parse()`、调用 handler、`response.parse()`（开发模式）与错误转换（`UserError` → `{ ok:false, error:{ code, message, user:true } }`；其他 → `user:false`、message `发生内部错误，详情见日志`，并写日志含堆栈）。返回统一信封 `{ ok: true, data } | { ok: false, error }`。

调用型通道（renderer → main）：

| 通道 | 请求 | 响应 |
| --- | --- | --- |
| `app:info` | — | `{ version, platform: 'darwin'|'win32', libraryDir, logsDir, arch }` |
| `app:setTheme` | `{ theme }` | `{}`（同步 `nativeTheme.themeSource` 并写 host.json） |
| `app:checkUpdates` | — | `{ latest: string, url: string, newer: boolean } | { error }`（GitHub API `repos/Uniseem/docflow/releases/latest`，10 s 超时） |
| `settings:get` | — | `SettingsView`（= Settings 去掉 secrets + `providers[].keyConfigured/keyMasked/keyOptional/keyUrl` + `presets` + `limits` + `capabilities: { llmReady, fakeProviders }`） |
| `settings:update` | `Partial<Settings>`（zod `.partial()` 深合并） | `SettingsView` |
| `secrets:set` | `{ providerId, value: string | null }` | `SettingsView` |
| `providers:save` | `{ provider: ProviderConfig }` | `SettingsView` |
| `providers:delete` | `{ id }` | `SettingsView` |
| `providers:listModels` | `{ providerId?, type, baseUrl, key?: string }`（key 为 undefined 时用已保存的） | `{ models: ModelInfo[] }` |
| `providers:check` | 同上 + `model` | `{ ok, latencyMs, reply } | { ok:false, message }` |
| `documents:create` | `{ paths: string[], title?: string, translator: TranslatorChoice }` | `{ created: DocumentSummary[], failed: { path, message }[] }` |
| `documents:list` | `{ filter: 'all'|'active'|'completed'|'failed', query?: string }` | `{ items: DocumentSummary[], counts: { all, active, completed, failed } }` |
| `documents:get` | `{ id }` | `DocumentSummary` |
| `documents:events` | `{ id, afterSeq?: number, limit?: number }` | `{ items: ProcessingEvent[], lastSeq }` |
| `documents:rename` | `{ id, title }` | `DocumentSummary` |
| `documents:retry` | `{ id }` | `DocumentSummary` |
| `documents:cancel` | `{ id }` | `DocumentSummary` |
| `documents:delete` | `{ ids: string[] }` | `{ deleted: string[] }` |
| `documents:export` | `{ id, kind: 'mono'|'dual'|'source'|'bundle' }` | `{ cancelled: true } | { path }`（主进程弹保存对话框，默认名 `suggestedNames[kind]`；bundle 用 fflate 打 ZIP：`source/`、`output/`、`manifest.json`、`events.jsonl`、`README.txt`） |
| `documents:reveal` | `{ id, kind?: 'mono'|'dual'|'source'|'folder' }` | `{}`（`shell.showItemInFolder`） |
| `documents:openExternal` | `{ id, kind: 'mono'|'dual'|'source' }` | `{}`（`shell.openPath`） |
| `dialog:pickPdfs` | — | `{ paths: string[] }`（过滤 `.pdf`，多选） |
| `dialog:pickFolder` | `{ title, message }` | `{ path } | { cancelled: true }` |
| `library:change` | `{ path }` | `{ libraryDir }` |
| `shell:openExternal` | `{ url }` | `{}`（仅 https/mailto） |
| `shell:openLogs` | — | `{}` |

推送型通道（main → renderer，`webContents.send`，preload 暴露 `on(channel, cb) → unsubscribe`）：

| 通道 | 载荷 |
| --- | --- |
| `document:changed` | `DocumentSummary`（状态、进度、阶段任一变化；节流 200 ms/文档） |
| `document:removed` | `{ id }` |
| `document:event` | `ProcessingEvent & { documentId }` |
| `settings:changed` | `SettingsView` |
| `library:changed` | `{ libraryDir }` |
| `app:openFiles` | `{ paths: string[] }`（macOS open-file / 第二实例命令行 / Dock 拖入） |

preload 里所有 `on` 回调都用 `ipcRenderer.on` 包装并 `structuredClone` 载荷；不暴露 `ipcRenderer` 本身。`window.docflow` 类型 `DocflowApi` 由 `channels` 表推导：`invoke<K extends keyof Channels>(k: K, req: z.input<Channels[K]['request']>): Promise<z.output<Channels[K]['response']>>`。

## 5.7 任务调度（`jobs/scheduler.ts`）

- 状态：`queued → processing → completed | failed | cancelled`；失败且可重试 → `retrying`（`nextAttemptAt = now + 20 × attempts s`，最多 `MAX_ATTEMPTS (3)`）→ 到时回 `queued`。
- 并发：最多 `settings.workerConcurrency` 个 `processing`；调度器每 1 s 与每次状态变化时检查队列（按 `nextAttemptAt ?? createdAt` 升序）。
- 每个任务一个 `AbortController`；`documents:cancel` → abort → 各阶段在 await 点抛 `CancelledError` → 状态 `cancelled`、事件 `已取消处理`；worker 被 terminate；`work/` 保留（缓存复用）。
- `documents:retry`：仅 `failed/cancelled` 可用；`attempts = 0`、`failure = null`、重新快照 `settingsSnapshot`、状态 `queued`。
- `documents:delete`：进行中先 cancel 并等待任务函数返回（最多 5 s），再 `rm -rf documents/<id>`；预览 iframe 需先卸载（渲染进程在收到 `document:removed` 前会先收到确认对话框流程；主进程删除前先 `document:changed` 一次 status `deleting`？——不引入新状态：渲染进程在发起删除前把预览 `src` 置空）。
- 启动恢复：`processing/retrying` → `queued`（事件 `应用重新启动，从断点继续`），`work/` 保留即断点。
- 单文档流程 `pipeline/run.ts`：

```
received(0–2)  → 复制源文件（已在 create 时完成，此处只写事件）
inspect(3–9)   → worker.inspect → work/inspection.json；标题：!titleCustom && inspection.title 存在时更新标题
analyze(10–29) → worker.analyze → work/analysis.json；stats 写 manifest；translatable=0 → no_paragraphs
translate(30–79) → translateDocument(...) → work/translation.json；kept/usage 写 manifest
raster(80–82)  → 需要贴图的占位符 → work/raster/*.png
compose(83–89) → worker.compose → work/mono.pdf, work/dual.pdf（bilingual=false 时不生成）
verify(90–93)  → worker.verify
archive(94–100)→ rename 到 output/、outputs 写 manifest、删除 work/、status completed、completedAt；通知
```

  每个阶段开始时若 `work/<stage>.json` 已存在且其 `sourceSha256`/`fingerprint` 匹配则跳过（断点续传：inspect/analyze 产物按 `sourceSha256`，translation 按 04 章指纹并且 `results.length === translatable`）。

## 5.8 通知

任务完成/失败且主窗口不在前台时，`new Notification({ title: '翻译完成' | '处理失败', body: title })`，点击后前置窗口并选中该文档。`settings.notifications=false` 时不发。macOS Dock 徽标 = 进行中文档数（`app.dock.setBadge`），Windows 任务栏用 `win.setProgressBar(总体进度)`，无进行中时清除。
