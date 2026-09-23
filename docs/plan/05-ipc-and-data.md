# 05 IPC 与数据

## 5.1 文档库目录

```
<library>/                         默认 = app.getPath('userData')：macOS ~/Library/Application Support/DocFlow
│                                                                  Windows %APPDATA%\DocFlow
├─ settings.json                   非敏感设置（5.3）；无法解析时改名为 settings.json.broken-<时间>
├─ secrets.bin                     safeStorage 加密的 API Key 映射（4.7）；解不开时改名为 secrets.bin.broken-<时间>
├─ logs/main.log  main.old.log     electron-log，单个文件超过 8 MB 时轮换
├─ documents/
│  └─ <id>/                        id = UTC 时间戳 + 6 位十六进制随机：`20260921T160000-8f3a2c`（可排序、可读）
│     ├─ manifest.json             文档记录（5.4）
│     ├─ source.pdf                源文件副本
│     ├─ events.jsonl              处理记录，追加写（5.5）
│     ├─ output/                   documents:create 时建好（空）
│     │  ├─ mono.pdf               中文 PDF
│     │  └─ dual.pdf               双语对照（处理时关闭了 pdf.bilingual 则没有）
│     └─ work/                     可再生中间产物；归档成功后删除，失败/取消/中断时保留作断点
│        ├─ inspection.json  analysis.json   检查点 `{ sourceSha256, data }`（5.7）
│        ├─ translation-cache.json           逐段译文缓存（04 §4.12）
│        └─ mono.pdf  dual.pdf     写回产物，verify 通过后 rename 到 output/
```

单实例由 `app.requestSingleInstanceLock()` 保证（锁在 userData，02 §2.5），文档库里**没有**锁文件。

`host.json` 放在 `app.getPath('userData')`（它记录文档库在哪，所以跟着 userData 而不是文档库走）：`HostState = { libraryDir?: string, window?: { width, height, x, y, maximized }, theme?: 'system'|'light'|'dark' }`（`.strict()`；读不出或校验失败按 `{}` 处理，不备份）。默认文档库就是 userData 本身，所以默认情况下 host.json 与 settings.json 在同一个文件夹，Electron 自己的数据（Chromium 缓存等）也在这里；换到别处的文档库里没有 host.json。优先级：`DOCFLOW_DATA_DIR` 环境变量（`path.resolve` 成绝对路径）> `host.json.libraryDir` > 默认。设置了 `DOCFLOW_DATA_DIR` 时 userData 改到 `<dir>/.electron-user-data`，E2E 与调试不碰真实的 host.json、缓存和单实例锁（2026-09-23 M5 E2E worklog：之前 E2E 改写了真实的 host.json）。

`HostStore.update(patch)` 浅合并后校验，写入排队串行，主题与窗口状态同时更新也不会互相覆盖。`theme` 由 `app:setTheme` 写，启动时先应用到 `nativeTheme.themeSource`。`window`（02 §2.5 第 8 步）：resize/move/最大化/还原后 500 ms 与关闭窗口时保存（最大化时存 `getNormalBounds()`，最小化或全屏时不存）；启动时只有标题栏那一条（高 40 px）在某块屏幕的工作区里露出至少 120 × 20 px 才恢复，否则按默认 1240 × 800 居中打开；宽高不小于最小尺寸 960 × 600；`maximized` 为 true 时在 `ready-to-show` 后 `maximize()`。

原子写：`settings/atomic-write.ts` 的 `writeFileAtomic(path, data)` / `writeJsonAtomic(path, value)`（2 空格缩进、末尾换行）：写 `path + '.' + 16 位十六进制 + '.tmp'` → `fsync` → `rename`；Windows 上 rename 目标存在或被占用会失败，`EPERM/EEXIST/EACCES` 时 `unlink` 目标再 `rename`（最多 3 次，间隔 50 ms），其他错误删掉临时文件后抛出。settings、secrets、host.json、manifest、inspect/analyze 检查点与翻译缓存都走它；`events.jsonl` 例外（追加写，截断时直接重写）。

## 5.2 更改文档库位置

设置 → 通用 → 文档库 → 更改…：选文件夹（`dialog:pickFolder`）→ 确认对话框（文案见 06 章）→ `library:change({ path })`，主进程若所选目录名不是 `DocFlow` 则追加 `/DocFlow` → **先在新对象里打开新库**（`AppSession.prepareLibrary`）：建目录、试写并删除一个临时文件 `.docflow-write-test-<随机>`、`settings.load()`、`secrets.load()`、`library.open(newDir)`；任何一步失败都抛用户错误 `无法使用这个文件夹作为文档库：<原因>。请选择其他位置。`（原因按 errno：`没有读写这个文件夹的权限` / `这个位置是只读的` / `磁盘空间不足` / `文件夹不存在或所在的磁盘已断开`，其他为 `无法读写这个文件夹`；原始错误写日志），**旧库照常运行，host.json 不变** → 全部成功后才停止旧调度器（`scheduler.stop()` 最多等 5 s，随后结束两个 PDF worker 线程；进行中的文档保持 `processing`，下次打开那个库时续跑，见 5.7）→ 切换到新库（日志改写到新库的 `logs/`）、作废全部翻译池（4.8）、按新库设置应用代理 → 写 `host.json.libraryDir`（写失败只记日志，本次运行仍用新库）→ 重新注册 IPC handler（每组 handler 固定对应一个库：`app:info.libraryDir` 也取这组 handler 的库，切换途中不会出现 `app:info` 已是新库、其他通道还读旧库的情况）、启动新库的调度器（含启动恢复）→ 推送 `library:changed` 与 `settings:changed`，渲染进程重新拉取一切。**不迁移数据**（与 3.x 一致：旧库留在原处）。设置了 `DOCFLOW_DATA_DIR` 时 `app:info.dataDirFromEnv` 为 true，界面禁用「更改…」。

启动时 host.json 指向的库打不开（外接盘拔掉、没有权限、文件损坏）→ 回落到默认文档库，窗口 `ready-to-show` 后弹一次原生提示：标题 `无法打开文档库`，内容为原因、`文档库位置：<原位置>`、`本次已改用默认文档库：<默认位置>` 与 `可以在 设置 → 通用 → 文档库 中重新选择。`；host.json 不改，下次启动仍先试原位置。默认库也打不开（或原位置就是默认库）→ 错误框「DocFlow 无法启动」（内容：原因 + `请查看日志，或删除设置后重试。`）后退出。`secrets.bin` 解不开（换了电脑或系统钥匙串）→ 改名备份为 `secrets.bin.broken-<时间>`、按没有 Key 处理并写日志，不阻止打开文档库（2026-09-23 M5 修复 worklog）。系统钥匙串不可用（`safeStorage.isEncryptionAvailable()` 为 false）时不读也不动 `secrets.bin`，按没有 Key 处理；此时 `secrets:set` 报 `keychain_unavailable`（`这台电脑的系统钥匙串不可用，无法安全保存 API Key。`）。

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

实际代码里 `proxy` 用 `ProxyConfig`、URL 用 `ProxyUrl`、上限用 `MAX_PROVIDERS`（均在 `src/shared/types.ts` / `constants.ts`），与上面展开的写法等价。

- 读取：文件不存在 → 默认值；解析失败 → 改名备份为 `settings.json.broken-<时间>` 并用默认值，主日志记 warning。
- 未知字段：zod `.strict()` 拒绝 → 视为损坏（同上）。升级版本时用 `version` 做迁移函数链（目前只有版本 1，还没有迁移）。
- 写入：`settings.update(patch)` 深合并（对象逐层合并，数组与 `null` 整体替换）后整体校验再原子写；随后按新设置配置翻译池、广播 `settings:changed`、按需重新应用代理。
- `defaultTranslator` 指向的服务商/模型不存在时置 `null`（读取与每次写入时都检查）。
- `pdf.bilingual` 与 `pdf.minFontScale` 不进文档的 `settingsSnapshot`：写回阶段读当时的设置（5.7）。
- 代理（02 §2.5 第 7 步，`app/proxy.ts`）：打开文档库时（启动、更改文档库）和 `proxy` 变化时 `session.defaultSession.setProxy()`，随后 `closeAllConnections()` 让已建立的连接改走新路由；与上次应用的配置相同则跳过，失败只写日志（下次再试）。`system` → `{ mode: 'system' }`；`direct` → `{ mode: 'direct' }`；`custom` → `{ mode: 'fixed_servers', proxyRules: 'scheme://host:port' }`（去掉路径与凭据，`socks5h` 写成 `socks5`：Chromium 的 SOCKS5 本来就在代理端解析域名）。回环地址不走代理（Chromium 默认），本地 mock 服务不受影响。

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
    attempts: z.number().int(), // 失败次数：每次失败（转 retrying 或 failed）+1，手动重试清零
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

`documents:create` 写入的初值：`title` = 请求里的 `title`（去首尾空白）或文件名去掉 `.pdf`（空则 `文档`），最长 300 字符；给了 `title` 时 `titleCustom = true`；`status: 'queued'`、`stage: 'received'`、`progress: 2`、`pages/stats/failure/nextAttemptAt/startedAt/completedAt` 为 `null`、`attempts: 0`、`outputs` 两项为 `null`；`settingsSnapshot` = 当时的 `settings.translation`。

渲染进程看到的是 `DocumentSummary`（manifest 去掉 `settingsSnapshot`，加 `files: { source?, mono?, dual? }`、`suggestedNames: { mono, dual, bundle, source }`、`running: boolean`（调度器里正在跑））。`files` 是 `docflow://library/documents/<id>/source.pdf`、`…/output/mono.pdf`、`…/output/dual.pdf`：`source` 总是给出，`mono`/`dual` 在 manifest 的 `outputs` 记有该文件时给出（不检查磁盘）。`docflow://` 协议（`app/protocol.ts`）只返回文档库内的 `.pdf`（拒绝 `..`，`realpath` 后仍须在库内），带 `Content-Type: application/pdf`、`Cache-Control: no-store`，其他一律 404。

`suggestedNames`：`stem = sanitize(title)`（`\/:*?"<>|` 与控制字符换成 `_`，去首尾空白与点，空则 `文档`，最长 120 字符）→ `${stem}-中文译文.pdf`、`${stem}-双语对照.pdf`、`${stem}-完整文件.zip`、源文件用 `originalFilename`。

内存索引（`library/index.ts`）：`Map<id, DocumentManifest>`，`library.open()` 扫描 `documents/*/manifest.json` 建立（读不出或校验失败的目录跳过）；`list(filter, query)` 在内存里过滤，按 `createdAt` 降序；`counts(query)` 按同一个 `query`（不看 `filter`）返回四个分组数。分组与匹配规则在 `src/shared/library-filter.ts`，渲染进程判断推送来的文档是否属于当前筛选时用同一份：`active` = queued/processing/retrying，`completed`，`failed` = failed/cancelled；`query` 对 `title` 与 `originalFilename` 做不区分大小写的包含匹配，多个空白分隔的词全部匹配。

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

- 追加写用 `fs.appendFile`（同一文档的写入串行化；`seq` 在本次运行首次写该文档时从文件最后一行接着编）。每条写入后都推送 `document:event`。读取时解析不了的行跳过。
- 上限 `MAX_EVENTS (5000)`：超过时把文件重写为 `EVENT_KEEP (4000)` 条——首条（「已复制源文件并加入处理队列」）加最近 3999 条。
- 读取 `documents:events({ id, afterSeq, limit })`（默认 `afterSeq = 0`、`limit = 500`）：`afterSeq` 为 0 时返回最近 `limit` 条，否则返回 `afterSeq` 之后的前 `limit` 条；`lastSeq` 是文件里最后一条的序号。渲染进程首次取最近 500 条，之后靠推送增量，两者按 `seq` 合并。
- 每条 progress 类事件同时更新 manifest 的 `stage/progress`（只在 `status === 'processing'` 时；防止取消后被复活）。
- 每个阶段**开始**时也写一次 `{ stage, progress: 起点 }`（只改 manifest、不记事件）：列表与失败图标指向正在运行的阶段，而不是上一个完成的阶段。manifest 的更新按文档串行执行，每次在上一次写入的结果上合并；带条件的更新（`updateWhen`）在轮到它时才判断条件，基于过期状态做的决定不会覆盖更新的状态。

事件文案（stage → level 与 message，`detail` 视情况）。流水线的事件由 `pipeline/run.ts` 写；「任意」一行由调度器写，`stage` 取 manifest 当时的阶段：

| stage     | level 与 message                                                                                                                                                                                                                                                                                                                                                                                |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| received  | info：`已复制源文件并加入处理队列`（`documents:create` 时写，流水线不再写；detail：`<字节数> 字节，SHA-256 <前 16 位>`）                                                                                                                                                                                                                                                                        |
| inspect   | info：`检查 PDF：N 页`；失败见「任意」                                                                                                                                                                                                                                                                                                                                                          |
| analyze   | warning：`第 P 页没有识别到可翻译段落`（逐页，先于汇总）；info：`分析版面：识别到 N 个段落，其中 M 个待翻译，公式 K 处`；没有待翻译段落 → 失败 `no_paragraphs`                                                                                                                                                                                                                                  |
| translate | info：`开始翻译：<translator.label>，共 N 段`；info 进度 `已翻译 X / N 段`（带 `current/total`）；warning：重试与保留原文（04 章）；success：`翻译完成：N 段，保留原文 K 段，用量 输入 A / 输出 B tokens`                                                                                                                                                                                       |
| compose   | warning：`第 P 页第 Q 段译文超出原段落范围`（`overflow`）、`第 P 页第 Q 段排版失败，已保留原文`（`layout_failed`）、`第 P 页有文字指令无法对应到段落，已跳过该页`（`page_skipped`）、`第 P 页第 Q 段的公式字体无法映射，已保留原文`（`font_unmapped`），其他 code 直接用 warning 自带的 message；Q 是段落 id（形如 `2-5`）；info：`改写内容流：写入 N 段译文，重绘公式 K 处，删除文字指令 M 条` |
| verify    | success：`校验通过：中文 PDF N 页，双语 PDF M 页`（M 取 verify 结果）；没有生成双语时 `校验通过：中文 PDF N 页`                                                                                                                                                                                                                                                                                 |
| archive   | success：`已保存到文档库`                                                                                                                                                                                                                                                                                                                                                                       |
| 任意      | error：`处理失败：<message>`（detail：技术原因，若有）；warning：`已取消处理`；warning：`等待自动重试（第 n 次）`（detail：技术原因，没有则为失败信息）；info：`应用重新启动，从断点继续`（启动恢复）                                                                                                                                                                                           |

## 5.6 IPC 契约（`src/shared/ipc.ts`）

设计：一个 `channels` 对象，每个通道一个 `{ request: zodSchema, response: zodSchema }`；推送通道另有 `PushChannels`（通道 → 载荷 schema）。preload 不把通道包装成单独的方法，只暴露 `window.docflow = { invoke(channel, payload), on(channel, cb), pathsForFiles(files) }`（`pathsForFiles` 用 `webUtils.getPathForFile` 取拖入文件的本地路径）。主进程 `ipc/register.ts` 遍历表注册 `ipcMain.handle`（先 `removeHandler`；更改文档库后整表重新注册，handler 拿到新库的对象），统一 `request.parse(payload ?? {})`、调用 handler、`response.parse()`（仅 `NODE_ENV !== 'production'`）与错误转换：`UserError` → `{ ok:false, error:{ code, message, user:true } }`；`ZodError`（请求不合 schema，或 handler 里的校验失败，例如 `settings:update` 合并后的设置无效）→ `code: 'internal'`、message `请求无效。`、`user: true`；其他 → `user:false`、message `发生内部错误，详情见日志`，并写日志含堆栈。返回统一信封 `{ ok: true, data } | { ok: false, error }`。

设置相关的数据不在 IPC 边界做 zod 校验：`settings:get`、`settings:update`、`secrets:set`、`providers:save`、`providers:delete` 的响应和推送 `settings:changed` 的 schema 都是 `z.unknown()`，`SettingsView` 只有 TypeScript 类型（`src/shared/view.ts`）；`settings:update` 的请求也是 `z.unknown()`，由主进程深合并后用 `Settings` 整体校验（5.3）。

调用型通道（renderer → main）：

| 通道                     | 请求                                                                                                                                               | 响应                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app:info`               | —                                                                                                                                                  | `{ version, platform: 'darwin' \| 'win32', libraryDir, logsDir, arch, theme, dataDirFromEnv }`（`logsDir` 是 `<library>/logs` 目录；`dataDirFromEnv`：设置了 `DOCFLOW_DATA_DIR` 且没有设置 `DOCFLOW_E2E_FOLDER_PATH`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `app:setTheme`           | `{ theme: 'system' \| 'light' \| 'dark' }`                                                                                                         | `{}`（同步 `nativeTheme.themeSource` 并写 host.json）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `app:checkUpdates`       | —                                                                                                                                                  | `{ latest: string, url: string, newer: boolean } \| { error: string }`（GitHub API `repos/Uniseem/docflow/releases/latest`，10 s 超时；`latest` 是 tag 名；`error` 为 `GitHub 返回 <状态码>` 或 `无法检查更新，请稍后重试。`。菜单「检查更新…」在主进程跑同一检查并弹原生对话框）                                                                                                                                                                                                                                                                                                                                                                                                         |
| `app:relaunch`           | —                                                                                                                                                  | `{}`（`app.relaunch()` + `app.quit()`；preload 失败时「重新启动」）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `app:takePendingFiles`   | —                                                                                                                                                  | `{ paths: string[] }`：取走启动参数（以 `.pdf` 结尾且不以 `-` 开头的项）、macOS `open-file`、第二实例带来但渲染进程订阅前到达的 PDF。渲染进程订阅 `app:openFiles` 后调用一次；此后主进程直接推送 `app:openFiles`，页面重新加载、渲染进程崩溃或窗口关闭后重新排队                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `settings:get`           | —                                                                                                                                                  | `SettingsView` = Settings（`providers[]` 另带 `keyConfigured/keyMasked/keyOptional/keyUrl`，不含 Key 明文）+ `presets` + `limits: { maxProviders, workerConcurrency: { min, max } }` + `capabilities: { llmReady, fakeProviders }`                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `settings:update`        | 设置的任意局部对象（schema 为 `z.unknown()`）                                                                                                      | `SettingsView`（深合并后整体校验，无效 → `请求无效。`；5.3）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `secrets:set`            | `{ providerId, value: string \| null }`                                                                                                            | `SettingsView`（`null` 或空串删除该 Key；之后作废该服务商的翻译池，4.8；钥匙串不可用 → `keychain_unavailable`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `providers:save`         | `{ provider: ProviderConfig }`                                                                                                                     | `SettingsView`（按 `id` 新增或替换；新增超过 64 个 → `最多添加 64 个服务商。`；之后作废该服务商的翻译池）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `providers:delete`       | `{ id }`                                                                                                                                           | `SettingsView`（同时删除它的 Key，作废翻译池）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `providers:listModels`   | `{ providerId?, type, baseUrl, key?: string }`（key 为 undefined 时用 `providerId` 已保存的 Key；`providerId` 是已保存的服务商时沿用它的其他配置） | `{ models: ModelInfo[] }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `providers:check`        | 同上 + `model`                                                                                                                                     | `{ ok: true, latencyMs, reply } \| { ok: false, message }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `documents:create`       | `{ paths: string[], title?: string, translator: TranslatorChoice }`                                                                                | `{ created: DocumentSummary[], failed: { path, message }[] }`（服务商或模型不存在 → 整个请求失败：`找不到这个翻译服务商。`／`找不到这个模型。`；单个文件失败进 `failed`：`无法读取这个文件。`、`请选择 PDF 文件。`（不是文件或扩展名不是 `.pdf`）、`文件太大，请选择小于 500 MB 的 PDF。`，其他为 `无法添加这个文件。`；每建一篇推送一次 `document:changed`，最后触发一次调度）                                                                                                                                                                                                                                                                                                           |
| `documents:list`         | `{ filter: 'all' \| 'active' \| 'completed' \| 'failed', query?: string }`                                                                         | `{ items: DocumentSummary[], counts: { all, active, completed, failed } }`（5.4）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `documents:get`          | `{ id }`                                                                                                                                           | `DocumentSummary`（不存在 → `not_found`：`找不到这个文档。`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `documents:events`       | `{ id, afterSeq?: number, limit?: number }`                                                                                                        | `{ items: ProcessingEvent[], lastSeq }`（5.5）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `documents:rename`       | `{ id, title }`                                                                                                                                    | `DocumentSummary`（去首尾空白，最长 300 字符，`titleCustom = true`；空 → `标题不能为空。`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `documents:retry`        | `{ id }`                                                                                                                                           | `DocumentSummary`（只对 failed/cancelled 生效，否则 `只有失败或已取消的文档可以重新处理。`；见 5.7）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `documents:cancel`       | `{ id }`                                                                                                                                           | `DocumentSummary`（只对 queued/processing/retrying 生效，其他状态原样返回；见 5.7）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `documents:delete`       | `{ ids: string[] }`                                                                                                                                | `{ deleted: string[] }`（逐个删除，每删一个推送 `document:removed`；见 5.7）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `documents:export`       | `{ id, kind: 'mono' \| 'dual' \| 'source' \| 'bundle' }`                                                                                           | `{ cancelled: true } \| { path }`（主进程弹保存对话框「导出」，默认名 `suggestedNames[kind]`；bundle 用 fflate 打 ZIP：`source/<originalFilename>`、`output/mono.pdf` 与 `output/dual.pdf`（有才放）、`manifest.json`（完整 manifest）、`events.jsonl`、`README.txt`。文件不在文档库里 → `not_found`（如 `中文 PDF 不存在，可能已被删除。请重新处理这篇文档。`；复制途中源文件消失 → `文件已不在文档库里，请重新处理这篇文档。`）；写入失败按 errno 转成用户错误，只含原因与下一步：`没有写入权限，请换一个位置。`、`磁盘空间不足，请清理后重试。`、`文件被其他程序占用，请关闭后重试或换一个位置。`、`保存位置不存在，请换一个位置。` 等，界面在前面加上文件名；未知原因按内部错误处理） |
| `documents:reveal`       | `{ id, kind?: 'mono' \| 'dual' \| 'source' \| 'folder' }`                                                                                          | `{}`（`shell.showItemInFolder`，`kind` 默认 `folder`；`id` 为空串时显示文档库文件夹（设置 → 通用 用）；文件不存在 → `not_found`，说明缺什么）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `documents:openExternal` | `{ id, kind: 'mono' \| 'dual' \| 'source' }`                                                                                                       | `{}`（`shell.openPath`；文件不存在 → `not_found`，例如「这篇文档没有双语对照 PDF…」；打开失败 → `无法打开文件：<原因>`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `dialog:pickPdfs`        | —                                                                                                                                                  | `{ paths: string[] }`（标题 `选择 PDF`，过滤 `.pdf`，多选；取消 → 空数组）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `dialog:pickFolder`      | `{ title, message }`                                                                                                                               | `{ path } \| { cancelled: true }`（可新建文件夹；设置了 `DOCFLOW_E2E_FOLDER_PATH` 时直接返回它）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `library:change`         | `{ path }`                                                                                                                                         | `{ libraryDir }`（5.2；新库打不开时抛用户错误，旧库继续运行）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `shell:openExternal`     | `{ url }`                                                                                                                                          | `{}`（仅 `https:`/`mailto:`，否则 `只能打开 https 或 mailto 链接。`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `shell:revealExport`     | `{ path }`                                                                                                                                         | `{}`（在访达/资源管理器中显示导出的文件。只接受本次运行中 `documents:export` 写出过的路径，其他路径 → `not_found`：`找不到这个导出的文件。`；文件已被移动或删除 → `not_found`：`导出的文件已被移动或删除。`）（2026-09-23 M5 复查第 15 条：导出提示原先打开的是文档库副本）                                                                                                                                                                                                                                                                                                                                                                                                               |
| `shell:openLogs`         | —                                                                                                                                                  | `{}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `shell:openNotices`      | —                                                                                                                                                  | `{}`（打开 `THIRD_PARTY_NOTICES.md`：先找当前工作目录，再找 `process.resourcesPath`；都没有则什么也不做）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

推送型通道（main → renderer，`webContents.send`，preload 暴露 `on(channel, cb) → unsubscribe`）：

| 通道               | 载荷                                                                                                                                                                                                           |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `document:changed` | `DocumentSummary`（流水线与调度器引起的状态、进度、阶段变化按文档节流：200 ms 内合并为一次、发最新状态，同时刷新 Dock 徽标与进度条；`documents:create/rename/retry/cancel` 的 handler 另外立即推送一次）       |
| `document:removed` | `{ id }`                                                                                                                                                                                                       |
| `document:event`   | `ProcessingEvent & { documentId }`（每条事件写入后推送）                                                                                                                                                       |
| `settings:changed` | `SettingsView`（`settings.update` 成功后，包括 `providers:save/delete`；更改文档库后。`secrets:set` 不推送）                                                                                                   |
| `library:changed`  | `{ libraryDir }`                                                                                                                                                                                               |
| `app:openFiles`    | `{ paths: string[] }`（macOS open-file / 第二实例命令行 / Dock 拖入；没有窗口时先建窗口；渲染进程取走 `app:takePendingFiles` 之后才直接推送）                                                                  |
| `app:command`      | `{ name: 'new-translation' \| 'settings' \| 'focus-search' }`（菜单「新建翻译…」CmdOrCtrl+N 与「设置…」CmdOrCtrl+,（只在 macOS 应用菜单里）；`focus-search` 在 schema 里、渲染进程也处理，但主进程目前不发送） |

preload 的 `on` 只接受 `PushChannels` 里的通道名（其他名字返回空的 unsubscribe），回调用 `ipcRenderer.on` 包装并 `structuredClone` 载荷；推送载荷不做运行时校验，`PushChannels` 的 schema 只用来推导类型。不暴露 `ipcRenderer` 本身。`window.docflow` 类型 `DocflowApi` 由表推导：`invoke<K extends ChannelName>(channel: K, payload: z.input<Channels[K]['request']>): Promise<z.output<Channels[K]['response']>>`、`on<K extends PushChannelName>(channel: K, cb: (payload: z.output<PushChannels[K]>) => void): () => void`、`pathsForFiles(files: File[]): string[]`。

失败时 `invoke` 以普通对象 `IpcFailure = { code, message, user }` reject，而不是 `Error`：contextBridge 复制 `Error` 时只保留 `message`，`code`/`user` 会丢，渲染进程就分不清用户错误和内部错误（2026-09-23 M5 E2E worklog 实测；见 [ADR-0012](../adr/0012-ipc-error-envelope.md)）。`renderer/api/invoke.ts` 用 `toDocflowError`（`renderer/api/errors.ts`）把它还原成带 `code`、`user` 的 `Error`，内部错误（`user: false`）另弹「发生内部错误，详情见日志」提示并带「打开日志」按钮；界面代码只通过这个封装调用。

## 5.7 任务调度（`jobs/scheduler.ts`）

- 状态：`queued → processing → completed | failed | cancelled`；失败且可重试 → `retrying`（`attempts + 1`，`nextAttemptAt = now + 20 × attempts s`，即 20 s、40 s）→ 到时回 `queued`。一篇文档最多跑 `MAX_ATTEMPTS (3)` 次：第 3 次失败，或错误是永久性的（`UserError.permanent`、服务商错误 `credential/fatal/refused`、磁盘写满、意外错误），直接 `failed`（`attempts + 1`，写 `completedAt`）。
- 并发：最多 `settings.workerConcurrency` 个在跑（每次调度时读取，改设置后下一次调度生效）；调度（`tick()`）每 `SCHEDULER_TICK_MS (1 s)` 一次，另在新建、重新处理、任务结束时立即执行：先把到时的 `retrying` 改回 `queued`（清空 `nextAttemptAt`），再按 `nextAttemptAt ?? createdAt` 升序启动 `queued`。开始运行时按条件（仍是 `queued`）写 `processing`、`failure = null`、`startedAt`（已有则保留）。
- 每个任务一个 `AbortController`，abort 带原因区分两种中断（2026-09-23 M5 复查第 5–7 条）：
  - **用户取消**（`documents:cancel`）：只对 `queued/processing/retrying` 生效，其他状态原样返回、不写事件。先 abort，再按条件（`updateWhen`）写 `cancelled`、`failure: { code: 'cancelled', message: '已取消处理', permanent: true }`、`completedAt` 与**一条** warning 事件 `已取消处理`（两次取消只记一次）；随后最多等任务函数返回 `STOP_GRACE_MS`（5 s）。正在跑的 PDF worker 线程随 abort 被 terminate，`work/` 保留（缓存复用）。进入 `archive` 阶段（输出正在替换 `work/`）后不再接受取消（原样返回），文档照常完成。
  - **关停**（`scheduler.stop()`：退出应用、更改文档库）：中断进行中的文档但**不算取消**，状态保持 `processing`，下次打开这个文档库时由启动恢复续跑。退出应用时 `before-quit` 先等 `AppSession.dispose()`（`stop()` 最多 5 s，再结束两个 PDF worker 线程）再真正退出。见 [ADR-0013](../adr/0013-shutdown-is-not-cancel.md)。
  - 被中断的任务自己不再写状态，不会覆盖取消或更新的状态；流水线在中断后才返回时（已归档）照常记为完成。
- 重试等待（04 §4.11）与并发池排队都随 abort 立即结束，取消与删除不会被退避等待卡住。
- 失败：用户错误与服务商错误按原文（服务商错误见 04 §4.5 的文案表，`failure.code` 为错误类别 `kind`）；其他意外错误写日志（含堆栈），界面显示 `处理时发生内部错误，详情见日志。`（code `internal`；磁盘写满时 `磁盘空间不足，请清理磁盘后重新处理。`，code `disk_full`），原始错误文字放进事件 `detail`。
- `documents:retry`：仅 `failed/cancelled` 可用；`attempts = 0`、`failure = null`、`nextAttemptAt = null`、`startedAt = completedAt = null`（「已用时」从新的一次算起）、重新快照 `settingsSnapshot`、状态 `queued`；`translator` 不变，`stage/progress` 保持到流水线重新进入各阶段。
- `documents:delete`：进行中先中断（不写 `cancelled`）并等待任务函数返回（最多 5 s），再从索引移除并 `rm -rf documents/<id>`（`maxRetries: 5`、`retryDelay: 200`，Windows 上 PDF 查看器或杀毒软件短暂占用文件时重试；仍失败则放回索引并报错）；删除后仍在收尾的任务写 manifest 会得到 `not_found`，写入恰好落在删除之后时再删一次目录，不会让文档「复活」。预览 iframe 需先卸载：渲染进程在发起删除前把预览 `src` 置空。
- 启动恢复（`scheduler.start()`，启动与更改文档库时）：`processing/retrying` → `queued`、清空 `nextAttemptAt`（等待退避的也立即排队），各写一条 info 事件 `应用重新启动，从断点继续`；`attempts` 不变，`work/` 保留即断点。
- 单文档流程 `pipeline/run.ts`：

```
received(0–2)    → documents:create 时已复制源文件并写事件；流水线不再处理这个阶段
inspect(3–9)     → worker inspect → 检查点 work/inspection.json；pages 写 manifest；!titleCustom && inspection.title 存在时更新标题
analyze(10–29)   → worker analyze → 检查点 work/analysis.json；stats 写 manifest；translatable=0 → no_paragraphs
translate(30–79) → translateStage → translateDocument（04 章）→ 逐段缓存 work/translation-cache.json；translated/kept/usage 写 stats
compose(80–89)   → worker compose → work/mono.pdf、work/dual.pdf（当时的 settings.pdf.bilingual=false 时不生成）；warnings 写事件；stats.kept 加上写回时保留原文的段数，opsRemoved 写 stats
verify(90–93)    → worker verify
archive(94–100)  → rename 到 output/、删除 work/、事件「已保存到文档库」、outputs 写 manifest（不论当时状态）
流水线返回后      → 调度器按条件写 status completed、stage done、progress 100、completedAt；状态变化触发通知（5.8）
```

断点续传：inspect/analyze 的结果以 `{ sourceSha256, data }` 存为检查点，阶段开始时文件存在且 `sourceSha256` 与 manifest 一致就直接用，否则重算并写入。translate 没有整阶段的检查点（不写 `translation.json`），靠 04 §4.12 的逐段缓存：指纹一致时已缓存的段落不再请求。compose、verify 每次重跑；`pdf.bilingual` 与 `minFontScale` 在写回时读当时的设置，不来自 `settingsSnapshot`。

## 5.8 通知

文档状态变为 `completed`/`failed` 且主窗口不在前台（`isFocused()` 为 false）时，`new Notification({ title: '翻译完成' | '处理失败', body: title })`，点击后显示并前置主窗口（不会选中该文档）。`settings.notifications=false` 或系统不支持通知时不发；没有窗口时按在前台处理，也不发。macOS Dock 徽标 = 进行中（queued/processing/retrying）的文档数（`app.dock.setBadge`，没有时清除）；进度条用 `win.setProgressBar(这些文档 progress 的平均值 / 100)`（Windows 任务栏，macOS 显示在 Dock 图标上），没有进行中的文档时设为 -1 清除。两者随 `document:changed` 的节流推送一起刷新。
