"""Build-only download and verification; never invoked during translation."""

from __future__ import annotations

import argparse
import json
import shutil
import tempfile
from pathlib import Path

from asset_bundle import (
    READY_CONTENT,
    configure_storage,
    expected_manifest,
    verify_asset_files,
    verify_bundle,
)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--asset-dir", required=True, type=Path)
    parser.add_argument("--verify-only", action="store_true")
    options = parser.parse_args()
    asset_dir = options.asset_dir.resolve()
    if options.verify_only:
        verify_bundle(asset_dir)
        return 0
    asset_dir.mkdir(parents=True, exist_ok=True)
    # A previous failed build must not retain a readiness marker.
    marker = asset_dir / ".ready"
    marker.unlink(missing_ok=True)
    scratch = Path(tempfile.mkdtemp(prefix="native-assets-", dir=asset_dir.parent))
    try:
        configure_storage(asset_dir, scratch, building=True)
        from babeldoc.assets.assets import warmup

        warmup()
        manifest = expected_manifest()
        verify_asset_files(asset_dir, manifest)
        (asset_dir / "manifest.json").write_text(
            json.dumps(manifest, sort_keys=True, indent=2) + "\n", encoding="utf-8"
        )
        marker.write_text(READY_CONTENT, encoding="ascii")
        verify_bundle(asset_dir)
    finally:
        resolved = scratch.resolve()
        if (
            resolved.parent != asset_dir.parent.resolve()
            or not resolved.name.startswith("native-assets-")
        ):
            raise RuntimeError(
                "refusing to clean an unexpected build scratch directory"
            )
        shutil.rmtree(resolved)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
