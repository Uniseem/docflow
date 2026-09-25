# PDFMathTranslate（pdf2zh 1.x）处理逻辑笔记

> 仓库：https://github.com/PDFMathTranslate/PDFMathTranslate（EMNLP 2025 Demo；AGPL-3.0 许可，我们按它的行为用 TypeScript 重新实现，不复制代码）。读的是 2026-09 的 `main` 分支，以函数名为准。4.0 的 PDF 流水线（`docs/plan/03-pdf-pipeline.md`）以它为蓝本。

## 文件分工

| 文件                   | 作用                                                                                                                                                                                                                                                           |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pdf2zh/high_level.py` | 主流程 `translate_patch` / `translate_stream`：逐页渲染位图 → DocLayout-YOLO → 版面矩阵 → 解释内容流 → 收集补丁 → 写回 PyMuPDF → 字体子集化 → mono/dual                                                                                                        |
| `pdf2zh/pdfinterp.py`  | `PDFPageInterpreterEx`：pdfminer 解释器的子类，执行时把非文字算子重新序列化成 `ops_base` 字符串；处理表单 XObject 递归与逆矩阵回写                                                                                                                             |
| `pdf2zh/converter.py`  | `TranslateConverter.receive_layout`：A 解析段落与公式、B 并发翻译、C 生成新文字指令 `ops_new`                                                                                                                                                                  |
| `pdf2zh/doclayout.py`  | ONNX 版面模型封装                                                                                                                                                                                                                                              |
| `pdf2zh/translator.py` | 各翻译服务；默认提示词 `You are a professional, authentic machine translation engine. Only Output the translated text, do not include any other text. Translate the following markdown source text to {lang_out}. Keep the formula notation {v*} unchanged. …` |

## 版面矩阵（high_level.py `translate_patch`）

- 每页 `get_pixmap()` 渲染成图，`model.predict(image, imgsz=int(h/32)*32)` 得到框。
- `box = np.ones((h, w))`：默认类别 1（不在任何框里的文字）；非保留类的框依次填 `i + 2`（每个文本框一个类别 = 一个段落）；保留类 `vcls = ["abandon", "figure", "table", "isolate_formula", "formula_caption"]` 填 0。
- 每个字符按其 `(x0, y0)` 落在哪个格子决定 `cls`；`cls == 0` 的字符一律当公式（原位重绘）。

## 解析（converter.py `receive_layout` 第 A 部分）

- 遍历 pdfminer 的 `LTChar`（**内容流顺序**，不排序）。`render_char` 被重载，把 `cid` 和 `font` 挂到 `LTChar` 上；`init_resources` 把每个字体的 `descent` 强制为 0，所以 `char.y0` 就是基线。
- 段落切换：`cls != xt_cls` 就开新段（`sstk.append("")`，`pstk.append(Paragraph(y, x, x0, x1, y0, y1, size, brk=False))`）。
- 空格：同段内 `child.x0 > xt.x1 + 1` 加空格；`child.x1 < xt.x0`（回到左边 = 换行）加空格并 `brk = True`。
- 段落字号：遇到更大的字符或段落第二个字符时更新 `size`，并把 `y` 上移 `child.size − size`（假设顶对齐，处理首字放大）。
- 公式判定 `cur_v`（任一）：`cls == 0`；同段且已有 > 1 个字符且 `child.size < pstk[-1].size * 0.79`（角标）；`vflag(fontname, char)`；`matrix[0] == 0 and matrix[3] == 0`（竖排）。括号：`vstk` 非空时的 `(` 计入公式并 `vbkt += 1`；`vbkt > 0` 时的 `)` 计入并 `-= 1`。
- `vflag`：字体名取 `+` 之后；`(cid:` 开头的未知字符 → True；字体正则 `(CM[^R]|MS.M|XY|MT|BL|RM|EU|LA|RS|LINE|LCIRCLE|TeX-|rsfs|txsy|wasy|stmary|.*Mono|.*Code|.*Ital|.*Sym|.*Math)`（`re.match`，锚定开头）；字符类别 `unicodedata.category` ∈ `Lm Mn Sk Sm Zl Zp Zs`（排除普通空格）或码点 `0x370–0x400`。
- 公式结束（任一）：当前字符非公式；`cls` 变化；段落已有文字且 `|child.x0 − xt.x0| > vmax（页宽/4）`（文字段落里的公式跨行就切断）。结束时 `sstk[-1] += "{v%d}"`，把字符列表、线条列表、`vfix` 压栈；若段落此时还是空串（纯公式段），令 `xt_cls = -1` 阻止后续字符并入。
- `vfix`（纵向修正）：公式右侧第一个同段文字字符 `child` 出现时 `vfix = vstk[0].y0 − child.y0`；或公式第一个字符时用左侧文字 `vfix = child.y0 − xt.y0`。
- 线条：`pdfinterp.do_S` 只把「两点、水平、黑色描边」的路径当作 `LTLine` 交给 device 并从 `ops_base` 里去掉（返回 `n`）；其余路径保留在 `ops_base`。落在公式里（`vstk` 非空且同段）的线进 `vlstk`（分式横线），否则进全局 `lstk`，最后原位重绘。
- 公式宽度 `vlen[id] = max(x1) − v[0].x0`。

## 翻译（第 B 部分）

`ThreadPoolExecutor(max_workers=thread)` 对每个段落字符串调用 `translator.translate`；空白或 `^\{v\d+\}$`（纯公式段）直接原样返回。译文中 `{v N}` 允许带空格（`\{\s*v([\d\s]+)\}`），越界的编号被忽略。

## 写回（第 C 部分 + pdfinterp）

- 字体：`tiro`（PyMuPDF 内置 Times）给拉丁字符，`noto`（GoNotoKurrent 或按语言选的字体）给其他；`high_level.translate_stream` 把这两个字体名插入**每个** xref 的 `Resources/Font` 字典，所以任何流都能引用。
- 逐段：从段落 `(x, y)`（首字符位置，y 经首字放大修正）开始，逐字符累加宽度 `adv`（`noto.char_lengths(ch, size)` 或 `fontmap[font].char_width(ord(ch)) * size`）；遇到 `{vN}` 用 `vlen[N]` 作为宽度，并把该公式的每个字符按 `x + (vch.x0 − v[0].x0)`、`y + fix + (vch.y0 − v[0].y0)` 用**原字体资源名** `fontid[vch.font]`、原字号 `vch.size`、原 `cid`（CID 字体 4 位十六进制，否则 2 位）生成 `Tj`；`fix = varf[N]` 仅在公式不是段首时应用。
- 换行：`x + adv > x1 + 0.1 * size` 时刷新缓冲；**只有 `brk` 为真（原文有换行）才换行**（`x = x0; lidx += 1`），单行段落不换行，直接向右溢出。行首空格丢弃。
- 行高：中文 `1.4`，`while (lidx + 1) * size * line_height > height and line_height >= 1: line_height -= 0.05`；每行 y = `y − lidx * size * line_height`。
- 指令：`BT /font size Tf 1 0 0 1 x y Tm [<hex>] TJ … ET`；线条 `ET q 1 0 0 1 x y cm [] 0 d 0 J w w 0 0 m dx dy l S Q BT`。
- 页面内容：`q {ops_base} Q 1 0 0 1 x0 y0 cm {ops_new}`（`ops_base` 是 `execute` 重建的字符串：过滤掉所有 `T` 开头算子、`'`、`"`、`EI`/`BI`/`ID`、`MP DP BMC BDC EMC`）。原 `Contents` 流全部清空，新建一个 xref 放新流。
- 表单：`do_Do` 对 Form 递归 `render_contents`，`end_figure` 产生该表单的 `ops_new`，用 CTM 逆矩阵把页面坐标的指令变回表单坐标：`q {ops_base} Q a b c d e f cm {ops_new}` 写回表单流。
- 颜色：没有处理，新文字使用默认填充色。
- 收尾：`doc_zh.subset_fonts(fallback=True)`；dual = 交替插入原页与译页。

## 与 DocFlow 的关系

4.0.0 只「参照思路」：几何规则代替版面模型、只删被翻译段落的指令、按框宽换行并缩字号、保留颜色。真实论文里原文残留、与译文重叠，2026-09-26 起改为逐函数照搬本笔记描述的 1.9.11 行为（[ADR-0016](../adr/0016-port-pdfmathtranslate.md)，03 章），代码在 `src/main/pdf/pdf2zh/`，与 pdf2zh 的差异只剩实现层面，见 03 章 §3.13。pdf2zh 是 AGPL-3.0：移植按它的行为用 TypeScript 重写，不复制源码。

对照方法：在开发机上建独立的 Python 虚拟环境装 `pdf2zh==1.9.11`（Python 3.13 需 `--ignore-requires-python`；`tencentcloud-sdk-python-tmt` 要锁到 3.0.1478，否则 import 失败），用假翻译器替换 `pdf2zh.converter.GoogleTranslator`，用 `sys.settrace` 在 `receive_layout` 返回时取 `sstk`、`pstk`、`var` 等局部变量，把 `OnnxModel.predict` 的输入图与输出框一起导出。`tests/fixtures/pdf2zh/*.json` 就是这样得到的（worklog 2026-09-26-pdf2zh-port）。
