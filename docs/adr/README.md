# 架构决策记录（ADR）

一个决定一个文件，编号递增，永不删除；被推翻的记录把状态改成「已废弃」并指向新记录。模板见 [0000-template.md](0000-template.md)。

| 编号 | 标题 | 状态 |
| --- | --- | --- |
| [0001](0001-electron-react-heroui.md) | 用 Electron + React + HeroUI 3 重建桌面应用 | 已采纳 |
| [0002](0002-drop-mineru-and-markdown-route.md) | 移除 MinerU、Markdown 阅读视图与期刊 PDF 路线 | 已采纳 |
| [0003](0003-typescript-pdf-pipeline.md) | 用 TypeScript（pdf.js + pdf-lib）实现 PDF 原生翻译，替代 BabelDOC/Python | 已采纳 |
| [0004](0004-file-based-library.md) | 文档库用文件存储，不用数据库 | 已采纳 |
| [0005](0005-net-fetch-for-http.md) | 所有 HTTP 走 Electron `net.fetch`，代理交给 Chromium | 已采纳 |
| [0006](0006-raster-inline-objects.md) | 行内公式等不可翻译对象用栅格化贴图保留位置 | 已采纳 |
| [0007](0007-unsigned-distribution-and-ci.md) | 不签名分发；macOS 用 pkg + dmg，Windows 用 NSIS；CI 只依赖 Node | 已采纳 |
