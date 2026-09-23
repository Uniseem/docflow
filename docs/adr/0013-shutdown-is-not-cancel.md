# ADR-0013：退出应用与更换文档库不算取消，下次打开时从断点续跑

- 状态：已采纳
- 日期：2026-09-23
- 相关：M5-9（复查第 5–7 条）、R7、docs/plan/05-ipc-and-data.md（5.7）、worklog 2026-09-23-m5-review / m5-fixes

## 背景

M4 的调度器只有一种中断：每个任务一个 `AbortController`，用户取消、退出应用、更换文档库都走同一个 abort，被中断的任务一律写 `cancelled`。M5 复查（第 5–7 条）发现这与「完成的定义」第 5 条（关闭再打开，进行中的任务从断点继续）冲突：退出应用会把所有进行中的文档写成「已取消」，下次打开时启动恢复只认 `processing/retrying`，这些文档不会续跑，只能手动「重新处理」。另外，确认框打开期间文档已完成也会被改成「已取消」；取消进行中的文档会写两条「已取消处理」；取消与删除的等待不响应 abort，可能卡几分钟。

## 决定

- abort 带原因区分两种中断：
  - **用户取消**（`documents:cancel`）：由 `cancel()` 自己按条件（`updateWhen`，仍是 `queued/processing/retrying` 才写）写 `cancelled` 和一条 warning 事件 `已取消处理`，再最多等任务函数返回 5 s（`STOP_GRACE_MS`）。
  - **关停**（`scheduler.stop()`，abort 原因 `SHUTDOWN_REASON`）：退出应用、更换文档库时使用。不写任何状态，文档保持 `processing`；下次 `scheduler.start()` 的启动恢复把 `processing/retrying` 改回 `queued`，写 info 事件 `应用重新启动，从断点继续`，`work/` 里的缓存即断点。
- 被中断的任务函数自己不再写状态；流水线在中断后才返回（已归档）时照常记为完成。
- 进入 `archive` 阶段（输出正在替换 `work/`）后不再接受用户取消。
- 退出应用时 `before-quit` 先 `preventDefault`，等 `AppSession.dispose()`（`stop()` 最多 5 s，再结束 PDF worker 线程）完成后再真正退出。

## 备选方案

- **退出时写 `cancelled`，启动恢复也把 `cancelled` 改回 `queued`**：会把用户主动取消的文档也重新跑起来。放弃。
- **manifest 加一个 `interrupted` 状态**：多一个状态要改 schema、界面筛选和计数，而 `processing` 在应用未运行时本来就等价于「被中断」。放弃。
- **退出时等所有任务跑完**：翻译可能要几分钟，用户关不掉应用。放弃。

## 后果

- 好处：关闭再打开真正续跑，已翻译的段落不重新计费；取消只记一次，状态不会被迟到的任务覆盖。
- 代价 / 风险：崩溃或强制结束（没走 `before-quit`）时同样留下 `processing`，也会续跑，这是期望行为；但如果某份文档每次都让应用崩溃，下次启动会再次触发。`attempts` 不因关停增加，这种情况只能靠用户删除或取消。
- 需要跟进的事：M7 实测 Windows 上关机/注销时 `before-quit` 能否等满 5 s。
