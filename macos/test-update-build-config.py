#!/usr/bin/env python3
import base64
import importlib.util
from pathlib import Path
import sys
import unittest

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("update_config", Path(__file__).with_name("update-build-config.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class UpdateBuildConfigurationTests(unittest.TestCase):
    def configured(self, **overrides):
        return {"CODEX_PHONE_UPDATE_FEED_URL": "https://updates.example.com/stable/appcast.xml",
                "CODEX_PHONE_UPDATE_PUBLIC_KEY": base64.b64encode(bytes(range(1, 33))).decode(), **overrides}

    def test_unconfigured_build_has_no_update_endpoint(self):
        config = module.configuration({})
        self.assertNotIn("SUFeedURL", config)
        self.assertNotIn("SUPublicEDKey", config)
        self.assertFalse(config["SUAllowsAutomaticUpdates"])
        self.assertTrue(config["SUVerifyUpdateBeforeExtraction"])
        self.assertTrue(config["SURequireSignedFeed"])
        self.assertEqual(config["SUSignedFeedFailureExpirationInterval"], 0)

    def test_configured_build_checks_automatically_without_silent_install(self):
        config = module.configuration(self.configured())
        self.assertTrue(config["SUEnableAutomaticChecks"])
        self.assertFalse(config["SUAutomaticallyUpdate"])
        self.assertFalse(config["SUAllowsAutomaticUpdates"])

    def test_partial_configuration_is_rejected(self):
        for field in ("CODEX_PHONE_UPDATE_FEED_URL", "CODEX_PHONE_UPDATE_PUBLIC_KEY"):
            with self.subTest(field=field), self.assertRaises(ValueError):
                module.configuration(self.configured(**{field: ""}))

    def test_unsigned_or_invalid_key_configuration_is_rejected(self):
        for key in ("", "placeholder", base64.b64encode(bytes(32)).decode(),
                    base64.b64encode(bytes(31)).decode(), base64.b64encode(bytes(33)).decode(),
                    self.configured()["CODEX_PHONE_UPDATE_PUBLIC_KEY"] + "\n"):
            with self.subTest(key=key), self.assertRaises(ValueError):
                module.configuration(self.configured(CODEX_PHONE_UPDATE_PUBLIC_KEY=key))

    def test_unsafe_feed_is_rejected(self):
        for feed in ("http://updates.example.com/appcast.xml", "https:///appcast.xml",
                     "https://user:secret@updates.example.com/appcast.xml",
                     "https://updates.example.com:bad/appcast.xml",
                     "https://updates.example.com/appcast.xml#fragment", "https://updates.example.com/\nfile"):
            with self.subTest(feed=feed), self.assertRaises(ValueError):
                module.configuration(self.configured(CODEX_PHONE_UPDATE_FEED_URL=feed))

    def test_equal_or_decreasing_build_is_rejected(self):
        for build in ("1", "2", "0", "003", "3;touch bad", "10000"):
            with self.subTest(build=build), self.assertRaises(ValueError):
                module.configuration({"CODEX_PHONE_BUILD_VERSION": build})

    def test_release_build_must_advance_declared_previous_release(self):
        config = module.configuration({"CODEX_PHONE_APP_VERSION": "0.3.0",
                                       "CODEX_PHONE_BUILD_VERSION": "48", "CODEX_PHONE_PREVIOUS_BUILD_VERSION": "47"})
        self.assertEqual(config["CFBundleVersion"], "48")
        with self.assertRaises(ValueError):
            module.configuration({"CODEX_PHONE_BUILD_VERSION": "47", "CODEX_PHONE_PREVIOUS_BUILD_VERSION": "48"})


if __name__ == "__main__":
    unittest.main()
