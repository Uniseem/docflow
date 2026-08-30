# Third-party notices

DocFlow's existing repository code retains the MIT license in `LICENSE`. That
license does not replace the licenses of bundled third-party software. In
particular, the native-PDF-enabled server image is not an MIT-only distribution.

## Native PDF processing

The `pdf2zh` processing mode integrates BabelDOC's layout engine, the native PDF
engine used by PDFMathTranslate-next (pdf2zh-next). DocFlow does not run the
pdf2zh-next web application or install the legacy `pdf2zh` package.

- BabelDOC **0.6.4**, GNU Affero General Public License v3.0:
  [source at the pinned tag](https://github.com/funstory-ai/BabelDOC/tree/v0.6.4),
  [license](https://github.com/funstory-ai/BabelDOC/blob/v0.6.4/LICENSE).
- PyMuPDF **1.26.7**, AGPL/commercial dual licensing; this project bundles the
  open-source distribution, not a commercial license:
  [source](https://github.com/pymupdf/PyMuPDF/tree/1.26.7),
  [license](https://github.com/pymupdf/PyMuPDF/blob/1.26.7/COPYING).
- Related project, not directly bundled: PDFMathTranslate-next **2.9.0**,
  [source and license](https://github.com/PDFMathTranslate-next/PDFMathTranslate-next/tree/v2.9.0).

All DocFlow native adapter source is in `server/native-pdf/`; the supervised IPC
bridge and shared-pool translation code are in `server/src/pipeline/pdf2zh.rs`
and `server/src/pipeline/translate_native.rs`. Build instructions and pinned
runtime dependencies are in `server/Dockerfile` and
`server/native-pdf/requirements.txt`. The adapter supplies a custom translator,
routes runtime/cache paths, uses bundled offline assets, detects swallowed
engine errors, and adapts the two PDF saving/font-subsetting helpers to remain
in the supervised process and propagate failures. No provider credentials are
given to that process.

Source for these adapters and the rest of the application is available in the
[DocFlow repository](https://github.com/FengYuchen1314/docflow). Deployers who
modify or redistribute AGPL-covered software must preserve notices and satisfy
its applicable source-availability obligations, including for modified versions
used over a network. Do not remove this notice or present bundled AGPL software
as MIT-licensed. A deployment with private downstream changes needs its own
corresponding source offer; linking only to unmodified upstream is not a
substitute.

## Models, fonts and other dependencies

The image includes the model, fonts, CMap and tokenizer files listed in
`/opt/docflow/native-pdf/assets/manifest.json`. They are downloaded from the
pinned BabelDOC asset definitions and checked against the upstream SHA3-256
values. Each asset retains its upstream license; packaging it in DocFlow does
not change that license. See the
[pinned asset metadata](https://github.com/funstory-ai/BabelDOC/tree/v0.6.4/babeldoc/assets)
and the original asset notices. Chromium, KaTeX, Ant Design Vue, Rust crates and the
remaining Python dependencies retain their respective upstream notices.
