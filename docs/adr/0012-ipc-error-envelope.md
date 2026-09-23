# ADR-0012：IPC 用信封返回结果，preload 以普通对象 reject 错误

- 状态：已采纳
- 日期：2026-09-23
- 相关：M4-4、M5-7、docs/plan/05-ipc-and-data.md（5.6）、worklog 2026-09-23-m5-e2e

## 背景

主进程 handler 抛出的错误分两类：给用户看的 `UserError`（带 `code`、中文 `message`、`user: true`）和意外错误。界面要按 `code` 决定提示方式（例如 Key 无效时跳到设置），按 `user` 决定显示原文还是通用文案。

M5 跑 E2E 时发现，所有用户错误在界面上都变成了「发生内部错误」：`ipcMain.handle` 抛出的 Error 经过 `ipcRenderer.invoke` 只保留 `message`，preload 再经 contextBridge 抛给渲染进程时，Error 上的自定义属性（`code`、`user`）也会被丢掉。

## 决定

- 主进程 `ipc/register.ts` 不让 handler 的异常穿过 `ipcMain.handle`，一律包成信封返回：成功 `{ ok: true, data }`，失败 `{ ok: false, error: { code, message, user } }`。
  - `UserError` → 原样带出 `code` 与中文 `message`，`user: true`。
  - 请求没通过通道 schema（`ZodError`）→ `internal` / `请求无效。`，`user: true`。
  - 其他异常 → 堆栈写日志，返回 `internal` / `发生内部错误，详情见日志`，`user: false`。
  - 开发与测试环境额外校验响应 schema，生产环境跳过。
- preload 解开信封：成功返回 `data`；失败时 **以普通对象 `IpcFailure { code, message, user }` reject**，不构造 Error（contextBridge 复制普通对象时属性完整保留）。
- 渲染进程 `renderer/api/errors.ts` 的 `toDocflowError` 把 reject 值还原成带 `code`、`user` 的 Error，界面只和这个类型打交道。
- 设置类通道（`settings:update` 等）的请求在通道层是 `z.unknown()`，由 `Settings.update` 在合并后用完整的 `Settings` schema 校验，失败同样作为 `ZodError` 返回「请求无效。」。这仍满足「跨进程数据经 zod 校验」，只是校验点在设置层。

## 备选方案

- **把 `code`、`user` 编进 `message` 字符串再解析**：脆弱，message 还要直接显示给用户。放弃。
- **preload 抛带自定义属性的 Error**：正是本问题的来源，contextBridge 复制 Error 时丢掉自定义属性。放弃。
- **设置通道在 IPC 层用部分 schema（`Settings.partial()`）**：嵌套对象的深合并需要深度 partial，schema 会和 `Settings` 分叉。放弃。

## 后果

- 好处：用户错误的中文文案与错误码完整到达界面；意外错误不会把内部细节暴露给用户；handler 可以直接抛 `UserError`。
- 代价：preload 需要 `eslint-disable @typescript-eslint/only-throw-error`；渲染进程必须通过 `renderer/api/invoke.ts` 调用（它负责 `toDocflowError`），不要直接用 `window.docflow.invoke`（只有 `App.tsx` 错误边界里的「重新启动」按钮例外）。
- 需要跟进的事：新增通道时在 `src/shared/ipc.ts` 写 request/response schema，不要在 handler 里自己 try/catch 吞掉 `UserError`。
