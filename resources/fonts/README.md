# 字体

译文写回 PDF 时嵌入的中文字体：思源宋体（Source Han Serif CN Regular，版本 2.003），与 PDFMathTranslate（pdf2zh）1.9.11 对简体中文使用的字体相同，取自 [BabelDOC-Assets](https://github.com/funstory-ai/BabelDOC-Assets) 的 `fonts/SourceHanSerifCN-Regular.ttf`。版权 © 2017-2024 Adobe，许可证 SIL Open Font License 1.1（见 `LICENSE-OFL.txt`）。拉丁字符按 pdf2zh 的做法用 PDF 标准字体 Times-Roman，不需要字体文件。

| 文件                           | SHA-256                                                            | 大小       |
| ------------------------------ | ------------------------------------------------------------------ | ---------- |
| `SourceHanSerifCN-Regular.ttf` | `8ba5ec09db04b1d1599edeff3fb5627ca11eaaf85e339e5c32684cb94e806993` | 14,047,768 |

嵌入时用 fontkit 做子集化，最终 PDF 只带用到的字形。`scripts/verify-fonts.mjs` 会在 `npm run check` 里核对以上校验和。
