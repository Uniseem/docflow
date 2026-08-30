# Native PDF engine notices

This directory and the server image include an adapter for the following
upstream component. The engine's installed Python source remains in the
isolated virtual environment; the adapter is a separate DocFlow component.

## BabelDOC

- Project: BabelDOC, by funstory.ai / the upstream contributors.
- Selected release: **v0.6.4**.
- Release commit: `17480db9df92ddcb37349ce34b312335226e8ec9`.
- Source: https://github.com/funstory-ai/BabelDOC/tree/v0.6.4
- Source archive: https://github.com/funstory-ai/BabelDOC/archive/refs/tags/v0.6.4.tar.gz
- Upstream license: https://github.com/funstory-ai/BabelDOC/blob/v0.6.4/LICENSE
- The actual upstream license text, including its project-specific copyright
  notice, is reproduced in the adjacent `BABELDOC-LICENSE` file.

DocFlow installs the upstream Python package without editing its source files.
At runtime this adapter changes the following behavior: asset/cache paths,
translation cache initialization, paragraph translation callbacks, unsupported
vertical-text handling, and the two PDF save/font-subset helpers. The replacement
callbacks route translations to DocFlow's Rust-managed provider pools. The PDF
writer operations remain inside the supervised worker process. See `runner.py`,
`bridge.py`, and `asset_bundle.py` for the complete adaptation source.

The adapter also initializes the pinned Joblib CPU budget and threadpoolctl's
Linux libc cache without subprocess-based hardware or library discovery. The
upstream threadpoolctl package source remains unmodified.

## PyMuPDF

- Selected release: **1.26.7**.
- Source: https://github.com/pymupdf/PyMuPDF/tree/1.26.7
- Project and licensing information: https://pymupdf.readthedocs.io/en/latest/about.html
- The installed distribution's license and notices remain in the virtual
  environment alongside the package. The root project's third-party notices
  additionally identify this dependency.

## Model and font assets

The selected engine embeds asset filenames and SHA3-256 checksums in:
https://github.com/funstory-ai/BabelDOC/blob/v0.6.4/babeldoc/assets/embedding_assets_metadata.py

The asset download sources are:

- https://github.com/funstory-ai/BabelDOC-Assets
- https://huggingface.co/wybxc/DocLayout-YOLO-DocStructBench-onnx
- The upstream metadata's additional Hugging Face and ModelScope mirrors.

Those assets have their own upstream provenance and notices. These statements
identify included components; they do not determine a deployment's compliance.
