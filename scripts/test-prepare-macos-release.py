#!/usr/bin/env python3
"""Local review/signature checks using only ephemeral in-memory signing keys."""
import base64
import importlib.util
from pathlib import Path
from unittest.mock import patch
import os
import subprocess
import sys
import tempfile
import unittest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PrivateFormat, NoEncryption

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("macos_release", Path(__file__).with_name("prepare-macos-release.py"))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseReviewTests(unittest.TestCase):
    def test_tool_failure_reports_diagnostic(self):
        error = subprocess.CalledProcessError(1, ['sign_update'], stderr='Feed signature is invalid')
        with patch.object(release.subprocess, 'run', side_effect=error):
            with self.assertRaisesRegex(RuntimeError, 'sign_update failed.*Feed signature is invalid'):
                release.run(['sign_update'])

    def test_signing_timeout_reports_keychain_prompt(self):
        with patch.object(release.subprocess, 'run', side_effect=subprocess.TimeoutExpired('generate_appcast', 120)):
            with self.assertRaisesRegex(RuntimeError, 'Keychain access prompt'):
                release.run(['generate_appcast'], timeout=120)

    def test_metadata_requires_the_project_key_and_signed_feed_policy(self):
        valid = {"CFBundleIdentifier": "local.codex-hub.preview", "SUPublicEDKey": release.PUBLIC_KEY,
                 "SUFeedURL": release.FEED_URL, "SURequireSignedFeed": True,
                 "SUVerifyUpdateBeforeExtraction": True, "SUSignedFeedFailureExpirationInterval": 0,
                 "SUAllowsAutomaticUpdates": False, "SUAutomaticallyUpdate": False,
                 "CFBundleVersion": "48", "CFBundleShortVersionString": "0.3.0"}
        self.assertEqual(release.validate_metadata(valid, 47), ("0.3.0", "48"))
        for field, value in (("SUPublicEDKey", "other"), ("SUFeedURL", "http://example.com/feed"),
                             ("SURequireSignedFeed", False), ("SUAutomaticallyUpdate", True),
                             ("CFBundleVersion", "47")):
            with self.subTest(field=field), self.assertRaises(ValueError):
                release.validate_metadata({**valid, field: value}, 47)

    def test_reviewed_tree_detects_content_and_symlink_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "file").write_text("reviewed")
            first = release.tree_sha(root)
            (root / "file").write_text("changed")
            self.assertNotEqual(first, release.tree_sha(root))
            os.symlink("file", root / "link")
            second = release.tree_sha(root)
            (root / "link").unlink()
            os.symlink("other", root / "link")
            self.assertNotEqual(second, release.tree_sha(root))

    def test_official_tools_verify_archive_and_feed_and_reject_tampering(self):
        tool = Path(os.environ["CODEX_PHONE_SPARKLE_DIST"]) / "bin/sign_update"
        seed = base64.b64encode(Ed25519PrivateKey.generate().private_bytes(Encoding.Raw, PrivateFormat.Raw, NoEncryption()))
        with tempfile.TemporaryDirectory(prefix="codex-release-signature-test-") as directory:
            root = Path(directory)
            archive = root / "test.zip"
            archive.write_bytes(b"isolated signing test payload; not an application")
            def invoke(arguments, success=True):
                result = subprocess.run([str(tool), "--ed-key-file", "-", *map(str, arguments)], input=seed + b"\n", capture_output=True)
                self.assertEqual(result.returncode == 0, success)
                return result.stdout.decode().strip()
            signature = invoke(["-p", archive])
            plan = {"build": "48", "urls": {"zip": "https://codex.air-inc.top/download/test.zip"}}
            feed = root / "appcast.xml"
            def write_feed(url):
                feed.write_text(f'''<?xml version="1.0"?><rss version="2.0" xmlns:sparkle="{release.NAMESPACE}"><channel><title>Isolated Test</title><item><sparkle:version>48</sparkle:version><enclosure url="{url}" length="{archive.stat().st_size}" sparkle:edSignature="{signature}" type="application/octet-stream"/></item></channel></rss>''')
                invoke([feed])
            write_feed(plan["urls"]["zip"])
            self.assertEqual(release.validate_appcast(feed, plan, archive), signature)
            invoke(["--verify", archive, signature])
            invoke(["--verify", feed])
            archive.write_bytes(archive.read_bytes() + b"tampered")
            invoke(["--verify", archive, signature], success=False)
            feed.write_text(feed.read_text().replace("Isolated Test", "Tampered Test"))
            invoke(["--verify", feed], success=False)
            write_feed("http://codex.air-inc.top/download/test.zip")
            with self.assertRaises(ValueError):
                release.validate_appcast(feed, plan, archive)


if __name__ == "__main__":
    unittest.main()
