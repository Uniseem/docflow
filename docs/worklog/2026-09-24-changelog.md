# 2026-09-24 同步仓库与更新日志补漏

## 会话 1（Claude Code / Opus 5.5，上午）

### 目标

本地 `main` 与 GitHub 同步；修正 `CHANGELOG.md` 里已过时的服务商条目。

### 做了什么

- 本地 `main` 落后 `origin/main` 3 个提交（服务商调研第二轮与预设更新），快进同步；`npm install` 清掉 7 个多余包。
- `npm install` 用 npm 11.6.2 改写了 `package-lock.json`，差异只是 `"peer": true` 标记位置，没有版本变化，已还原为仓库版本。
- `CHANGELOG.md`：「新增」里的调研笔记条目从 4 家改为 19 家，删掉「预设与请求代码尚未按调研结果修改」；「变更」补一行预设改动（移除零一万物、新增 MiniMax、DeepSeek 地址、默认不传温度）。

### 怎么验证的

- `npm run check`：通过。

### 没做成 / 坑

- 不同 npm 版本对 `package-lock.json` 的 `peer` 标记写法不同，`npm install` 后先看差异再决定是否提交。

### 下一步

- 仍按 [2026-09-23 的剩余项](2026-09-23-m5-fixes.md)：M5-8 需要 DeepSeek Key；M6-2 安装包 130 MB 目标待定；M6-3 打 beta 标签需确认；M7 全部未开始。

### 提交

- `docs: 更新日志补上服务商预设改动`
