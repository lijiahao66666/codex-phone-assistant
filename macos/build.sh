#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
root=$(pwd)
output="${1:-$root/build/codex手机助手.app}"
if [ -e "$output" ]; then printf '%s\n' 'Output already exists; choose a new path.' >&2; exit 1; fi
case "$(uname -m)" in arm64) arch=arm64 ;; x86_64) arch=x64 ;; *) exit 1 ;; esac
version=22.17.1
archive="node-v${version}-darwin-${arch}.tar.gz"
tmp=$(mktemp -d "${TMPDIR:-/tmp}/codex-hub-build.XXXXXXXX")
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
curl -fsSL "https://nodejs.org/dist/v${version}/${archive}" -o "$tmp/$archive"
curl -fsSL "https://nodejs.org/dist/v${version}/SHASUMS256.txt" -o "$tmp/checksums"
expected=$(awk -v name="$archive" '$2 == name {print $1}' "$tmp/checksums")
actual=$(shasum -a 256 "$tmp/$archive" | awk '{print $1}')
[ -n "$expected" ] && [ "$expected" = "$actual" ] || { printf '%s\n' 'Node checksum mismatch' >&2; exit 1; }
tar -xzf "$tmp/$archive" -C "$tmp"
mkdir -p "$output/Contents/MacOS" "$output/Contents/Resources/runtime"
cp "$tmp/node-v${version}-darwin-${arch}/bin/node" "$output/Contents/Resources/node"
ditto "$root/src" "$output/Contents/Resources/runtime/src"
ditto "$root/public" "$output/Contents/Resources/runtime/public"
ditto "$root/node_modules" "$output/Contents/Resources/runtime/node_modules"
cp "$root/package.json" "$output/Contents/Resources/runtime/"
swiftc "$root/macos/CodexHub.swift" -o "$output/Contents/MacOS/CodexHub" -framework Cocoa -framework WebKit
cc "$root/macos/validate-image.c" -o "$output/Contents/Resources/runtime/validate-image" -framework CoreFoundation -framework CoreGraphics -framework ImageIO
cc "$root/macos/safe-media-open.c" -o "$output/Contents/Resources/runtime/safe-media-open"
swift "$root/macos/icon.swift" "$tmp/CodexHelper.iconset" "$root/macos/chatgpt-icon.png"
iconutil -c icns "$tmp/CodexHelper.iconset" -o "$output/Contents/Resources/AppIcon.icns"
/usr/libexec/PlistBuddy -c 'Add :CFBundleIdentifier string local.codex-hub.preview' -c 'Add :CFBundleName string codex手机助手' -c 'Add :CFBundleDisplayName string codex手机助手' -c 'Add :CFBundleExecutable string CodexHub' -c 'Add :CFBundlePackageType string APPL' -c 'Add :CFBundleIconFile string AppIcon' -c 'Add :NSAppTransportSecurity:NSAllowsLocalNetworking bool true' "$output/Contents/Info.plist" >/dev/null
printf 'Built: %s\n' "$output"
