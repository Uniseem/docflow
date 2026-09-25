# 字体

译文写回 PDF 时嵌入的字体，与 BabelDOC 0.6.4（PDFMathTranslate-next 2.9.0）对简体中文使用的字体相同，全部取自 [BabelDOC-Assets](https://github.com/funstory-ai/BabelDOC-Assets) 的 `fonts/` 目录（[ADR-0018](../../docs/adr/0018-port-babeldoc-features.md)）。选择规则照 BabelDOC 的 `FontMapper`：按原文字体的粗体、斜体、有无衬线挑选，缺字时依次换用同族其他字体与 Go Noto Kurrent。

| 字体                                     | 用途                       | 版权                                                    |
| ---------------------------------------- | -------------------------- | ------------------------------------------------------- |
| 思源宋体 Source Han Serif CN（常规、粗） | 衬线正文、标题             | © 2017-2024 Adobe，保留字体名 “Source”                  |
| 思源黑体 Source Han Sans CN（常规、粗）  | 无衬线正文；空格宽度基准   | © 2014-2021 Adobe，保留字体名 “Source”                  |
| Noto Serif / Noto Sans（常规、粗、斜）   | 拉丁字符                   | Copyright 2022 The Noto Project Authors                 |
| 霞鹜文楷 LXGW WenKai GB 1.520            | 「楷体」译文字体、斜体原文 | Copyright 2022-2025 LXGW；2020 The Klee Project Authors |
| Go Noto Kurrent（常规、粗）              | 以上字体都缺的字           | Copyright 2022 The Noto Project Authors                 |

许可证都是 SIL Open Font License 1.1（见 `LICENSE-OFL.txt`）。

| 文件                             | SHA3-256                                                           | 大小       |
| -------------------------------- | ------------------------------------------------------------------ | ---------- |
| `SourceHanSerifCN-Bold.ttf`      | `77816a54957616e140e25a36a41fc061ddb505a1107de4e6a65f561e5dcf8310` | 14,134,156 |
| `SourceHanSerifCN-Regular.ttf`   | `c8bf74da2c3b7457c9d887465b42fb6f80d3d84f361cfe5b0673a317fb1f85ad` | 14,047,768 |
| `SourceHanSansCN-Bold.ttf`       | `82314c11016a04ef03e7afd00abe0ccc8df54b922dee79abf6424f3002a31825` | 10,174,460 |
| `SourceHanSansCN-Regular.ttf`    | `b45a80cf3650bfc62aa014e58243c6325e182c4b0c5819e41a583c699cce9a8f` | 10,397,552 |
| `NotoSerif-Regular.ttf`          | `c2bbe984e65bafd3bcd38b3cb1e1344f3b7b79d6beffc7a3d883b57f8358559d` | 504,932    |
| `NotoSerif-Bold.ttf`             | `28d88d924285eadb9f9ce49f2d2b95473f89a307b226c5f6ebed87a654898312` | 506,864    |
| `NotoSans-Regular.ttf`           | `7dfe2bbf97dc04c852d1223b220b63430e6ad03b0dbb28ebe6328a20a2d45eb8` | 629,024    |
| `NotoSans-Bold.ttf`              | `ecd38d472c1cad07d8a5dffd2b5a0f72edcd40fff2b4e68d770da8f2ef343a82` | 630,964    |
| `LXGWWenKaiGB-Regular.1.520.ttf` | `0671656b00992e317f9e20610e7145b024e664ada9f272d4f8e497196af98005` | 24,903,712 |
| `NotoSans-Italic.ttf`            | `830652f61724c017e5a29a96225b484a2ccbd25f69a1b3f47e5f466a2dbed1ad` | 642,344    |
| `NotoSans-BoldItalic.ttf`        | `0b6c690a4a6b7d605b2ecbde00c7ac1a23e60feb17fa30d8b972d61ec3ff732b` | 644,340    |
| `NotoSerif-Italic.ttf`           | `9b7773c24ab8a29e3c1c03efa4ab652d051e4c209134431953463aa946d62868` | 535,340    |
| `NotoSerif-BoldItalic.ttf`       | `b69ee56af6351b2fb4fbce623f8e1c1f9fb19170686a9e5db2cf260b8cf24ac7` | 535,724    |
| `GoNotoKurrent-Regular.ttf`      | `4324a60d507c691e6efc97420647f4d2c2d86d9de35009d1c769861b76074ae6` | 15,515,760 |
| `GoNotoKurrent-Bold.ttf`         | `000b37f592477945b27b7702dcad39f73e23e140e66ddff9847eb34f32389566` | 15,303,772 |

只有 `SourceHanSerifCN-Regular.ttf` 提交在仓库里（测试 fixture 用它生成）；其余由 `npm run assets`（`scripts/fetch-assets.mjs`，`npm run dev`、`npm run build` 前自动运行）下载并核对 SHA3-256，镜像可用 `DOCFLOW_FONTS_URL` 指定。`scripts/verify-fonts.mjs` 在 `npm run check` 里核对全部文件。嵌入时用 fontkit 做子集化，最终 PDF 只带用到的字形。
