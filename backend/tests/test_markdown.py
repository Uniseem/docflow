from app.services.markdown import format_and_render, normalize_markdown


def test_normalizes_cjk_spacing_and_formula_delimiters() -> None:
    source = "# API标题\n\n中文DeepSeek混排，公式 \\(x^2 + 1\\)。\n\n\\[a+b=c\\]\n\n`中文code`"
    result = normalize_markdown(source)

    assert "API 标题" in result
    assert "中文 DeepSeek 混排" in result
    assert "$x^2 + 1$" in result
    assert "$$\na+b=c\n$$" in result
    assert "`中文code`" in result


def test_renders_math_and_strips_raw_html() -> None:
    article = format_and_render(
        "# 标题\n\n<script>alert(1)</script>\n\n行内 $x^2$。\n\n$$\na+b=c\n$$",
        fallback_title="备用标题",
    )

    assert article.title == "标题"
    assert "<script" not in article.html
    assert "math-inline" in article.html
    assert "math-block" in article.html
    assert "x^2" in article.html


def test_sanitizes_dangerous_links() -> None:
    article = format_and_render("[危险](javascript:alert(1))", fallback_title="测试")
    assert "javascript:" not in article.html


def test_keeps_localized_html_images() -> None:
    article = format_and_render(
        '<img src="/media/doc/images/chart.webp" alt="图表">',
        fallback_title="测试",
    )
    assert 'src="/media/doc/images/chart.webp"' in article.html
