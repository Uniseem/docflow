from __future__ import annotations

import html
import re
from collections.abc import Callable
from dataclasses import dataclass

import autocorrect_py as autocorrect
import bleach
import mdformat
from markdown_it import MarkdownIt
from markdown_it.renderer import RendererHTML
from markdown_it.token import Token
from mdit_py_plugins.dollarmath import dollarmath_plugin


CODE_RE = re.compile(r"```[^\n]*\n.*?\n```|~~~[^\n]*\n.*?\n~~~|`+[^`\n]+`+", re.DOTALL)
MATH_RE = re.compile(
    r"\$\$.*?\$\$|(?<!\\)(?<!\$)\$(?!\$)(?:\\.|[^$\n])+?(?<!\\)\$",
    re.DOTALL,
)
MarkdownCallback = Callable[[str, str, str | None], None]


@dataclass(slots=True)
class RenderedArticle:
    title: str
    excerpt: str
    html: str


def _protect(text: str, pattern: re.Pattern[str], prefix: str) -> tuple[str, dict[str, str]]:
    values: dict[str, str] = {}

    def replace(match: re.Match[str]) -> str:
        token = f"DOCFLOW{prefix}{len(values):06d}TOKEN"
        values[token] = match.group(0)
        return token

    return pattern.sub(replace, text), values


def _restore(text: str, values: dict[str, str]) -> str:
    for token, value in values.items():
        text = text.replace(token, value)
    return text


def normalize_formula_delimiters(markdown: str) -> str:
    text, code = _protect(markdown, CODE_RE, "CODE")
    text = re.sub(r"\\\[(.*?)\\\]", lambda match: f"\n$$\n{match.group(1).strip()}\n$$\n", text, flags=re.DOTALL)
    text = re.sub(r"\\\((.*?)\\\)", lambda match: f"${match.group(1).strip()}$", text, flags=re.DOTALL)
    text = re.sub(r"(?m)^[ \t]*\$\$[ \t]*(.+?)[ \t]*\$\$[ \t]*$", r"$$\n\1\n$$", text)
    return _restore(text, code)


def normalize_markdown(markdown: str, *, on_event: MarkdownCallback | None = None) -> str:
    text = normalize_formula_delimiters(markdown.replace("\r\n", "\n").replace("\r", "\n"))
    if on_event:
        on_event("formula_normalized", "公式分隔符规范化完成", "行内公式使用 $...$，行间公式使用 $$...$$")
    text, math_values = _protect(text, MATH_RE, "MATH")
    if on_event:
        on_event(
            "math_protected",
            f"格式化前已保护 {len(math_values)} 个公式片段",
            "中英文间距工具和 Markdown 格式化器不会改写公式内容",
        )
    autocorrect.load_config(
        '{"rules":{"spellcheck":0,"space-dollar":0},"context":{"codeblock":0}}'
    )
    text = autocorrect.format_for(text, "md")
    if on_event:
        on_event("cjk_spacing", "中英文、数字与标点间距规范化完成", "使用 AutoCorrect，代码块与公式已排除")
    text = mdformat.text(text, options={"wrap": "no"}, extensions={"gfm"})
    if on_event:
        on_event("markdown_formatted", "GFM / CommonMark 结构格式化完成", "已规范标题、列表、表格、引用与空行")
    text = _restore(text, math_values)
    text = re.sub(r"\n{3,}", "\n\n", text).strip() + "\n"
    if on_event:
        on_event("math_restored", "公式片段已原样恢复并完成空行复核", f"规范化结果共 {len(text):,} 个字符")
    return text


class ArticleRenderer(RendererHTML):
    pass


def _math_inline(_: object, tokens: list[Token], idx: int, *args: object) -> str:
    return f'<span class="math-inline">{html.escape(tokens[idx].content)}</span>'


def _math_block(_: object, tokens: list[Token], idx: int, *args: object) -> str:
    return f'<div class="math-block">{html.escape(tokens[idx].content)}</div>\n'


def _markdown_renderer() -> MarkdownIt:
    renderer = MarkdownIt("gfm-like", {"html": True, "linkify": True, "typographer": False})
    renderer.use(dollarmath_plugin, allow_space=True, allow_digits=True)
    renderer.add_render_rule("math_inline", _math_inline)
    renderer.add_render_rule("math_block", _math_block)
    return renderer


ALLOWED_TAGS = {
    "a", "blockquote", "br", "code", "del", "details", "div", "em", "h1", "h2", "h3", "h4", "h5", "h6",
    "hr", "img", "li", "ol", "p", "pre", "span", "strong", "sub", "summary", "sup", "table", "tbody", "td",
    "th", "thead", "tr", "ul",
}
ALLOWED_ATTRIBUTES = {
    "a": ["href", "title"],
    "img": ["src", "alt", "title", "width", "height", "loading"],
    "span": ["class"],
    "div": ["class"],
    "code": ["class"],
}


def _plain_text(rendered_html: str) -> str:
    plain = bleach.clean(rendered_html, tags=[], strip=True)
    return re.sub(r"\s+", " ", html.unescape(plain)).strip()


def _extract_title(markdown: str, fallback: str) -> str:
    match = re.search(r"(?m)^#{1,2}\s+(.+?)\s*$", markdown)
    if not match:
        return fallback[:512]
    title = re.sub(r"[*_`~\[\]]", "", match.group(1)).strip()
    return (title or fallback)[:512]


def format_and_render(
    markdown: str,
    *,
    fallback_title: str,
    on_event: MarkdownCallback | None = None,
) -> RenderedArticle:
    normalized = normalize_markdown(markdown, on_event=on_event)
    normalized = re.sub(
        r"\]\(\s*(?:javascript|vbscript|data):[^\n)]*\)",
        "](#)",
        normalized,
        flags=re.IGNORECASE,
    )
    if on_event:
        on_event("unsafe_links_removed", "链接协议安全检查完成", "已拒绝 javascript、vbscript 与 data 协议")
    rendered = _markdown_renderer().render(normalized)
    if on_event:
        on_event("html_rendered", "Markdown 已渲染为 HTML", f"渲染前 Markdown 共 {len(normalized):,} 个字符")
    rendered = re.sub(r"<img\s", '<img loading="lazy" ', rendered)
    clean_html = bleach.clean(
        rendered,
        tags=ALLOWED_TAGS,
        attributes=ALLOWED_ATTRIBUTES,
        protocols={"http", "https", "mailto"},
        strip=True,
    )
    if on_event:
        on_event("html_sanitized", "HTML 白名单消毒完成", "脚本、事件属性和不安全标签不会进入最终文章")
    plain = _plain_text(clean_html)
    title = _extract_title(normalized, fallback_title)
    excerpt = (plain[:237].rstrip() + "…") if len(plain) > 240 else plain
    if on_event:
        on_event("metadata_extracted", "文章标题与摘要提取完成", f"标题：{title[:200]}；正文纯文本 {len(plain):,} 个字符")
    return RenderedArticle(
        title=title,
        excerpt=excerpt,
        html=clean_html,
    )
