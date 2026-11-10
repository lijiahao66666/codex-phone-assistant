#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
root=$(pwd)
export MACOSX_DEPLOYMENT_TARGET=12.0
output="${1:-$root/build/codex手机助手.app}"
if [ -e "$output" ]; then printf '%s\n' 'Output already exists; choose a new path.' >&2; exit 1; fi
case "$(uname -m)" in arm64) arch=arm64; swift_arch=arm64 ;; x86_64) arch=x64; swift_arch=x86_64 ;; *) exit 1 ;; esac
version=22.17.1
archive="node-v${version}-darwin-${arch}.tar.gz"
tmp=$(mktemp -d "${TMPDIR:-/tmp}/codex-hub-build.XXXXXXXX")
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
python3 "$root/macos/update-build-config.py" "$tmp/Info.plist"
sparkle_archive="$tmp/Sparkle-2.10.1.tar.xz"
if [ -n "${CODEX_PHONE_SPARKLE_ARCHIVE:-}" ]; then
  cp "$CODEX_PHONE_SPARKLE_ARCHIVE" "$sparkle_archive"
else
  curl -fL --retry 3 'https://github.com/sparkle-project/Sparkle/releases/download/2.10.1/Sparkle-2.10.1.tar.xz' -o "$sparkle_archive"
fi
# Pinned digest from the official GitHub Release asset. A local cache must pass
# the same check; never import Sparkle from another installed application's app.
sparkle_sha=$(shasum -a 256 "$sparkle_archive" | awk '{print $1}')
[ "$sparkle_sha" = '1a856d2a9edb8e628de88121d7be04cf0e2167f8641650b78fca00b14244cf27' ] || { printf '%s\n' 'Sparkle 2.10.1 checksum mismatch' >&2; exit 1; }
mkdir "$tmp/sparkle"
tar -xJf "$sparkle_archive" -C "$tmp/sparkle" ./Sparkle.framework ./LICENSE
codesign --verify --deep --strict "$tmp/sparkle/Sparkle.framework"
if [ -n "${CODEX_PHONE_NODE_BINARY:-}" ]; then
  node_binary="$CODEX_PHONE_NODE_BINARY"
  [ -x "$node_binary" ] || { printf '%s\n' 'Node binary is not executable' >&2; exit 1; }
  actual_arch=$("$node_binary" -p 'process.arch')
  [ "$actual_arch" = "$arch" ] || { printf '%s\n' 'Node binary architecture mismatch' >&2; exit 1; }
  "$node_binary" -e 'const [major,minor] = process.versions.node.split(".").map(Number); if (process.platform !== "darwin" || major < 22 || (major === 22 && minor < 17)) process.exit(1)' || { printf '%s\n' 'Node.js 22.17 or newer for macOS is required' >&2; exit 1; }
else
  curl -fsSL "https://nodejs.org/dist/v${version}/${archive}" -o "$tmp/$archive"
  curl -fsSL "https://nodejs.org/dist/v${version}/SHASUMS256.txt" -o "$tmp/checksums"
  expected=$(awk -v name="$archive" '$2 == name {print $1}' "$tmp/checksums")
  actual=$(shasum -a 256 "$tmp/$archive" | awk '{print $1}')
  [ -n "$expected" ] && [ "$expected" = "$actual" ] || { printf '%s\n' 'Node checksum mismatch' >&2; exit 1; }
  tar -xzf "$tmp/$archive" -C "$tmp"
  node_binary="$tmp/node-v${version}-darwin-${arch}/bin/node"
fi
mkdir -p "$output/Contents/MacOS" "$output/Contents/Resources/runtime" "$output/Contents/Frameworks"
ditto "$tmp/sparkle/Sparkle.framework" "$output/Contents/Frameworks/Sparkle.framework"
cp "$tmp/Info.plist" "$output/Contents/Info.plist"
cp "$tmp/sparkle/LICENSE" "$output/Contents/Resources/Sparkle-LICENSE.txt"
cp "$node_binary" "$output/Contents/Resources/node"
# Validate the copied binary from inside the bundle: Homebrew's Node can depend
# on libraries outside the app even though it runs at its original location.
"$output/Contents/Resources/node" -e 'process.exit(0)' || { printf '%s\n' 'Bundled Node cannot run independently; use a standalone Node binary.' >&2; exit 1; }
ditto "$root/src" "$output/Contents/Resources/runtime/src"
ditto "$root/public" "$output/Contents/Resources/runtime/public"
ditto "$root/node_modules" "$output/Contents/Resources/runtime/node_modules"
cp "$root/package.json" "$output/Contents/Resources/runtime/"
swiftc -target "${swift_arch}-apple-macosx${MACOSX_DEPLOYMENT_TARGET}" "$root/macos/CodexHub.swift" "$root/macos/UpdateConfiguration.swift" -o "$output/Contents/MacOS/CodexHub" -F "$output/Contents/Frameworks" -framework Sparkle -framework Cocoa -framework WebKit -Xlinker -rpath -Xlinker '@executable_path/../Frameworks'
cc "$root/macos/validate-image.c" -o "$output/Contents/Resources/runtime/validate-image" -framework CoreFoundation -framework CoreGraphics -framework ImageIO
cc "$root/macos/safe-media-open.c" -o "$output/Contents/Resources/runtime/safe-media-open"
swift "$root/macos/icon.swift" "$tmp/CodexHelper.iconset" "$root/macos/chatgpt-icon.png"
iconutil -c icns "$tmp/CodexHelper.iconset" -o "$output/Contents/Resources/AppIcon.icns"
for executable in "$output/Contents/Resources/node" "$output/Contents/Resources/runtime/safe-media-open" "$output/Contents/Resources/runtime/validate-image"; do
  codesign --force --sign - --timestamp=none "$executable"
done
codesign --force --sign - --timestamp=none "$output"
codesign --verify --deep --strict "$output"
printf 'Built: %s\n' "$output"
