"""Installed-engine contracts; no PDF is created, translated or edited here."""

import importlib.util
import inspect
import io
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from asset_bundle import (
    ENGINE_VERSION,
    check_engine_version,
    configure_storage,
    expected_manifest,
)
from bridge import FailureState, JsonlWriter, PoolTranslator, TranslationBridge


@unittest.skipUnless(
    importlib.util.find_spec("babeldoc") is not None,
    "install native-pdf/requirements.txt to run engine contracts",
)
class BabelDOCContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        check_engine_version()
        cls.previous_tempdir = tempfile.tempdir
        cls.previous_environment = {
            name: os.environ.get(name)
            for name in (
                "TIKTOKEN_CACHE_DIR",
                "TMPDIR",
                "TEMP",
                "TMP",
                "HF_HUB_OFFLINE",
                "TRANSFORMERS_OFFLINE",
            )
        }
        cls.temp = tempfile.TemporaryDirectory(prefix="native-contract-")
        cls.root = Path(cls.temp.name)
        configure_storage(cls.root / "assets", cls.root / "scratch")
        from babeldoc.format.pdf import high_level
        from babeldoc.format.pdf.document_il.backend.pdf_creater import PDFCreater
        from babeldoc.format.pdf.document_il.midend.il_translator import ILTranslator
        from babeldoc.format.pdf.translation_config import TranslationConfig
        from babeldoc.progress_monitor import ProgressMonitor

        cls.high_level = high_level
        cls.creator = PDFCreater
        cls.translator = ILTranslator
        cls.config = TranslationConfig
        cls.monitor = ProgressMonitor

    @classmethod
    def tearDownClass(cls):
        tempfile.tempdir = cls.previous_tempdir
        for name, value in cls.previous_environment.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value
        cls.temp.cleanup()

    def test_version_and_explicit_injection_signatures(self):
        self.assertEqual(ENGINE_VERSION, "0.6.4")
        parameters = inspect.signature(self.config).parameters
        for name in (
            "translator",
            "doc_layout_model",
            "working_dir",
            "pool_max_workers",
            "auto_extract_glossary",
            "save_auto_extracted_glossary",
            "use_alternating_pages_dual",
            "ocr_workaround",
            "watermark_output_mode",
        ):
            self.assertIn(name, parameters)
        self.assertEqual(
            list(inspect.signature(self.high_level.do_translate).parameters),
            ["pm", "translation_config"],
        )
        self.assertIn(
            "progress_change_callback", inspect.signature(self.monitor).parameters
        )
        self.assertIn("cancel_event", inspect.signature(self.monitor).parameters)

    def test_bridged_translator_cannot_select_internal_llm_queue(self):
        bridge = TranslationBridge(
            io.BytesIO(), JsonlWriter(io.StringIO()), FailureState(), 1
        )
        self.assertFalse(
            self.high_level.translator_supports_llm(PoolTranslator(bridge))
        )
        source = inspect.getsource(self.translator.translate_paragraph)
        self.assertIn("self.translate_engine.translate(", source)
        self.assertIn('"paragraph_token_count"', source)
        self.assertIn("except Exception", source)

    def test_monkeypatched_writer_signatures_are_pinned(self):
        self.assertEqual(
            list(inspect.signature(self.creator.subset_fonts_in_subprocess).parameters),
            ["pdf", "translation_config", "tag"],
        )
        self.assertEqual(
            list(inspect.signature(self.creator.save_pdf_with_timeout).parameters),
            [
                "pdf",
                "output_path",
                "translation_config",
                "garbage",
                "deflate",
                "clean",
                "deflate_fonts",
                "linear",
                "timeout",
                "tag",
            ],
        )
        source = inspect.getsource(self.creator.write)
        self.assertIn("self.subset_fonts_in_subprocess(", source)
        self.assertIn("self.save_pdf_with_timeout(", source)

    def test_vertical_skip_guard_contract(self):
        self.assertEqual(
            list(inspect.signature(self.translator.pre_translate_paragraph).parameters),
            ["self", "paragraph", "tracker", "page_font_map", "xobj_font_map"],
        )
        source = inspect.getsource(self.translator.pre_translate_paragraph)
        self.assertIn("if paragraph.vertical:", source)

    def test_bundle_lists_model_fonts_cmaps_and_tokenizer(self):
        manifest = expected_manifest()
        self.assertEqual(manifest["version"], ENGINE_VERSION)
        self.assertEqual(
            {entry["path"].split("/")[0] for entry in manifest["files"]},
            {"models", "fonts", "cmap", "tiktoken"},
        )
        self.assertFalse(
            list(self.root.rglob("cache.v1.db")),
            "adapter must not initialize an upstream translation database",
        )


if __name__ == "__main__":
    unittest.main()
