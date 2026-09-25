# ADR-0018：照搬 pdf2zh 后继版本（PDFMathTranslate-next 2.9.0 / BabelDOC 0.6.4）的其余优点

- 状态：已采纳（扩展 ADR-0017；修订 ADR-0016 第 5 条「翻译请求照抄 pdf2zh」）
- 日期：2026-09-25
- 相关：09 章 M10；03 章 §3.7–§3.9、§3.16；04 章 §4.12；05 章；06 章；worklog 2026-09-25-babeldoc-port

## 背景

ADR-0017 只从 BabelDOC 搬了修 pdf2zh 毛病的部分（颜色、排版、公式字体、空格、内联图片、旋转页）。维护者要求「把后继版本的优点也都搞过来，之后发布」。pdf2zh 的后继是 PDFMathTranslate-next（`pdf2zh-next`，当前 2.9.0），它的内核是 BabelDOC（当前 0.6.4，两者都是 PyPI 上的最新版，源码逐行读过）。与 DocFlow 4.0.1 相比，用户能感到的优点有：

1. 翻译：多段合成一个 JSON 请求（`ILTranslatorLLMOnly`），带全文标题与最近标题作上下文，跨页、跨栏断开的正文段放进同一请求；译文与原文相同、长度异常时逐段回退；太短、纯数字、只有公式的段不送翻译。
2. 术语：先让大模型从全文抽取术语并统一译法（`AutomaticTermExtractor`），翻译时把命中的术语表放进提示词；也可以导入用户术语表（CSV）。
3. 富文本与字体：段内颜色、粗体、字体不同的片段用 `<style id='N'>…</style>` 占位符送翻译，译文按片段恢复样式；按原字体的粗体、斜体、衬线映射到思源宋体、思源黑体（常规、粗体）、霞鹜文楷，缺字用 Go Noto Kurrent；没有翻译的段落用原字形原样画。
4. 输出：双语 PDF 默认左右并排（可选交替页、译文在前），并迁移书签；可以只翻译指定页码，只输出这些页。
5. 扫描件：带 OCR 文字层的扫描件可以翻译（译文黑色、段落铺白底）。

维护者一贯的要求是不自己设计，照现成实现搬。所以这些都照 BabelDOC / pdf2zh-next 的代码移植，接在 pdf2zh 的分段数据上（与 ADR-0017 相同的做法）。

## 决定

### 1. 翻译（`src/main/translate/babeldoc/`）

- 照搬 `il_translator_llm_only.py` 与 `il_translator.py`：
  - 分批：先把相邻两页中「上一页最后一个正文段 + 下一页第一个正文段」成对提交（跨页），再在每页内把相邻两个正文段中后一段顶边比前一段高 20 pt 以上的成对提交（跨栏），其余段按页顺序累积，累计 token > 200 或段数 > 5 时提交一批。正文段 = 版面类别 `text`/`plain text`/`paragraph_hybrid`。
  - 过滤：竖排段、空段、纯数字段（`^-?\d+(\.\d+)?$`）、只有占位符与空白的段、80% 以上是 `(cid:N)` 的段、文字少于 `min_text_length`（5）个字符的段不送翻译，按原文原样画。
  - 提示词、JSON 输入输出格式、`_clean_json_output`、上下文（全文第一个 `title` 段与最近一个 `title` 段）、术语表块原文照抄；只发一条 user 消息。`custom_system_prompt` 对应设置里的「自定义角色提示词」，为空时用 BabelDOC 的默认角色。目标语言写 `zh-CN`（pdf2zh-next 界面选「简体中文」时传给 BabelDOC 的值）。
  - 批量结果逐项检查：条数不符或 JSON 解析失败 → 整批逐段回退；某项与原文相同且 > 10 token、token 比不在 (0.3, 3)、编辑距离 < 5 且 > 20 token → 该段逐段回退；`[. 。…，]{20,}` 换成 `.`。回退用 `ILTranslator` 的单段提示词，再失败保留原文。
  - token 计数用 o200k_base（BabelDOC 的 `tiktoken.encoding_for_model("gpt-4o")`），实现为 `gpt-tokenizer`（纯 JS，MIT，作为 devDependency 打进主进程包）。
  - 回复先 `strip()` 再去掉开头的 `<think>…</think>`（pdf2zh-next `_remove_cot_content`）。
  - 不开 JSON mode、不发温度（pdf2zh-next 两者默认都不发；与 ADR-0011 一致）。
- 服务商、Key 轮换、重试阶梯、并发池沿用 DocFlow（ADR-0016 已定）。结束整份文档的错误（取消、凭据、致命、重试耗尽、连续拒绝）照旧；其余错误（JSON 不合法、条数不符、拒答、超长）走 BabelDOC 的回退。
- 缓存：键为完整提示词（BabelDOC `llm_translate` 的缓存键），指纹加上模型与角色提示词。
- 设置迁移：`translation.systemPrompt` 改为 BabelDOC 的自定义角色提示词，默认为空；4.0.x 的默认 pdf2zh 模板与 4.0.0 的旧提示词读设置时清空。

### 2. 术语表（`src/main/translate/babeldoc/glossary.ts`、`terms.ts`）

- `Glossary`：CSV 列 `source,target[,tgt_lng]`，`tgt_lng` 非空且规范化后不等于 `zh_cn` 的行跳过；按「小写 + 空白合并」去重；匹配为忽略 ASCII 大小写的子串匹配（hyperscan `HS_FLAG_CASELESS`，未开 UTF8/UCP），文本先把连续空白换成一个空格。
- `AutomaticTermExtractor`：翻译前按页累积可翻译段（累计 token > 600 或段数 > 12 提交），提示词原文照抄，用户术语表命中项作参考；结果按「每个原文取出现最多的译文」合成自动术语表。开启自动提取且得到了自动术语表时，翻译提示词只用自动术语表，否则用用户术语表（BabelDOC `get_glossaries_for_translation`）。
- 默认开启自动提取（pdf2zh-next 默认）；设置里可关。自动术语表写进检查点（续跑不重抽），完成后随文档保存为 `output/glossary.csv`（BabelDOC `save_auto_extracted_glossary`），文档详情可导出。
- 用户术语表在设置里导入 CSV（复制到文档库 `glossaries/<id>.csv`），可启用、停用、删除；新任务使用提交时启用的术语表。

### 3. 富文本与字体映射

- 分段（`parse.ts`）除 `sstk` 外为每段记下组成：文字字符（带样式序号）、pdf2zh 补的空格（虚字符）、公式序号；样式 = `(字体资源名, 字号, 图形状态)`，同样式判定照 BabelDOC `is_same_style`（字号差 < 0.02）。段落基准样式照 `_calculate_base_style`（交集，字体、字号不同时取众数）。段落的版面类别（模型框名）一并记下。分析结果版本升到 5。
- 原字体的粗体、斜体、等宽、衬线：用 MuPDF.js `new Font(name, 内嵌字体)` 读取（BabelDOC 用 PyMuPDF 的同一套 MuPDF 函数，两个 arXiv 样例上逐个字体结果相同）；没有内嵌字体的，`pymupdf.Font(fontbuffer=b"")` 实际得到 MuPDF 内置的 Noto Serif Regular（PyMuPDF 1.28.2 实测），即常规衬线；内嵌字体加载失败时四项为空（BabelDOC 记为 None），映射时按常规无衬线处理。
- 送翻译的文本照 `get_translate_input`：公式为 `{vN}`，与基准样式不同（且不是只差字号 0.7–1.3 倍、也不是只差字体但映射到同一字体）的同样式片段包成 `<style id='N'>…</style>`，编号在段内从 1 起（公式 +1，样式 +2），与原文冲突时顺延；占位符超过 40 个时本段不用样式占位符。译文照 `parse_translate_output` 拆回：公式、带样式的片段、基准样式的文字；样式片段内文字去掉空格后与原文相同的，用原字形。模型编造的同形占位符删掉。
- 字体：照 `FontMapper` 与 BabelDOC 简体中文字体族：正文 思源宋体 CN 粗体/常规、思源黑体 CN 粗体/常规；手写（原字体为斜体时）霞鹜文楷 GB；回退 Go Noto Kurrent 常规/粗体；`base` 为思源黑体常规（首行缩进、中英间隔用它量「你」的宽度）。拉丁字符也走映射，不再用 Times-Roman（BabelDOC 相同）。设置「译文字体」对应 `primary_font_family`：自动（默认）/ 衬线 / 无衬线 / 手写。只嵌入用到的字体（子集）。
- 排版单元：原字形单元（BabelDOC `TypesettingUnit(char=…)`）宽高取原字形框，重排时按缩放搬动；一段全是原字形（没翻译的段）时整段原样画（`can_passthrough`）。译文单元的字号取其样式的字号，颜色取其样式的图形状态。
- 字体文件从 BabelDOC-Assets（GitHub，`raw.githubusercontent.com/funstory-ai/BabelDOC-Assets`）下载并按 BabelDOC 元数据的 SHA3-256 校验：`scripts/fetch-assets.mjs`（`npm run assets`，`predev`/`prebuild` 自动运行，CI 缓存），不提交进 git；已提交的思源宋体常规与 BabelDOC 的同一文件（SHA3 一致）保留。安装包随带全部 7 个字体（约 +96 MB 未压缩）。

### 4. 输出

- 双语 PDF 照 `create_side_by_side_dual_pdf`：默认左右并排（原文在左），可选交替页（`create_alternating_pages_dual_pdf`）；「译文在前」对应 `dual_translate_first`。并排时新页宽 = 两页显示宽之和、高 = 两者较大值，按页面旋转摆正；书签照 `migrate_toc` 迁移（交替页保留原文档书签，与 BabelDOC 用 `insert_file` 的结果相同）。
- 页码范围照 `parse_pages`（`1-3,5,8-`、`-3`）：只对所选页做版面检测、分析、翻译与写回，其余页原样；「只输出所选页」对应 `only_include_translated_page`，中文与双语 PDF 都删去其余页，书签只留指向保留页的条目。页码范围与该开关在新建翻译时按文档填写，存进 manifest `options`。

### 5. 扫描件

- inspect 只在完全没有文字（`textChars == 0`）时报 `scanned_pdf`；原来「可见字形太少」的判定去掉，改由分析阶段照 `DetectScannedFile` 判定：对所选页 72 dpi 渲染（MuPDF.js，灰度），去掉全部文字算子后再渲染，SSIM（skimage 默认：7×7 均匀窗、样本协方差、K1 0.01、K2 0.03、data_range 255）> 0.95 记为扫描页；提前结束的条件照抄；扫描页 ≥ 80% 为扫描件。
- 设置「自动处理带文字层的扫描件」对应 `auto_enable_ocr_workaround`（默认关，与 pdf2zh-next 相同）：关时报 `scanned_pdf`（文案提示可以打开这个设置）；开时启用 OCR workaround：每段画白底（段落框与其版面框的并集，线宽 0.1），译文一律黑色，不用样式占位符。

## 没有采用的

- BabelDOC 自己的解析器与分段（`new_parser`、`ParagraphFinder`），以及依赖它们的「带行号稿件合并」（`merge_alternating_line_numbers`）、「删段内非公式线」（`remove_non_formula_lines`）、图表区保护阈值：pdf2zh 的分段不产生这些数据（与 ADR-0017 相同的理由）。
- 表格文字翻译：BabelDOC 0.6.x 已退役（`table_model` 被忽略）。
- 水印、拆分长文档（`max_pages_per_part`）、`enhance_compatibility`/`skip_clean`（PyMuPDF 保存选项）、公式占位符提示（两者默认都关）、内容安全提示段（只针对某一家服务商的中文报错）、术语抽取单独指定翻译服务。
- 转了 90° 以外角度的字（M9-6）：BabelDOC 丢弃这些字，不是优点，仍按 pdf2zh 的做法，等维护者决定。

## 后果

- 好处：请求数约降到原来的 1/5，每批带上下文与术语，译名前后一致；粗体、彩色链接等段内格式保留；没翻译的作者名、数字、短标签与原文一模一样；双语对照可以左右并排看；可以只翻几页；带 OCR 文字层的扫描件能处理。
- 代价：安装包增大约 50 MB（字体）；自动术语抽取多一轮请求（可关）；译文里的拉丁字母改用思源字体的拉丁字形（BabelDOC 相同）；分析结果变大（每个文字字符都要记下以便原样重画）；旧版本的检查点（分析 v4、翻译缓存）会重新计算。
- 跟进：真实大模型对照（M8-7 并入 M10-8）；旋转字仍等维护者决定（M9-6）。
