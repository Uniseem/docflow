# ADR-0004：文档库用文件存储，不用数据库

- 状态：已采纳
- 日期：2026-09-21
- 相关：docs/plan/05-ipc-and-data.md

## 背景

3.x 用 SQLite（sqlx）保存文档、事件、设置三张表，归档文件另放目录，两者要保持一致。Node 侧的 SQLite 方案要么是原生模块（`better-sqlite3`，要为 Electron ABI 重编译），要么是 `node:sqlite`（Electron 44 的 Node 24 已带，但在 Electron 里的可用性未经我们验证）。个人文档库规模是几十到几千个文档。

## 决定

- 每个文档一个目录 `documents/<id>/`，里面 `manifest.json`（文档记录）、`source.pdf`、`events.jsonl`（处理记录，追加写）、`output/`（结果）、`work/`（可再生的中间产物）。
- 列表用内存索引：启动时扫描所有 `manifest.json` 建索引，之后每次变更同步写回对应 manifest；索引不落盘（几千个小 JSON 的读取在 100 ms 级）。
- 设置 `settings.json`、密钥 `secrets.bin`（`safeStorage` 加密）都是单文件；所有写入都是「写临时文件 → rename」的原子写。
- 事件文件按行追加，读取时只取最近 N 条或按序号增量读取。

## 备选方案

- `node:sqlite`：省去一致性问题，但要验证 Electron 打包后可用、要写迁移；收益不明显。若文档量超过万级再考虑，届时迁移只是读 manifest 入库。
- `better-sqlite3`：原生模块，违反「零原生依赖」。放弃。

## 后果

- 好处：零依赖；文档目录可以直接拷贝备份；损坏一个文档不影响其他；调试时用文本编辑器就能看。
- 代价：没有事务；搜索是内存里的字符串匹配；事件文件可能变大（限制单文档最多 5000 条，超过后滚动截断）。
