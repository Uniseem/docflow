import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from asset_bundle import READY_CONTENT, verify_asset_files, verify_bundle
from bridge import NativePdfError


class AssetTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="native-assets-test-")
        self.root = Path(self.temp.name)
        (self.root / "models").mkdir()
        (self.root / "models" / "sample.bin").write_bytes(b"model fixture, not a PDF")
        self.manifest = {
            "engine": "BabelDOC",
            "version": "0.6.4",
            "files": [
                {
                    "path": "models/sample.bin",
                    "sha3_256": hashlib.sha3_256(
                        b"model fixture, not a PDF"
                    ).hexdigest(),
                }
            ],
        }

    def tearDown(self):
        self.temp.cleanup()

    def test_checksum_is_verified(self):
        verify_asset_files(self.root, self.manifest)
        (self.root / "models" / "sample.bin").write_bytes(b"changed")
        with self.assertRaises(NativePdfError):
            verify_asset_files(self.root, self.manifest)

    def test_missing_asset_and_path_escape_fail(self):
        for name in ("models/missing.bin", "../escape.bin"):
            with self.subTest(name=name), self.assertRaises(NativePdfError):
                verify_asset_files(
                    self.root, {"files": [{"path": name, "sha3_256": "unused"}]}
                )

    def test_marker_does_not_replace_manifest_and_file_validation(self):
        with patch("asset_bundle.expected_manifest", return_value=self.manifest):
            with self.assertRaises(NativePdfError):
                verify_bundle(self.root)
            (self.root / ".ready").write_text(READY_CONTENT, encoding="ascii")
            (self.root / "manifest.json").write_text(
                json.dumps(self.manifest), encoding="utf-8"
            )
            verify_bundle(self.root)
            (self.root / "models" / "sample.bin").write_bytes(b"corrupt")
            with self.assertRaises(NativePdfError):
                verify_bundle(self.root)


if __name__ == "__main__":
    unittest.main()
