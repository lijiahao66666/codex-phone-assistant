#!/bin/sh
set -eu
if [ "$#" -ne 3 ]; then
  printf '%s\n' 'Usage: sh build-macos.sh WINDOWS_RUNTIME_DIRECTORY ENTRY.mjs OUTPUT.exe' >&2
  exit 2
fi
runtime_dir=$1
entry=$2
output=$3
case "$entry" in */*|*\\*|.*|'') printf '%s\n' 'Entry must be an .mjs filename in the runtime root.' >&2; exit 2;; *.mjs) ;; *) exit 2;; esac
test -d "$runtime_dir" && test -f "$runtime_dir/$entry" || { printf '%s\n' 'Windows runtime directory or entry is missing.' >&2; exit 2; }
test ! -e "$output" || { printf '%s\n' 'Output already exists.' >&2; exit 2; }
command -v makensis >/dev/null
command -v sips >/dev/null
dotnet_cmd=${DOTNET:-dotnet}
command -v "$dotnet_cmd" >/dev/null
script_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/codex-phone-windows-build.XXXXXXXX")
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
node_version=22.17.1
archive="node-v$node_version-win-x64.zip"
curl -fsSL --connect-timeout 15 --max-time 300 "${NODE_ARCHIVE_URL:-https://nodejs.org/dist/v$node_version/$archive}" -o "$tmp/node.zip"
curl -fsSL "https://nodejs.org/dist/v$node_version/SHASUMS256.txt" -o "$tmp/checksums"
expected=$(awk -v name="$archive" '$2 == name { print $1 }' "$tmp/checksums")
actual=$(shasum -a 256 "$tmp/node.zip" | awk '{ print $1 }')
test -n "$expected" && test "$expected" = "$actual" || { printf '%s\n' 'Node checksum mismatch.' >&2; exit 1; }
unzip -q "$tmp/node.zip" "node-v$node_version-win-x64/node.exe" -d "$tmp"
DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 "$dotnet_cmd" publish "$script_dir/Shell/CodexPhone.csproj" -c Release -r win-x64 --self-contained true -o "$tmp/dist"
cp "$tmp/node-v$node_version-win-x64/node.exe" "$tmp/dist/node.exe"
mkdir "$tmp/dist/runtime"
cp -R "$runtime_dir/." "$tmp/dist/runtime/"
printf '%s\n' "$entry" > "$tmp/dist/runtime-entry.txt"
sips -z 256 256 -s format png "$script_dir/../public/app-icon.png" --out "$tmp/icon.png" >/dev/null
node "$script_dir/png-to-ico.mjs" "$tmp/icon.png" "$tmp/dist/app.ico"
cp "$script_dir/installer.nsi" "$tmp/installer.nsi"
(cd "$tmp" && makensis installer.nsi)
cp "$tmp/codex-phone-assistant-windows-x64-setup.exe" "$output"
printf 'Built candidate: %s\n' "$output"
