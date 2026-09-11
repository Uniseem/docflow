#!/usr/bin/env bash
# Builds apps/macos/dist/DocFlow.app for one architecture.
#
#   1. docflow-engine (Rust, release) for the target architecture
#   2. the bundled Python + BabelDOC runtime (runtime/build-macos.sh), unless present
#   3. the SwiftUI app (swift build -c release)
#   4. DocFlow.app/Contents/MacOS/{DocFlow,docflow-engine}
#      DocFlow.app/Contents/Resources/{AppIcon.icns,engine/{python,pdf-assets}}
#   5. a code signature: ad-hoc by default, Developer ID with --sign
#   6. optionally notarization + stapling (--notarize) and packages:
#      --pkg  an installer package (recommended without Developer ID)
#      --dmg  a drag-to-Applications disk image
#      --zip  a zip of the app
#
# Without a Developer ID, distribute the .pkg: the user allows the installer
# once ("仍要打开" in System Settings, or Control-click → 打开), and the app
# that macOS Installer puts into /Applications carries no quarantine flag, so
# Gatekeeper never assesses it — it opens directly, and a download or unzip
# tool can never leave it looking "damaged". Every nested binary is signed and
# the bundle sealed either way; a Developer ID signature that is notarized and
# stapled opens without any prompt.
#
# Requirements: Xcode (or the Command Line Tools) with the macOS 14 SDK or
# newer, and Rust. Build the x86_64 version on an Intel Mac: under Rosetta the
# runtime's tests can crash (AVX). The x86_64 installer refuses Apple silicon
# Macs and the arm64 one Intel Macs, each naming the right download.
# Notarization needs a notarytool keychain profile, created once:
#   xcrun notarytool store-credentials docflow --apple-id … --team-id … --password <app-specific password>
#
# Usage: apps/macos/build.sh [--arch arm64|x86_64] [--skip-runtime]
#                            [--sign "Developer ID Application: Name (TEAMID)"]
#                            [--installer-sign "Developer ID Installer: Name (TEAMID)"]
#                            [--notarize <keychain-profile>] [--pkg] [--dmg] [--zip]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
ARCH="$(uname -m)"
ZIP=0
DMG=0
PKG=0
SKIP_RUNTIME=0
IDENTITY="${DOCFLOW_SIGN_IDENTITY:--}"
INSTALLER_IDENTITY="${DOCFLOW_INSTALLER_IDENTITY:-}"
NOTARY_PROFILE="${DOCFLOW_NOTARY_PROFILE:-}"
BUNDLE_ID="io.github.fengyuchen1314.docflow"

while [ $# -gt 0 ]; do
  case "$1" in
    --arch) ARCH="$2"; shift 2 ;;
    --zip) ZIP=1; shift ;;
    --dmg) DMG=1; shift ;;
    --pkg) PKG=1; shift ;;
    --skip-runtime) SKIP_RUNTIME=1; shift ;;
    --sign) IDENTITY="$2"; shift 2 ;;
    --installer-sign) INSTALLER_IDENTITY="$2"; shift 2 ;;
    --notarize) NOTARY_PROFILE="$2"; shift 2 ;;
    -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

case "$ARCH" in
  arm64|aarch64) ARCH=arm64; RUST_TARGET=aarch64-apple-darwin; WANTS_ARM=true; OTHER_KIND="Intel 芯片的 Mac 请下载 x86_64 版" ;;
  # Not for Apple silicon: under Rosetta some wheels' vector instructions
  # (AVX) crash the PDF engine, so the installer refuses those Macs.
  x86_64) RUST_TARGET=x86_64-apple-darwin; WANTS_ARM=false; OTHER_KIND="Apple 芯片的 Mac 请下载 arm64 版" ;;
  *) echo "unsupported architecture: $ARCH" >&2; exit 2 ;;
esac
if [ -n "$NOTARY_PROFILE" ] && [ "$IDENTITY" = "-" ]; then
  echo "--notarize needs a Developer ID signature (--sign)" >&2
  exit 2
fi
if [ -n "$INSTALLER_IDENTITY" ] && [ "$IDENTITY" = "-" ]; then
  echo "--installer-sign needs the app signed with a Developer ID as well (--sign)" >&2
  exit 2
fi

VERSION="$(sed -n 's/^version = "\(.*\)"$/\1/p' "$REPO/engine/Cargo.toml" | head -n 1)"
BUILD="$(git -C "$REPO" rev-list --count HEAD 2>/dev/null || echo 1)"
RUNTIME="$REPO/runtime/build/macos-$ARCH/resources"
DIST="$HERE/dist"
APP="$DIST/DocFlow.app"
ENTITLEMENTS="$HERE/Resources/python.entitlements"
export MACOSX_DEPLOYMENT_TARGET=14.0

echo "==> Engine ($RUST_TARGET, release)"
if command -v rustup >/dev/null 2>&1; then
  rustup target add "$RUST_TARGET" >/dev/null
fi
cargo build --release --locked --target "$RUST_TARGET" --manifest-path "$REPO/engine/Cargo.toml"
ENGINE="$REPO/engine/target/$RUST_TARGET/release/docflow-engine"

if [ "$SKIP_RUNTIME" != 1 ] && [ ! -f "$RUNTIME/pdf-assets/.ready" ]; then
  echo "==> Python + BabelDOC runtime ($ARCH)"
  bash "$REPO/runtime/build-macos.sh" "$ARCH" "$RUNTIME"
fi

echo "==> SwiftUI app"
swift build -c release --arch "$ARCH" --package-path "$HERE"
BIN="$(swift build -c release --arch "$ARCH" --package-path "$HERE" --show-bin-path)"

echo "==> $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/zh-Hans.lproj"
cp "$BIN/DocFlow" "$APP/Contents/MacOS/DocFlow"
cp "$ENGINE" "$APP/Contents/MacOS/docflow-engine"
sed -e "s/__VERSION__/$VERSION/g" -e "s/__BUILD__/$BUILD/g" "$HERE/Resources/Info.plist" > "$APP/Contents/Info.plist"
plutil -lint "$APP/Contents/Info.plist" >/dev/null
printf 'APPL????' > "$APP/Contents/PkgInfo"
iconutil -c icns "$HERE/Resources/AppIcon.iconset" -o "$APP/Contents/Resources/AppIcon.icns"
cp "$REPO/LICENSE" "$REPO/THIRD_PARTY_NOTICES.md" "$APP/Contents/Resources/"
if [ -d "$RUNTIME/python" ] && [ -f "$RUNTIME/pdf-assets/.ready" ]; then
  mkdir -p "$APP/Contents/Resources/engine"
  ditto "$RUNTIME/python" "$APP/Contents/Resources/engine/python"
  ditto "$RUNTIME/pdf-assets" "$APP/Contents/Resources/engine/pdf-assets"
  if [ -f "$RUNTIME/RUNTIME.txt" ]; then
    cp "$RUNTIME/RUNTIME.txt" "$APP/Contents/Resources/engine/"
  fi
  # Build-time leftovers: static libraries and bytecode are not needed, and
  # nothing may be written into the sealed bundle later.
  find "$APP/Contents/Resources/engine/python" \( -name "*.a" -o -name "*.pyc" \) -type f -delete
  find "$APP/Contents/Resources/engine/python" -name __pycache__ -type d -prune -exec rm -rf {} +
else
  echo "warning: no runtime at $RUNTIME; PDF 原生翻译 will be unavailable in this build" >&2
fi
# A symlink that leaves the bundle breaks its seal ("damaged" on other Macs).
while IFS= read -r -d '' link; do
  target="$(readlink "$link")"
  case "$target" in
    /*) echo "error: absolute symlink in the bundle: $link -> $target" >&2; exit 1 ;;
  esac
done < <(find "$APP" -type l -print0)
# Extended attributes (quarantine, Finder info) are not allowed in a sealed
# bundle, and codesign rewrites every binary, read-only wheel files included.
xattr -cr "$APP"
chmod -R u+w "$APP"

# Every Mach-O file of the bundled Python, split into programs (which get
# the hardened-runtime exceptions) and libraries (which never need any).
PROGRAMS="$(mktemp)"
LIBRARIES="$(mktemp)"
trap 'rm -f "$PROGRAMS" "$LIBRARIES"' EXIT
if [ -d "$APP/Contents/Resources/engine/python" ]; then
  find "$APP/Contents/Resources/engine/python" -type f -print0 |
    while IFS= read -r -d '' file; do
      case "$(file -b "$file")" in
        *Mach-O*executable*) printf '%s\0' "$file" >> "$PROGRAMS" ;;
        *Mach-O*) printf '%s\0' "$file" >> "$LIBRARIES" ;;
      esac
    done
fi

echo "==> Code signature ($IDENTITY)"
if [ "$IDENTITY" = "-" ]; then
  # Ad-hoc, inside out. Some x86_64 wheels ship unsigned libraries and
  # arm64 binaries are only linker-signed; every nested binary gets a real
  # signature and the bundle a sealed one, so it verifies strictly.
  if [ -s "$LIBRARIES" ]; then
    xargs -0 -n 64 codesign --force --sign - --timestamp=none < "$LIBRARIES"
  fi
  if [ -s "$PROGRAMS" ]; then
    xargs -0 -n 64 codesign --force --sign - --timestamp=none < "$PROGRAMS"
  fi
  codesign --force --sign - --timestamp=none "$APP/Contents/MacOS/docflow-engine"
  codesign --force --sign - --timestamp=none "$APP"
else
  # Developer ID with the hardened runtime and a secure timestamp, inside
  # out: libraries, then programs, then the engine, then the app itself.
  if [ -s "$LIBRARIES" ]; then
    xargs -0 -n 64 codesign --force --options runtime --timestamp --sign "$IDENTITY" < "$LIBRARIES"
  fi
  if [ -s "$PROGRAMS" ]; then
    xargs -0 -n 64 codesign --force --options runtime --timestamp --sign "$IDENTITY" --entitlements "$ENTITLEMENTS" < "$PROGRAMS"
  fi
  codesign --force --options runtime --timestamp --sign "$IDENTITY" "$APP/Contents/MacOS/docflow-engine"
  codesign --force --options runtime --timestamp --sign "$IDENTITY" "$APP"
fi
codesign --verify --deep --strict --verbose=2 "$APP"
# Every nested binary must carry a valid signature, or Gatekeeper reports the
# app as damaged on other Macs.
if [ -s "$LIBRARIES" ] || [ -s "$PROGRAMS" ]; then
  cat "$LIBRARIES" "$PROGRAMS" | xargs -0 -n 64 codesign --verify --strict
fi

notarize() {
  # notarize <file to submit> <what to staple>
  local submission="$1" target="$2" result
  result="$(mktemp)"
  echo "==> Notarizing $(basename "$submission") (this can take a few minutes)"
  xcrun notarytool submit "$submission" --keychain-profile "$NOTARY_PROFILE" --wait --output-format json > "$result"
  local status id
  status="$(plutil -extract status raw -o - "$result" 2>/dev/null || echo unknown)"
  id="$(plutil -extract id raw -o - "$result" 2>/dev/null || echo "")"
  rm -f "$result"
  if [ "$status" != "Accepted" ]; then
    echo "notarization failed ($status); details: xcrun notarytool log $id --keychain-profile $NOTARY_PROFILE" >&2
    exit 1
  fi
  xcrun stapler staple "$target"
  xcrun stapler validate "$target"
}

if [ -n "$NOTARY_PROFILE" ]; then
  SUBMISSION="$DIST/.notarize-$ARCH.zip"
  ditto -c -k --sequesterRsrc --keepParent "$APP" "$SUBMISSION"
  notarize "$SUBMISSION" "$APP"
  rm -f "$SUBMISSION"
  spctl --assess --type execute --verbose=2 "$APP"
fi

NOTE="$HERE/Resources/InstallNote.txt"

if [ "$PKG" = 1 ]; then
  PACKAGE="$DIST/DocFlow-macos-$ARCH.pkg"
  rm -f "$PACKAGE"
  echo "==> $PACKAGE"
  WORK="$(mktemp -d)"
  mkdir -p "$WORK/root" "$WORK/resources"
  ditto "$APP" "$WORK/root/DocFlow.app"
  # Always install into /Applications, replacing an older copy entirely.
  pkgbuild --analyze --root "$WORK/root" "$WORK/components.plist" >/dev/null
  plutil -replace 0.BundleIsRelocatable -bool NO "$WORK/components.plist"
  plutil -replace 0.BundleIsVersionChecked -bool NO "$WORK/components.plist"
  plutil -replace 0.BundleOverwriteAction -string upgrade "$WORK/components.plist"
  pkgbuild --root "$WORK/root" --component-plist "$WORK/components.plist" \
    --identifier "$BUNDLE_ID" --version "$VERSION" --install-location /Applications \
    "$WORK/DocFlow-component.pkg" >/dev/null
  cp "$HERE/Resources/installer/welcome.html" "$HERE/Resources/installer/conclusion.html" "$WORK/resources/"
  cat > "$WORK/distribution.xml" <<XML
<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
    <title>DocFlow</title>
    <welcome file="welcome.html" mime-type="text/html"/>
    <conclusion file="conclusion.html" mime-type="text/html"/>
    <options customize="never" require-scripts="false" hostArchitectures="x86_64,arm64"/>
    <domains enable_localSystem="true"/>
    <installation-check script="matchingMac()"/>
    <script><![CDATA[
function matchingMac() {
    // Set on Apple silicon even when asked from a Rosetta process; Intel
    // Macs do not have the key.
    var isArm = false;
    try {
        isArm = system.sysctl('hw.optional.arm64') == 1;
    } catch (error) {
    }
    if (isArm == $WANTS_ARM) {
        return true;
    }
    my.result.type = 'Fatal';
    my.result.title = '这个安装包不适用于这台 Mac';
    my.result.message = '${OTHER_KIND}。';
    return false;
}
]]></script>
    <volume-check>
        <allowed-os-versions>
            <os-version min="14.0"/>
        </allowed-os-versions>
    </volume-check>
    <choices-outline>
        <line choice="default">
            <line choice="$BUNDLE_ID"/>
        </line>
    </choices-outline>
    <choice id="default"/>
    <choice id="$BUNDLE_ID" visible="false">
        <pkg-ref id="$BUNDLE_ID"/>
    </choice>
    <pkg-ref id="$BUNDLE_ID" version="$VERSION" onConclusion="none">DocFlow-component.pkg</pkg-ref>
</installer-gui-script>
XML
  if [ -n "$INSTALLER_IDENTITY" ]; then
    productbuild --distribution "$WORK/distribution.xml" --resources "$WORK/resources" --package-path "$WORK" \
      --sign "$INSTALLER_IDENTITY" --timestamp "$PACKAGE"
    pkgutil --check-signature "$PACKAGE"
    if [ -n "$NOTARY_PROFILE" ]; then
      notarize "$PACKAGE" "$PACKAGE"
    fi
  else
    productbuild --distribution "$WORK/distribution.xml" --resources "$WORK/resources" --package-path "$WORK" "$PACKAGE"
  fi
  rm -rf "$WORK"
  # The package must contain the app exactly as signed.
  CHECK="$(mktemp -d)"
  pkgutil --expand-full "$PACKAGE" "$CHECK/expanded"
  codesign --verify --deep --strict "$CHECK/expanded/DocFlow-component.pkg/Payload/DocFlow.app"
  rm -rf "$CHECK"
fi

if [ "$ZIP" = 1 ]; then
  ARCHIVE="$DIST/DocFlow-macos-$ARCH.zip"
  rm -f "$ARCHIVE"
  echo "==> $ARCHIVE"
  if [ "$IDENTITY" = "-" ]; then
    # The zip holds the app and the note for opening an unsigned app.
    STAGE="$(mktemp -d)"
    ditto "$APP" "$STAGE/DocFlow.app"
    cp "$NOTE" "$STAGE/安装说明.txt"
    ditto -c -k --sequesterRsrc "$STAGE" "$ARCHIVE"
    rm -rf "$STAGE"
  else
    ditto -c -k --sequesterRsrc --keepParent "$APP" "$ARCHIVE"
  fi
fi

if [ "$DMG" = 1 ]; then
  IMAGE="$DIST/DocFlow-macos-$ARCH.dmg"
  rm -f "$IMAGE"
  echo "==> $IMAGE"
  STAGE="$(mktemp -d)"
  ditto "$APP" "$STAGE/DocFlow.app"
  ln -s /Applications "$STAGE/Applications"
  if [ "$IDENTITY" = "-" ]; then
    cp "$NOTE" "$STAGE/安装说明.txt"
  fi
  hdiutil create -volname "DocFlow" -srcfolder "$STAGE" -fs HFS+ -format UDZO -ov "$IMAGE" >/dev/null
  rm -rf "$STAGE"
  if [ "$IDENTITY" != "-" ]; then
    codesign --force --timestamp --sign "$IDENTITY" "$IMAGE"
    if [ -n "$NOTARY_PROFILE" ]; then
      notarize "$IMAGE" "$IMAGE"
    fi
  fi
fi

echo "Done: $APP ($(du -sh "$APP" | cut -f1))"
