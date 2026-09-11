#!/usr/bin/env bash
# Builds the bundled Python + BabelDOC runtime used by "PDF 原生翻译" on macOS.
#
# Produces <output>/python (relocatable CPython with the pinned BabelDOC stack)
# and <output>/pdf-assets (verified offline models, fonts, CMaps, tokenizer).
#
# Usage: runtime/build-macos.sh [arm64|x86_64] [output-dir]
set -euo pipefail

ARCH="${1:-$(uname -m)}"
PYTHON_VERSION="3.12.14"
RELEASE="20260901"
case "$ARCH" in
  arm64|aarch64)
    TRIPLE="aarch64-apple-darwin"
    SHA256="81a359f1cfadd4da11766534c5913791cea55f26e1bb902cacd2a531bb1e4b2b"
    ARCH="arm64"
    ;;
  x86_64)
    TRIPLE="x86_64-apple-darwin"
    SHA256="65b195c9cedc1fef6767f044f9822069adbd1bd9204d424ece4628776fdc04bb"
    ;;
  *) echo "unsupported architecture: $ARCH" >&2; exit 2 ;;
esac

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(dirname "$HERE")"
NATIVE_PDF="$REPO/engine/native-pdf"
OUTPUT="${2:-$HERE/build/macos-$ARCH/resources}"
CACHE="${DOCFLOW_RUNTIME_CACHE:-$HERE/cache}"
ARCHIVE="cpython-${PYTHON_VERSION}+${RELEASE}-${TRIPLE}-install_only_stripped.tar.gz"
URL="https://github.com/astral-sh/python-build-standalone/releases/download/${RELEASE}/cpython-${PYTHON_VERSION}%2B${RELEASE}-${TRIPLE}-install_only_stripped.tar.gz"

mkdir -p "$OUTPUT" "$CACHE"
OUTPUT="$(cd "$OUTPUT" && pwd)"
if ! printf '%s' "$OUTPUT" | LC_ALL=C grep -q '^[ -~]*$'; then
  echo "output path must be ASCII (BabelDOC requirement): $OUTPUT" >&2
  exit 2
fi

if [ ! -f "$CACHE/$ARCHIVE" ] || ! echo "$SHA256  $CACHE/$ARCHIVE" | shasum -a 256 -c - >/dev/null 2>&1; then
  echo "Downloading $ARCHIVE"
  curl -fL --retry 3 -o "$CACHE/$ARCHIVE.partial" "$URL"
  mv "$CACHE/$ARCHIVE.partial" "$CACHE/$ARCHIVE"
fi
echo "$SHA256  $CACHE/$ARCHIVE" | shasum -a 256 -c -

rm -rf "$OUTPUT/python"
tar -xzf "$CACHE/$ARCHIVE" -C "$OUTPUT"
PYTHON="$OUTPUT/python/bin/python3"

export PIP_CACHE_DIR="$CACHE/pip-$ARCH" PIP_DISABLE_PIP_VERSION_CHECK=1 PYTHONNOUSERSITE=1
"$PYTHON" -m pip install --no-warn-script-location -r "$NATIVE_PDF/requirements.txt"
"$PYTHON" -m pip check
# Static libraries are only for building against Python.
find "$OUTPUT/python" -name "*.a" -type f -delete

# Every binary must run on the app's minimum macOS. pip picks the newest
# wheel tag the build Mac supports, so a build on a newer macOS could ship
# wheels that crash on import for users of the minimum version.
MIN_MACOS="${DOCFLOW_MIN_MACOS:-14.0}"
version_number() { awk -F. '{ printf "%d\n", $1 * 1000 + $2 }' <<< "$1"; }
minimum_os() {
  otool -arch all -l "$1" 2>/dev/null | awk '
    /cmd LC_BUILD_VERSION/ { build = 1; next }
    /cmd LC_VERSION_MIN_MACOSX/ { legacy = 1; next }
    build && $1 == "minos" { print $2; build = 0 }
    legacy && $1 == "version" { print $2; legacy = 0 }'
}
LIMIT="$(version_number "$MIN_MACOS")"
TOO_NEW=0
while IFS= read -r -d '' file; do
  case "$(file -b "$file")" in *Mach-O*) ;; *) continue ;; esac
  for needed in $(minimum_os "$file"); do
    if [ "$(version_number "$needed")" -gt "$LIMIT" ]; then
      echo "  needs macOS $needed: ${file#"$OUTPUT/"}" >&2
      TOO_NEW=1
    fi
  done
done < <(find "$OUTPUT/python" -type f \( -name "*.so" -o -name "*.dylib" -o -perm -u+x \) -print0)
if [ "$TOO_NEW" = 1 ]; then
  echo "error: binaries above need a newer macOS than $MIN_MACOS; build on macOS $MIN_MACOS or pin older wheels" >&2
  exit 1
fi

if [ "${SKIP_TESTS:-0}" != "1" ]; then
  (cd "$NATIVE_PDF" && "$PYTHON" -B -m unittest discover -s tests -v)
fi

if [ "${SKIP_ASSETS:-0}" != "1" ]; then
  "$PYTHON" -B "$NATIVE_PDF/prepare_assets.py" --asset-dir "$OUTPUT/pdf-assets"
  "$PYTHON" -B "$NATIVE_PDF/prepare_assets.py" --asset-dir "$OUTPUT/pdf-assets" --verify-only
fi

find "$OUTPUT/python" -name __pycache__ -type d -prune -exec rm -rf {} +
echo "CPython $PYTHON_VERSION ($RELEASE); BabelDOC 0.6.4; macos-$ARCH" > "$OUTPUT/RUNTIME.txt"
du -sh "$OUTPUT"
