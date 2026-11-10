#!/usr/bin/env python3
"""Isolated publication checks; no network, keys, or production paths."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("download_page", Path(__file__).with_name("prepare-download-page.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

PAGE = '''<!doctype html><html><body>
<article class="download"><h2>macOS</h2><p>Apple Silicon / macOS 12 / 未公证</p><a class="download-button disabled" id="mac-download" aria-disabled="true">准备中</a></article>
<article class="download"><h2>Windows</h2><a id="windows-download" href="windows-v1.exe">Windows v1</a></article>
<section><video src="existing.mp4"></video>保留安装教程</section>
<script src="downloads.js"></script></body></html>
'''
SCRIPT = '''const downloads = { mac: 'old.dmg', windows: 'windows-v1.exe' };
for (const [platform, url] of Object.entries(downloads)) { console.log(platform, url); }
'''


class DownloadPageTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="codex-download-patch-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.baseline = self.root / "baseline"
        self.release = self.root / "release"
        self.output = self.root / "review"
        self.baseline.mkdir()
        self.release.mkdir()
        (self.baseline / "index.html").write_text(PAGE)
        (self.baseline / "downloads.js").write_text(SCRIPT)
        stem = "codex-phone-assistant-macos-arm64-0.3.0-build48-stable48"
        self.dmg = stem + ".dmg"
        artifacts = {}
        for name in (self.dmg, stem + ".zip", "appcast.xml"):
            data = ("isolated-fixture:" + name).encode()
            (self.release / name).write_bytes(data)
            artifacts[name] = {"bytes": len(data), "sha256": module.sha(data)}
        receipt = {"reviewedPlan": {"version": "0.3.0", "build": "48", "releaseLabel": "stable48",
                   "files": {"dmg": self.dmg, "zip": stem + ".zip", "appcast": "appcast.xml"}}, "artifacts": artifacts}
        data = (json.dumps(receipt) + "\n").encode()
        (self.release / "macos-release.json").write_bytes(data)
        sums = {name: record["sha256"] for name, record in artifacts.items()}
        sums["macos-release.json"] = module.sha(data)
        (self.release / "SHA256SUMS.txt").write_text("".join(f"{digest}  {name}\n" for name, digest in sums.items()))

    def prepare(self):
        return module.prepare(self.baseline, self.release, self.output, "2026-11-10", "https://github.com/example/project/releases/tag/stable48")

    def test_review_patch_applies_and_preserves_windows_and_existing_content(self):
        result = self.prepare()
        candidate = (self.output / "candidate/index.html").read_text()
        self.assertIn(f'href="{self.dmg}"', candidate)
        self.assertIn("版本 0.3.0 · build 48 · stable48 · 发布于 2026-11-10", candidate)
        self.assertIn("首次使用更新功能", candidate)
        self.assertNotIn("SHA-256", candidate)
        self.assertNotIn("SHA256SUMS", candidate)
        self.assertNotIn("shasum", candidate)
        self.assertIn("版本说明与已知限制", candidate)
        # The only changes outside the Mac card are the script's cache version.
        original_suffix = PAGE[PAGE.index('<article class="download"><h2>Windows'):]
        candidate_suffix = candidate[candidate.index('<article class="download"><h2>Windows'):]
        self.assertEqual(original_suffix.replace('downloads.js"', 'downloads.js?v=stable48"'), candidate_suffix)
        self.assertEqual(SCRIPT.replace("old.dmg", self.dmg), (self.output / "candidate/downloads.js").read_text())
        self.assertFalse(result["published"])
        self.assertEqual(PAGE, (self.baseline / "index.html").read_text())
        subprocess.run(["patch", "--batch", "-p1", "-i", str(self.output / "download-page.patch")], cwd=self.output / "baseline", check=True, capture_output=True)
        for name in ("index.html", "downloads.js"):
            actual = (self.output / "baseline" / name).read_bytes()
            self.assertEqual(actual, (self.output / "candidate" / name).read_bytes())
            self.assertEqual(module.sha(actual), result["files"][name]["afterSHA256"])

    def test_changed_release_artifact_rejected_before_writing(self):
        (self.release / self.dmg).write_bytes(b"modified after packaging")
        with self.assertRaisesRegex(ValueError, "differs from receipt"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_wrong_checksum_manifest_rejected_before_writing(self):
        (self.release / "SHA256SUMS.txt").write_text("old release checksums\n")
        with self.assertRaisesRegex(ValueError, "manifest mismatch"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_page_drift_rejected_without_overwrite(self):
        (self.baseline / "index.html").write_text(PAGE.replace('id="mac-download"', 'id="changed-download"'))
        with self.assertRaisesRegex(ValueError, "exactly one Mac"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_refuses_existing_review_directory(self):
        self.output.mkdir()
        sentinel = self.output / "keep"
        sentinel.write_text("untouched")
        with self.assertRaisesRegex(ValueError, "new output directory"):
            self.prepare()
        self.assertEqual("untouched", sentinel.read_text())


if __name__ == "__main__":
    unittest.main()
