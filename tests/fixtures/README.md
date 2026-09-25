# PDF 测试 fixture

由 `npm run fixtures`（`scripts/make-fixtures.mjs`）生成，全部提交。合成 PDF 每个小于 200 KB，使用 `@cantoo/pdf-lib` 与 14 种标准字体；`cid-font.pdf` 另外嵌入中文字体子集（现有文件用 4.0.0 的 Noto Sans SC 生成；2026-09-26 起脚本改用 `resources/fonts/SourceHanSerifCN-Regular.ttf`，重新生成后要重新导出 `pdf2zh/` 对照数据）。`pdf2zh/*.json` 是 PDFMathTranslate 1.9.11 在这些样例上的版面框与分段结果（08 章 §8.4）。

加密文件口令：`encrypted.pdf` 的用户口令是 `secret`。

## 合成文件

| 文件                  | 内容                                         | 用来测什么                                |
| --------------------- | -------------------------------------------- | ----------------------------------------- |
| `single-column.pdf`   | 3 页单栏，页眉页码，每页 4 段                | 行/段合并、页眉页脚跳过                   |
| `two-column.pdf`      | 4 页两栏，通栏标题与摘要，编号标题，参考文献 | 栏检测、阅读顺序、标题识别                |
| `inline-formula.pdf`  | 段落内 Symbol / Times-Italic 字母与上下标    | 公式项、占位符合并、上下标                |
| `display-math.pdf`    | 独立公式行 + `(3)` 编号                      | display math 不翻译                       |
| `figure-caption.pdf`  | PNG 上叠短文字，下方 `Figure 1:`             | `inside_image`、`short_isolated`、caption |
| `hyphenation.pdf`     | 行尾连字符、连字 `ﬁ`                         | 文本规整                                  |
| `long.pdf`            | 60 页单栏                                    | 性能、进度、事件上限                      |
| `encrypted.pdf`       | 用户口令 `secret`                            | `pdf_encrypted`                           |
| `scanned.pdf`         | 只有整页图片                                 | `scanned_pdf`                             |
| `empty.pdf`           | 0 页（手工最小 PDF）                         | `pdf_empty`                               |
| `colored-text.pdf`    | 红标题、蓝正文                               | 颜色提取与保留                            |
| `tj-arrays.pdf`       | `TJ` 字距、`'` / `"`、Tc/Tw/Tz               | 算子流状态机、词法分析器                  |
| `cid-font.pdf`        | Type0/Identity-H 子集 + 斜体变量             | 复合字体编码字节数、公式重绘              |
| `form-wrapped.pdf`    | 整页内容在一个 Form XObject                  | 表单递归、字体资源搬运                    |
| `shared-form.pdf`     | 两页 `Do` 同一个含文字表单（页眉 LOGO）      | shared 表单跳过                           |
| `italic-sentence.pdf` | 斜体整句 + 单个斜体变量                      | `.*Ital` 放宽规则                         |
| `invisible-text.pdf`  | 整页图片 + `3 Tr` 隐藏文字（1 页）           | 可见字形为 0，inspect 放行                |
| `ocr-scan.pdf`        | 3 页文字图片 + 同位置 `3 Tr` 文字层          | 扫描件判定（SSIM）、OCR workaround        |

## 真实论文（仅解析回归测试）

只在 `src/main/pdf/analyze.test.ts` 里使用：断言两栏分界、段落合并、图内文字等版面判定（如 LLaMA 摘要合成一段、CoT 环绕图的正文按段合并），不做精确坐标断言；字形、词法与写回的 fixture 测试都跳过 `arxiv-*`。写回与渲染效果用 `scripts/compose-pdf.mjs` 手动检查（见 worklog 2026-09-22-m3-compose、2026-09-23-m5-fixes）。许可证均为 CC-BY-4.0，允许再分发。

| 文件                   | 来源                                                                                                                       | 许可                                                      | 说明         |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------ |
| `arxiv-2201.11903.pdf` | [arXiv:2201.11903](https://arxiv.org/abs/2201.11903) Chain-of-Thought Prompting Elicits Reasoning in Large Language Models | [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/) | 两栏、含公式 |
| `arxiv-2302.13971.pdf` | [arXiv:2302.13971](https://arxiv.org/abs/2302.13971) LLaMA: Open and Efficient Foundation Language Models                  | [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/) | 两栏、含图表 |

重新生成合成 PDF：`npm run fixtures`；只生成其中几个：`npm run fixtures -- ocr-scan.pdf`。真实论文不会被该脚本覆盖。
