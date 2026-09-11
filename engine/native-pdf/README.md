# Native PDF worker

The user-facing route is **PDF 原生翻译（pdf2zh）**. This adapter uses
`babeldoc==0.6.4`, the PDF layout engine underneath pdf2zh-next; it does not start
the pdf2zh/next CLI, HTTP server, Celery worker, or provider clients. BabelDOC
describes its Python APIs as internal, so the engine and layout-critical
dependencies are pinned and installed-engine contracts run whenever the bundled
runtime is built (`runtime/build-windows.ps1`, `runtime/build-macos.sh`).

## Runtime contract

```text
<resources>/python/python.exe -s -B <library>/native-pdf/runner.py \
  --input <source.pdf> \
  --output <library>/work/<document>/final \
  --workers 16 \
  --asset-dir <resources>/pdf-assets
```

`<resources>` is the app's runtime directory (`python/bin/python3` on macOS) and
`<library>` the document library; the engine installs `runner.py` and its
modules there. The process gets an empty environment apart from `PATH` and the
locale variables, with `TEMP`/`TMP`/`TMPDIR` pointing into the attempt's own
folder, so it inherits no credentials and never writes to a profile folder.

Input, output and asset paths must be ASCII absolute paths. On Windows, when the
library or the app lives under a non-ASCII path (a Chinese user name, say), the
engine runs attempts in a per-library folder under `%ProgramData%\DocFlow\work`
created with an owner-only ACL, copies the source there, and uses a hard-linked
(or copied) mirror of the assets under `%ProgramData%\DocFlow\pdf-assets`. The
parent output directory must exist. Existing nonempty output directories are never overwritten.
All temporary data is kept below the output's parent directory. The runner emits
only UTF-8 JSONL on stdout, with lines at most 1 MiB and callback text at most
200,000 Unicode characters:

| Direction | Message |
| --- | --- |
| Worker → Rust | `{"type":"ready","pages":2,"engine":"BabelDOC","version":"0.6.4"}` |
| Worker → Rust | `{"type":"translate","request_id":1,"text":"Source {v0}"}` |
| Rust → worker | `{"type":"translation","request_id":1,"text":"译文 {v0}"}` |
| Rust → worker | `{"type":"error","request_id":1,"message":"Provider failed"}` |
| Worker → Rust | `{"type":"progress","stage":"Translate Paragraphs","current":1,"total":3,"percent":33.3}` |
| Worker → Rust | `{"type":"result","mono":"mono.pdf","dual":"dual.pdf","pages":2}` |
| Worker → Rust | `{"type":"error","message":"Safe, document-free error","code":"scanned_pdf"}` |

The final dual PDF alternates original and translated pages; its page count is
twice that of the mono PDF. A result is emitted only after both files pass page
count, geometry and readability checks and every callback has completed. On
receipt of that result, the parent closes stdin to acknowledge completion. The
worker waits up to five seconds for that EOF and joins its reader before Python
stream finalization. The parent must still require stdout EOF and exit code zero
before committing the result; a result message alone is not a successful job.

Rust owns all provider keys, persisted prompts/configuration, batching, rate
limits, retries, caching, queue capacity and cloud concurrency. `--workers` is
only a bounded number (1–64) of local callbacks awaiting Rust replies. The Python
bridge does not inherit the engine's cache/rate-limiter entrypoint, and a small
import shim prevents its otherwise automatic SQLite cache initialization.

Formula placeholders are `{vN}`. Their identity, order and count are checked
before returning a translation to the engine. The non-LLM engine path avoids
BabelDOC's separate hardcoded batching and glossary calls. Its tradeoff is that
cross-page/cross-column LLM joint translation and inline rich-text translation
are disabled; PDF page geometry, images and formula objects remain handled by
the native engine. Source language metadata is `en`; output is `zh-CN`.

## Failure and cancellation

Encrypted PDFs and PDFs without a usable text layer are rejected. Raster pages
with little text are conservatively treated as scans, with a message directing
the user to MinerU. Vertical/rotated paragraphs with readable body text are also
rejected instead of accepting the engine's silent skip; recognized formula-only
objects and numeric-only labels may remain unchanged. No OCR service is contacted. This heuristic cannot prove that
every remaining text layer is accurate.

Malformed, unknown, duplicate or oversized replies, provider errors, formula
damage and stdin EOF before the sealed result fail the whole job and wake all
pending callbacks. The
parent process remains responsible for an overall deadline and hard cancellation
of the runner. Two pinned PDF writer helpers are replaced with same-process
PyMuPDF operations, avoiding upstream multiprocessing grandchildren and
best-effort save fallbacks. Runtime process guards also reject subprocess/fork
and multiprocessing start attempts; a real subprocess test exercises these
guards without creating PDF files. Error logs, and layout-stage warnings that upstream
may swallow, latch job failure. This favors an explicit failure over silently
publishing a partially translated PDF.

Numerical helpers use a conservative one-core budget independently of cloud
translation concurrency. The pinned Joblib physical-core cache avoids spawning
hardware-probe commands that the process guard would reject. Native numerical
libraries and layout configuration are initialized before the blocking stdin
reader starts, avoiding cold-import/stdio-lock hangs on Windows.

On Linux, the pinned threadpoolctl libc handle is initialized from the current
process with `ctypes.CDLL(None)`. This avoids its `find_library`/`ldconfig`
subprocess probe when small text bands enter sklearn's DBSCAN path. Only libc is
cached; BLAS libraries loaded later are still enumerated normally. Regression
tests run actual threadpool inspection and Manhattan DBSCAN with the process
guard active, in addition to the complete offline PDF smoke test.

Document-bearing upstream log messages and exception tracebacks are not printed.
Only fixed safe errors are exposed; source paragraphs exist in `translate`
protocol messages but must not be written to application logs. The runtime uses
verified local assets and rejects non-loopback Python network access as defense
in depth. This is not a sandbox for native PDF parser vulnerabilities.

## Assets and verification

The runtime build scripts install `requirements.txt` into the bundled Python,
then run:

```text
python -B -m unittest discover -s tests -v
python -B prepare_assets.py --asset-dir <resources>/pdf-assets
python -B prepare_assets.py --asset-dir <resources>/pdf-assets --verify-only
```

Asset preparation downloads the CPU ONNX layout model, all fonts required by the
engine's fallback families, CMaps and tiktoken data. Checksums come from the
pinned engine's embedded metadata. The build writes `manifest.json` and finally
`.ready` only after verification. Runtime verification does not download or
repair resources; the assets ship inside the application and are never modified
while it runs. No GPU/CUDA or separate cloud queue is configured.

Unit tests use in-memory document fakes rather than creating PDF artifacts.
Installed-engine tests inspect actual v0.6.4 signatures and the two patched
writer call sites. Run the real CPU smoke test after changing the engine,
dependencies or adapter:

```text
python -B smoke.py --asset-dir <resources>/pdf-assets \
  --work-dir <new ASCII directory> --failure-checks
```

It generates a two-column/vector-chart fixture, responds to real layout
callbacks with deterministic Chinese test text, and checks mono/dual page sets,
geometry, text, charts and bounded process exit. It also exercises callback
failure, scanned input and encrypted input. The work directory must be new and
ASCII; PDFs remain there for visual inspection. Run it with networking disabled
to confirm the offline assets are complete. This verifies the real rendering path without
provider fees; it is not a translation-quality benchmark, and output pages still
need visual review when changing layout behavior.

## Upstream references and license facts

- [BabelDOC v0.6.4 configuration](https://github.com/funstory-ai/BabelDOC/blob/v0.6.4/babeldoc/format/pdf/translation_config.py)
- [BabelDOC execution](https://github.com/funstory-ai/BabelDOC/blob/v0.6.4/babeldoc/format/pdf/high_level.py)
- [BabelDOC PDF writer](https://github.com/funstory-ai/BabelDOC/blob/v0.6.4/babeldoc/format/pdf/document_il/backend/pdf_creater.py)
- [Internal API warning](https://github.com/funstory-ai/BabelDOC/blob/v0.6.4/README.md#python-api)
- [BabelDOC license](https://github.com/funstory-ai/BabelDOC/blob/v0.6.4/LICENSE)

The checked BabelDOC, pdf2zh and pdf2zh-next upstream LICENSE files contain GNU
AGPL v3. Font/model assets have their own upstream provenance. This statement
records license facts and is not a conclusion about a deployment's compliance.
The engine installs the unmodified upstream license text (`BABELDOC-LICENSE`)
and the provenance/runtime-adaptation details (`NOTICE.md`) next to the adapter
scripts in the document library's `native-pdf/` folder.
