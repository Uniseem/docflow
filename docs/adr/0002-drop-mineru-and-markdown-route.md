# ADR-0002：移除 MinerU、Markdown 阅读视图与期刊 PDF 路线

- 状态：已采纳
- 日期：2026-09-21
- 相关：docs/plan/01-goals-and-scope.md

## 背景

3.x 有两条处理路线：「PDF 原生翻译」（BabelDOC）和「MinerU 解析翻译」（上传到 mineru.net 做 OCR/版面解析，得到 Markdown，翻译后用 KaTeX 阅读视图展示，并用 Typst + MiTeX 排成 A4 期刊风格 PDF）。第二条路线支撑了 Office 文档、图片、网页和扫描件。用户明确表示不再需要 MinerU。

## 决定

- 4.0 只保留一条路线：**带文本层的 PDF → 中文 PDF + 双语对照 PDF**。
- 删除：MinerU 上传/轮询、Markdown 归一化与翻译、KaTeX 阅读视图、Typst/MiTeX 排版、WebP 图片本地化、`mineru_*` 事件与设置项、「文档解析」设置页。
- 输入只接受 `.pdf`；扫描件（无文本层）、加密 PDF 直接报错并说明原因，不做 OCR。

## 备选方案

- 保留 MinerU 作为扫描件的兜底：要维护第二套流水线和一整页设置，与用户诉求相反。放弃。
- 本地 OCR（tesseract.js）：质量差、慢、包大，且与「保留原版式」目标冲突。留作将来可能的 ADR。

## 后果

- 好处：代码量减半；没有云端解析的隐私和费用问题；界面只剩一个「新建翻译」流程。
- 代价：Office / 图片 / 扫描件不再支持；需要在拖入时明确提示。
- 跟进：如将来要支持 DOCX，优先考虑「DOCX → PDF（用户自行导出）」而不是恢复 MinerU。
