import app.services.translation as translation
from app.services.translation import chunk_markdown, protect_markdown, restore_markdown


def test_protects_code_math_images_and_link_destinations() -> None:
    source = "文本 `code()` 和 $x^2$。\n\n![图](https://example.com/a.webp)\n\n[资料](https://example.com)"
    protected_text, values = protect_markdown(source)

    assert "code()" not in protected_text
    assert "x^2" not in protected_text
    assert "https://example.com/a.webp" not in protected_text
    assert "资料" in protected_text
    assert restore_markdown(protected_text, values, protected_text) == source


def test_chunks_at_block_boundaries() -> None:
    source = "\n\n".join(f"第 {index} 段" + "内容" * 40 for index in range(10))
    chunks = chunk_markdown(source, 220)

    assert len(chunks) > 1
    assert all(len(chunk) <= 220 for chunk in chunks)
    assert "\n\n".join(chunks) == source


def test_never_splits_protected_placeholders() -> None:
    source = "长文本" * 24 + " $x^2$ " + "后文" * 24
    protected, values = protect_markdown(source)
    chunks = chunk_markdown(protected, 80)

    token = next(iter(values))
    assert sum(token in chunk for chunk in chunks) == 1
    assert restore_markdown("".join(chunks), values, protected) == source


def test_repairs_case_and_code_wrapping_around_placeholders() -> None:
    source = "正文 $x^2$ 结束"
    protected, values = protect_markdown(source)
    token = next(iter(values))
    translated = protected.replace(token, f"`{token.lower()}`")

    assert restore_markdown(translated, values, protected) == source


def test_translation_reports_chunk_retry_and_completion(monkeypatch) -> None:
    calls = 0
    events: list[str] = []

    def fake_call(_api_key: str, _model: str, content: str, **_kwargs) -> str:
        nonlocal calls
        calls += 1
        if calls == 1:
            return content.replace("DOCFLOWKEEP", "BROKEN")
        return content

    monkeypatch.setattr(translation, "call_deepseek", fake_call)
    result = translation.translate_markdown(
        "文本 $x^2$",
        api_key="test",
        model="test-model",
        chunk_chars=200,
        on_progress=lambda phase, *_args: events.append(phase),
    )

    assert result == "文本 $x^2$"
    assert "chunk_retry" in events
    assert "chunk_completed" in events
    assert events[-1] == "completed"
