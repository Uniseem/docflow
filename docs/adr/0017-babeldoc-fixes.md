# ADR-0017：在 pdf2zh 移植上按 BabelDOC 0.6.4 修正 pdf2zh 自身的问题

- 状态：已采纳（修订 ADR-0016 的第 2–4 条与「随 pdf2zh 一起带来的行为」）
- 日期：2026-09-26
- 相关：docs/plan/03-pdf-pipeline.md §3.5–§3.9、§3.13、§3.14；worklog 2026-09-26-babeldoc-fixes

## 背景

4.0.1 照搬了 PDFMathTranslate 1.9.11（ADR-0016），它自身的问题也一起带来了：译文与公式都是黑色；原文没有换行的段落（标题、图注）译文向右溢出；行高最多压到 1.0，不缩字号，长译文压到下面的内容；小字号空格被角标规则判成公式，词间出现空隙；`Times-Italic` 这类字体名的整段文字当公式不翻译；内联图片被删；旋转页的译文错位。维护者要求修复这些问题。

维护者此前的要求是不要自己设计。所以修正也要照一个现成的实现：pdf2zh 的后继项目 BabelDOC（PDFMathTranslate 2.x 的内核），版本 0.6.4，源码逐行读过。BabelDOC 有自己的分段（`paragraph_finder`）和整页重建（IR → `PDFCreater`），整体搬过来等于换掉 pdf2zh 的分段；所以只搬 BabelDOC 里针对上述问题的部分，接在 pdf2zh 的段落与公式数据上。

## 决定

1. **颜色**（`il_creater_active.py` 的 `passthrough_per_char_instruction`）：内容流解释器执行 `sc SC scn SCN g G rg RG k K cs CS gs ri w J j M i d` 时，把算子文本记进列表（同名替换并移到末尾，`gs` 累加），随 `q/Q` 保存恢复，进表单清空；每个画字算子带上当时的列表。段落样式 = 文字字符共同的状态，不同则为空（`_merge_styles`）。写回时译文用段落样式、公式用各自的状态，包在 `q {状态} BT … ET Q` 里。
   - 一处不同：同一个 ExtGState 名重复 `gs` 时只留最后一次。每个 `gs` 只设置自己的键，结果状态相同；维护者的论文每次画图都重复 `/GS4 gs /GS3 gs`，照原样累加会让每段前面多出几千字节。
2. **排版**（`typesetting.py` 的 `Typesetting`、`TypesettingUnit`，加上 `paragraph_finder.fix_overlapping_paragraphs`）：新文件 `pdf2zh/reflow.ts`，取代 pdf2zh 的 C 部分。每段在框内重排：拉丁词不拆开、避头避尾标点、首行缩进、行距 1.5；放不下就按 0.05/0.1 缩小，低于 0.7 时先向下、再向右扩到相邻段落为止；全文取「按单元计票最多的缩放」作上限；画之前把重叠的段落框从中点切开，并与正下方段落留出间距。细节见 03 章 §3.9。
   - 套在 pdf2zh 数据上的对应关系（BabelDOC 没有这些数据，只能这样接）：段落框用 pdf2zh 段落的 `(x0, y0, x1, y1)`；首行缩进看首字符 `x − x0 > 1`；公式单元就是 `{vN}`，竖直位置沿用 pdf2zh 的 `fix`；译文字体沿用 pdf2zh 的 `tiro`/`noto`；只有公式和空白的段落按原位置重画。同样式、紧挨着的字形合成一个 `TJ`，位置与 BabelDOC 逐字 `Tj` 相同。
3. **公式字体**（`formular_helper.is_formulas_font`）：数学字体表 → 正文字体表 → 宽泛正则（去掉 `.*Ital`，`CM[^RB]`）。
4. **空格**（`il_creater` 的空白表、`styles_and_formulas` 的 `in_formula_state`、`paragraph_finder._group_characters_into_paragraphs` 与行首尾空格裁剪）：各种空白统一为空格；空格是否算公式只看前一个字符；空格不在别的版面框里开新段，也不扩段落框。
5. **内联图片**：原样留在 `ops_base`（BabelDOC 保留内联图片）。
6. **旋转**：转了 90° 的字 `size` 取框宽、按 `0 1 -1 0 x2 y Tm` 重画（BabelDOC）。旋转页的页面内容改用「页面 CTM 的逆」写回——这是 pdf2zh 自己给表单用的做法；pdf2zh 给页面写的 `1 0 0 1 x0 y0` 只在没有 `/Rotate` 时等于它。BabelDOC 忽略 `/Rotate`，按内容空间处理，横放页面里转着画的正文会被当成竖排不翻译，所以这一条不照 BabelDOC。
7. **保留 pdf2zh 的规则作对照**：`parseLayout`/`analyzePdf` 的 `strict` 选项只用 pdf2zh 的规则，单测仍与 pdf2zh 逐页比对；`typeset.ts`（pdf2zh 的 C 部分）保留并有单测，写回不再使用。分析结果版本升到 4，旧检查点会重新分析。

## 没有采用的

- **图表内文字、页眉页脚的翻译**：BabelDOC 用自己的分段（`fallback_line` 框、`abandon` 当正文）实现，与 pdf2zh 的分段不兼容。保留 pdf2zh 的版面判定。
- **其他角度的旋转字**（如出版社页边 −90° 的下载声明）：BabelDOC 直接丢掉，pdf2zh 按正立方向重画。暂时保留 pdf2zh 的做法；改成按原角度重画不是两者任何一个的做法，需要维护者决定。
- **段内多种颜色（富文本占位符）、粗体斜体字体映射**：需要改提示词与字体集，超出这次范围；段内颜色不一致时译文用默认颜色，与 BabelDOC 不开富文本时相同。
- **不可见文字（`Tr 3`）**：BabelDOC 也不处理（只有 OCR 模式整体涂白）。

## 后果

- 好处：维护者论文 61 页用长度接近真实译文的假译文写回，没有叠字，单行标题与图注在框内换行，版面检测到的彩色标题保持颜色；「dummy-space」小字号空格不再生成公式（全文公式组从数万个降到 1890 个）；旋转页译文位置正确。
- 代价：译文字号随全文上限整体缩小时比原文小；BabelDOC 的若干细节照原样带来（第二遍从预算缩放重新开始且不带第一遍扩出的框、放不下的段落不画并记 `paragraph_not_fit`、中英文间隔条件几乎不成立）；内容流里每个颜色分组多一层 `q … Q`。
- 跟进：真实大模型对照（M8-7）；旋转字的处理方式等维护者决定。
