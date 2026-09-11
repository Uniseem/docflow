# Third-party notices

DocFlow's own source code is released under the MIT license in `LICENSE`. That
license does not replace the licenses of the third-party software bundled with
the desktop builds. In particular, an application package that contains the
PDF 原生翻译 runtime is not an MIT-only distribution.

## Native PDF processing (bundled Python runtime)

The `pdf2zh` processing mode ("PDF 原生翻译") runs BabelDOC's layout engine,
the native PDF engine used by PDFMathTranslate-next (pdf2zh-next), in a Python
runtime bundled with the app (`engine/resources/python` on Windows,
`DocFlow.app/Contents/Resources/engine/python` on macOS). DocFlow does not run
the pdf2zh-next application or install the legacy `pdf2zh` package.

- BabelDOC **0.6.4**, GNU Affero General Public License v3.0:
  [source at the pinned tag](https://github.com/funstory-ai/BabelDOC/tree/v0.6.4),
  [license](https://github.com/funstory-ai/BabelDOC/blob/v0.6.4/LICENSE).
- PyMuPDF **1.26.7**, AGPL/commercial dual licensing; DocFlow bundles the
  open-source distribution, not a commercial license:
  [source](https://github.com/pymupdf/PyMuPDF/tree/1.26.7),
  [license](https://github.com/pymupdf/PyMuPDF/blob/1.26.7/COPYING).
- CPython **3.12.14** from
  [python-build-standalone](https://github.com/astral-sh/python-build-standalone)
  release 20260901, under the Python Software Foundation License; the
  distribution's own `LICENSE.txt` and the licenses of the libraries it links
  (OpenSSL, SQLite, zlib, libffi and others) apply.
- The remaining Python packages pinned in `engine/native-pdf/requirements.txt`
  (NumPy, SciPy, scikit-learn, ONNX Runtime, OpenCV, fontTools, HarfBuzz,
  FreeType and others) keep their upstream licenses, which are installed with
  each package.
- Windows only: the Microsoft Visual C++ runtime (`vcruntime140*.dll`,
  `msvcp140*.dll`, `concrt140.dll`, `vcomp140.dll`) is copied next to
  `python.exe` from the Visual Studio redistributable folder, as permitted for
  the redistributable files listed in the Visual Studio license terms, so the
  runtime works on PCs without the Visual C++ Redistributable installed.
- Related project, not bundled: PDFMathTranslate-next **2.9.0**,
  [source and license](https://github.com/PDFMathTranslate-next/PDFMathTranslate-next/tree/v2.9.0).

All DocFlow adapter source for this engine is in `engine/native-pdf/`; the
supervised IPC bridge and shared-pool translation code are in
`engine/src/pipeline/pdf2zh.rs` and `engine/src/pipeline/translate_native.rs`.
The runtime is assembled by `runtime/build-windows.ps1` and
`runtime/build-macos.sh`. The adapter supplies a custom translator, routes
runtime/cache paths, uses bundled offline assets, detects swallowed engine
errors, and adapts the two PDF saving/font-subsetting helpers to remain in the
supervised process and propagate failures. No provider credentials are given to
that process.

Source for these adapters and the rest of the application is available in the
[DocFlow repository](https://github.com/Uniseem/docflow). Anyone who
modifies or redistributes AGPL-covered software must preserve its notices and
satisfy its source-availability obligations. Do not remove this notice or
present the bundled AGPL software as MIT-licensed. A distribution with private
changes needs its own corresponding source offer; linking only to unmodified
upstream is not a substitute.

## Models, fonts and other runtime assets

The runtime's `pdf-assets` directory contains the CPU ONNX layout model
(DocLayout-YOLO, DocStructBench), fonts (Source Han Sans/Serif, Noto Sans/Serif,
Go Noto Kurrent, LXGW WenKai, Klee One, MaruBuri), Adobe CMaps and tiktoken data,
listed with checksums in `pdf-assets/manifest.json`. They are downloaded from the
pinned BabelDOC asset definitions and verified against the upstream SHA3-256
values. Each asset retains its upstream license (the fonts are under the SIL Open
Font License); packaging it in DocFlow does not change that license. See the
[pinned asset metadata](https://github.com/funstory-ai/BabelDOC/tree/v0.6.4/babeldoc/assets).

## Components of the engine

- [Typst](https://github.com/typst/typst) **0.15**, Apache License 2.0, typesets
  the journal PDF inside the engine. Its bundled fonts (Libertinus Serif, New
  Computer Modern, DejaVu Sans Mono) keep their own licenses (SIL OFL, GUST Font
  License, Bitstream Vera license).
- [MiTeX](https://github.com/mitex-rs/mitex) **0.2.7**, Apache License 2.0,
  vendored in `engine/typeset/mitex/`, converts LaTeX formulas to Typst.
- [KaTeX](https://github.com/KaTeX/KaTeX), MIT license (`engine/reader/katex/LICENSE`),
  renders formulas in the reading view, including its fonts.
- The Rust crates listed in `engine/Cargo.lock` (Tokio, SQLx with SQLite,
  reqwest, rustls, webpki-roots, comrak, ammonia, image, libwebp and others)
  keep their respective licenses, mostly MIT and/or Apache 2.0; webpki-roots
  carries Mozilla's CA certificate list (CDLA-Permissive-2.0). On Windows the
  engine links the Microsoft C runtime statically.
- Translation services are reached over their public HTTP APIs; no provider
  SDK is bundled. The provider presets only name each service and its
  documented API address.

## Desktop applications

- Windows: .NET (MIT), Windows App SDK / WinUI 3 (MIT; the redistributed
  runtime binaries are covered by the Windows App SDK license terms) and
  CommunityToolkit.Mvvm (MIT). Pages and PDFs are shown with the Microsoft Edge
  WebView2 runtime installed on the system; it is not bundled. The setup
  program is built with [Inno Setup](https://jrsoftware.org/isinfo.php)
  (Inno Setup License); its Chinese Simplified messages
  (`apps/windows/installer/ChineseSimplified.isl`, from Inno Setup 6.7.1's
  translations, maintained by Zhenghan Yang) are used unchanged apart from a
  UTF-8 byte order mark.
- macOS: the app uses only system frameworks (SwiftUI, AppKit, PDFKit, WebKit,
  Security, UserNotifications).
