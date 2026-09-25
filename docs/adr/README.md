# 架构决策记录（ADR）

一个决定一个文件，编号递增，永不删除；被推翻的记录把状态改成「已废弃」并指向新记录。模板见 [0000-template.md](0000-template.md)。

| 编号                                             | 标题                                                                     | 状态                       |
| ------------------------------------------------ | ------------------------------------------------------------------------ | -------------------------- |
| [0001](0001-electron-react-heroui.md)            | 用 Electron + React + HeroUI 3 重建桌面应用                              | 已采纳                     |
| [0002](0002-drop-mineru-and-markdown-route.md)   | 移除 MinerU、Markdown 阅读视图与期刊 PDF 路线                            | 已采纳                     |
| [0003](0003-typescript-pdf-pipeline.md)          | 用 TypeScript（pdf.js + pdf-lib）实现 PDF 原生翻译，替代 BabelDOC/Python | 已采纳（部分被 0016 修订） |
| [0004](0004-file-based-library.md)               | 文档库用文件存储，不用数据库                                             | 已采纳                     |
| [0005](0005-net-fetch-for-http.md)               | 所有 HTTP 走 Electron `net.fetch`，代理交给 Chromium                     | 已采纳                     |
| [0006](0006-raster-inline-objects.md)            | 行内公式等不可翻译对象用栅格化贴图保留位置                               | 已废弃（被 0008 取代）     |
| [0007](0007-unsigned-distribution-and-ci.md)     | 不签名分发；macOS 用 pkg + dmg，Windows 用 NSIS；CI 只依赖 Node          | 已采纳                     |
| [0008](0008-content-stream-rewrite.md)           | 写回采用内容流改写（PDFMathTranslate 方式），公式用原字体重绘            | 已废弃（被 0016 取代）     |
| [0009](0009-packed-renderer-loading.md)          | 沙箱 preload 把 zod 打进 CJS；渲染进程保持 module 脚本与严格 CSP         | 已采纳                     |
| [0010](0010-exclude-pdfjs-native-canvas.md)      | 安装包排除 pdf.js 的可选原生依赖，DOMMatrix 用纯 JS 补齐                 | 已采纳                     |
| [0011](0011-provider-presets-follow-research.md) | 服务商预设以官方调研为准，请求默认不传温度                               | 已采纳                     |
| [0012](0012-ipc-error-envelope.md)               | IPC 用信封返回结果，preload 以普通对象 reject 错误                       | 已采纳                     |
| [0013](0013-shutdown-is-not-cancel.md)           | 退出应用与更换文档库不算取消，下次打开时从断点续跑                       | 已采纳                     |
| [0014](0014-pdf-workers-exit-when-idle.md)       | PDF worker 线程按需启动，空闲 15 秒后退出                                | 已采纳                     |
| [0015](0015-deletion-set-by-geometry.md)         | 写回的删除集合按几何位置与数量确定，不按算子序号逐个匹配                 | 已废弃（被 0016 取代）     |
| [0016](0016-port-pdfmathtranslate.md)            | PDF 处理逐步照搬 PDFMathTranslate 1.9.11                                 | 已采纳（部分由 0017 修订） |
| [0017](0017-babeldoc-fixes.md)                   | 在 pdf2zh 移植上按 BabelDOC 0.6.4 修正 pdf2zh 自身的问题                 | 已采纳（由 0018 扩展）     |
| [0018](0018-port-babeldoc-features.md)           | 照搬 pdf2zh 后继版本（pdf2zh-next 2.9.0 / BabelDOC 0.6.4）的其余优点     | 已采纳                     |
