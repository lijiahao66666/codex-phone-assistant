#!/usr/bin/env python3
"""Prepare a reviewable download-page patch from captured public files; never publish."""
import argparse
import datetime
import difflib
import hashlib
import html
import json
from pathlib import Path
import re
from urllib.parse import urlsplit


def sha(data):
    return hashlib.sha256(data).hexdigest()


def https_url(value):
    parsed = urlsplit(value)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or any(ord(c) < 33 for c in value):
        raise ValueError("Release notes must use a public HTTPS URL")
    return value


def prepare(baseline, release, output, date, notes_url):
    datetime.date.fromisoformat(date)
    https_url(notes_url)
    if output.exists() or not output.parent.is_dir():
        raise ValueError("Use a new output directory under an existing parent")
    originals = {name: (baseline / name).read_bytes() for name in ("index.html", "downloads.js")}
    receipt_path = release / "macos-release.json"
    receipt_data = receipt_path.read_bytes()
    receipt = json.loads(receipt_data)
    plan = receipt["reviewedPlan"]
    version, build, label = plan["version"], plan["build"], plan["releaseLabel"]
    if not re.fullmatch(r"\d+\.\d+(?:\.\d+)?", version) or not re.fullmatch(r"[1-9][0-9]{0,3}", build) or not re.fullmatch(r"stable[1-9][0-9]*", label):
        raise ValueError("Unexpected release version")
    expected = f"codex-phone-assistant-macos-arm64-{version}-build{build}-{label}"
    for suffix in ("dmg", "zip"):
        if plan["files"][suffix] != expected + "." + suffix:
            raise ValueError("Expected reviewed arm64 release filenames")
    if plan["files"]["appcast"] != "appcast.xml":
        raise ValueError("Unexpected feed filename")
    artifacts = receipt["artifacts"]
    if set(artifacts) != {expected + ".dmg", expected + ".zip", "appcast.xml"}:
        raise ValueError("Unexpected release artifact set")
    for name, record in artifacts.items():
        data = (release / name).read_bytes()
        if len(data) != record["bytes"] or sha(data) != record["sha256"]:
            raise ValueError("Release artifact differs from receipt: " + name)
    sums = (release / "SHA256SUMS.txt").read_text()
    expected_sums = {**{name: record["sha256"] for name, record in artifacts.items()}, "macos-release.json": sha(receipt_data)}
    if set(sums.splitlines()) != {digest + "  " + name for name, digest in expected_sums.items()}:
        raise ValueError("Release checksum manifest mismatch")
    page = originals["index.html"].decode()
    script = originals["downloads.js"].decode()
    cards = list(re.finditer(r'<article\b[^>]*>.*?</article>', page, re.S))
    cards = [match for match in cards if 'id="mac-download"' in match.group()]
    if len(cards) != 1:
        raise ValueError("Expected exactly one Mac download card")
    card = cards[0]
    link_pattern = r'<a\b[^>]*\bid="mac-download"[^>]*>.*?</a>'
    if len(re.findall(link_pattern, card.group(), re.S)) != 1 or 'id="mac-release-info"' in page:
        raise ValueError("Mac download markup changed; review it before patching")
    dmg = expected + ".dmg"
    link = f'<a class="download-button" id="mac-download" href="{dmg}">下载 Mac 版</a>'
    details = ('\n        <div id="mac-release-info">'
               f'<p>版本 {version} · build {build} · {label} · 发布于 {date}</p>'
               '<p>首次使用更新功能，请先手动安装本版。之后可在菜单栏选择“检查更新…”；'
               '自动检查更新默认开启，安装仍需确认。助手持有的任务运行中或操作正在处理时，会阻止退出和安装。</p>'
               f'<p><a href="{html.escape(notes_url, quote=True)}">版本说明与已知限制</a></p></div>')
    new_card = re.sub(link_pattern, lambda _: link + details, card.group(), count=1, flags=re.S)
    updated = page[:card.start()] + new_card + page[card.end():]
    script_tag = '<script src="downloads.js"></script>'
    if updated.count(script_tag) != 1:
        raise ValueError("Download script reference changed; review it before patching")
    updated = updated.replace(script_tag, f'<script src="downloads.js?v={label}"></script>')
    # Replace only the Mac property, preserving Windows and all script behavior.
    mac_property = r"(?P<prefix>\bmac\s*:\s*)(?P<quote>['\"])(?P<url>[^'\"\r\n]*)(?P=quote)"
    if len(re.findall(mac_property, script)) != 1:
        raise ValueError("Download URL configuration changed; review it before patching")
    new_script = re.sub(mac_property, lambda m: m["prefix"] + m["quote"] + dmg + m["quote"], script, count=1)
    candidates = {"index.html": updated.encode(), "downloads.js": new_script.encode()}
    manifest = {"status": "LOCAL_PATCH_ONLY", "published": False,
                "baselineOrigin": "https://codex.air-inc.top/download/", "releaseDate": date,
                "version": version, "build": build, "releaseLabel": label,
                "receiptSHA256": sha(receipt_data), "releaseArtifacts": artifacts,
                "files": {name: {"beforeSHA256": sha(originals[name]), "afterSHA256": sha(data)} for name, data in candidates.items()}}
    output.mkdir()
    (output / "baseline").mkdir()
    (output / "candidate").mkdir()
    patch = ""
    for name, data in candidates.items():
        (output / "baseline" / name).write_bytes(originals[name])
        (output / "candidate" / name).write_bytes(data)
        patch += "".join(difflib.unified_diff(originals[name].decode().splitlines(keepends=True), data.decode().splitlines(keepends=True), fromfile="a/" + name, tofile="b/" + name))
    (output / "download-page.patch").write_text(patch)
    (output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path, required=True, help="Captured index.html and downloads.js")
    parser.add_argument("--release", type=Path, required=True, help="Output of prepare-macos-release.py")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--release-date", required=True)
    parser.add_argument("--release-notes-url", required=True)
    args = parser.parse_args()
    print(json.dumps(prepare(args.baseline, args.release, args.output, args.release_date, args.release_notes_url), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
