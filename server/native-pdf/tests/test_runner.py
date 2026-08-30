import io
import logging
import math
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from bridge import FailureState, NativePdfError
from runner import (
    EngineLogGuard,
    PdfInfo,
    absolute_ascii_path,
    execute,
    install_strict_pdf_writer,
    install_vertical_text_guard,
    paragraph_has_body_text,
    preflight_pdf,
    progress_message,
    verify_output_pdf,
)


class FakePage:
    def __init__(
        self,
        text="This is a text layer with enough readable words.",
        images=None,
        width=600,
        height=800,
    ):
        self.rect = types.SimpleNamespace(
            width=width, height=height, x0=0, y0=0, x1=width, y1=height
        )
        self.get_text = Mock(return_value=text)
        self.get_image_info = Mock(return_value=images or [])


class FakeDocument:
    def __init__(self, pages, encrypted=False):
        self.pages = pages
        self.page_count = len(pages)
        self.is_encrypted = encrypted
        self.needs_pass = encrypted

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def __iter__(self):
        return iter(self.pages)


def pdf_input(pages, *, encrypted=False, header=b"%PDF-1.7"):
    # Pure in-memory fakes: these tests never generate or edit a PDF artifact.
    path = Mock(spec=Path)
    path.is_file.return_value = True
    path.open.return_value = io.BytesIO(header)
    library = types.SimpleNamespace(
        open=Mock(return_value=FakeDocument(pages, encrypted))
    )
    return path, library


class RunnerTests(unittest.TestCase):
    def test_valid_text_layer_and_blank_page(self):
        path, library = pdf_input([FakePage(), FakePage("")])
        self.assertEqual(
            preflight_pdf(path, library, FailureState()),
            PdfInfo(2, ((600.0, 800.0), (600.0, 800.0))),
        )

    def test_page_number_does_not_disguise_scan(self):
        path, library = pdf_input([FakePage("1", images=[{"bbox": (0, 0, 600, 800)}])])
        with self.assertRaisesRegex(NativePdfError, "MinerU"):
            preflight_pdf(path, library, FailureState())

    def test_missing_text_layer_is_rejected(self):
        path, library = pdf_input([FakePage("")])
        with self.assertRaisesRegex(NativePdfError, "文本层"):
            preflight_pdf(path, library, FailureState())

    def test_bad_header_is_rejected_before_open(self):
        path, library = pdf_input([FakePage()], header=b"not PDF")
        with self.assertRaises(NativePdfError):
            preflight_pdf(path, library, FailureState())
        library.open.assert_not_called()

    def test_encrypted_pdf_and_empty_pdf_fail(self):
        for pages, encrypted in (([FakePage()], True), ([], False)):
            with self.subTest(encrypted=encrypted):
                path, library = pdf_input(pages, encrypted=encrypted)
                with self.assertRaises(NativePdfError):
                    preflight_pdf(path, library, FailureState())

    def test_preflight_cancellation(self):
        path, library = pdf_input([FakePage()])
        failure = FailureState()
        failure.fail(NativePdfError("cancel", "cancelled"))
        with self.assertRaisesRegex(NativePdfError, "cancelled"):
            preflight_pdf(path, library, failure)

    def test_execute_preserves_specific_preflight_error_and_hides_unknown_errors(self):
        cases = (
            (NativePdfError("scanned_pdf", "扫描页，请改用 MinerU。"), "scanned_pdf"),
            (ValueError("PRIVATE_DOCUMENT_CONTENT"), "worker_stopped"),
        )
        for error, code in cases:
            with self.subTest(code=code), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary).resolve()
                options = types.SimpleNamespace(
                    input=str(root / "not-created.pdf"),
                    output=str(root / "final"),
                    asset_dir=str(root / "assets"),
                    workers=1,
                )
                library = types.SimpleNamespace(TOOLS=Mock())
                with (
                    patch("runner.TranslationBridge.start"),
                    patch("runner.install_safe_logging"),
                    patch("runner.check_engine_version"),
                    patch("runner.configure_storage"),
                    patch("runner.preflight_pdf", side_effect=error),
                    patch.dict(sys.modules, {"pymupdf": library}),
                    self.assertRaises(NativePdfError) as caught,
                ):
                    execute(options, Mock(), io.BytesIO())
                self.assertEqual(caught.exception.code, code)
                self.assertNotIn("PRIVATE_DOCUMENT_CONTENT", str(caught.exception))
                if code == "scanned_pdf":
                    self.assertIn("MinerU", str(caught.exception))
                self.assertEqual(list(root.iterdir()), [])

    def test_output_pages_and_geometry_must_match(self):
        expected = PdfInfo(1, ((600, 800),))
        path, library = pdf_input([FakePage(), FakePage()])
        verify_output_pdf(path, expected, 2, library)
        path, library = pdf_input([FakePage()])
        with self.assertRaises(NativePdfError):
            verify_output_pdf(path, expected, 2, library)
        path, library = pdf_input([FakePage(width=900)])
        with self.assertRaises(NativePdfError):
            verify_output_pdf(path, expected, 1, library)

    def test_progress_uses_only_declared_fields(self):
        message = progress_message(
            {
                "type": "progress_update",
                "stage": "Translate Paragraphs",
                "stage_current": 2,
                "stage_total": 5,
                "stage_progress": 40.0,
                "extra": "unused",
            }
        )
        self.assertEqual(
            message,
            {
                "type": "progress",
                "stage": "Translate Paragraphs",
                "current": 2,
                "total": 5,
                "percent": 40.0,
            },
        )
        self.assertIsNone(progress_message({"type": "stage_summary"}))
        with self.assertRaises(NativePdfError):
            progress_message(
                {
                    "type": "progress_update",
                    "stage": "stage",
                    "stage_current": 0,
                    "stage_total": 1,
                    "stage_progress": math.nan,
                }
            )

    def test_swallowed_engine_error_fails_without_formatting_private_text(self):
        class DoNotFormat:
            def __str__(self):
                raise AssertionError("source text must not be formatted")

        failure = FailureState()
        guard = EngineLogGuard(failure)
        record = logging.LogRecord(
            "babeldoc.format.pdf.document_il.midend.il_translator",
            logging.ERROR,
            "engine.py",
            1,
            DoNotFormat(),
            (),
            None,
        )
        guard.emit(record)
        self.assertTrue(failure.failed)

    def test_swallowed_layout_warning_is_fatal(self):
        failure = FailureState()
        record = logging.LogRecord(
            "babeldoc.format.pdf.document_il.midend.typesetting",
            logging.WARNING,
            "engine.py",
            1,
            "private details",
            (),
            None,
        )
        EngineLogGuard(failure).emit(record)
        self.assertTrue(failure.failed)

    def test_pdf_writer_uses_current_process_and_fails_closed(self):
        creator = type("FakeCreator", (), {})
        failure = FailureState()
        install_strict_pdf_writer(creator, failure)
        pdf, config = Mock(), Mock()
        with patch(
            "multiprocessing.Process", side_effect=AssertionError("no grandchildren")
        ):
            self.assertIs(creator.subset_fonts_in_subprocess(pdf, config, "mono"), pdf)
            self.assertTrue(
                creator.save_pdf_with_timeout(pdf, "not-created.pdf", config)
            )
        pdf.subset_fonts.assert_called_once_with(fallback=False)
        pdf.save.assert_called_once()
        pdf.save.side_effect = ValueError("PRIVATE_SOURCE")
        with self.assertRaises(NativePdfError) as caught:
            creator.save_pdf_with_timeout(pdf, "not-created.pdf", config)
        self.assertTrue(failure.failed)
        self.assertNotIn("PRIVATE_SOURCE", str(caught.exception))

    def test_non_ascii_or_relative_paths_are_rejected(self):
        for value in ("relative.pdf", "C:/私有/input.pdf"):
            with self.subTest(value=value), self.assertRaises(NativePdfError):
                absolute_ascii_path(value)

    def test_vertical_body_fails_but_numbers_and_formulas_are_skipped(self):
        original = Mock(return_value=(None, None))
        translator_class = type(
            "FakeTranslator", (), {"pre_translate_paragraph": original}
        )
        failure = FailureState()
        install_vertical_text_guard(translator_class, failure)
        for text, formula in (("123.4", False), ("x + y = z", True), ("", False)):
            paragraph = types.SimpleNamespace(
                vertical=True,
                unicode=text,
                pdf_paragraph_composition=[types.SimpleNamespace(pdf_formula=object())]
                if formula
                else [],
            )
            self.assertFalse(paragraph_has_body_text(paragraph))
            self.assertEqual(
                translator_class().pre_translate_paragraph(paragraph, None, {}, {}),
                (None, None),
            )
        body = types.SimpleNamespace(
            vertical=True, unicode="中文正文", pdf_paragraph_composition=[]
        )
        with self.assertRaisesRegex(NativePdfError, "MinerU"):
            translator_class().pre_translate_paragraph(body, None, {}, {})
        self.assertTrue(failure.failed)

    def test_formula_and_body_mixture_still_counts_as_body(self):
        paragraph = types.SimpleNamespace(
            unicode="x + body",
            pdf_paragraph_composition=[
                types.SimpleNamespace(pdf_formula=object()),
                types.SimpleNamespace(
                    pdf_character=types.SimpleNamespace(char_unicode="A")
                ),
            ],
        )
        self.assertTrue(paragraph_has_body_text(paragraph))


if __name__ == "__main__":
    unittest.main()
