#!/usr/bin/env python3
"""Validate release inputs before creating the application's sealed Info.plist."""
import base64
import os
import plistlib
import re
import sys
from urllib.parse import urlsplit


def configuration(env):
    version = env.get("CODEX_PHONE_APP_VERSION", "1.0.2")
    build = env.get("CODEX_PHONE_BUILD_VERSION", "58")
    previous = env.get("CODEX_PHONE_PREVIOUS_BUILD_VERSION", "57")
    if not re.fullmatch(r"[0-9]+\.[0-9]+(?:\.[0-9]+)?", version):
        raise ValueError("CODEX_PHONE_APP_VERSION must contain two or three numeric components")
    if not re.fullmatch(r"[1-9][0-9]{0,3}", build) or not re.fullmatch(r"[1-9][0-9]{0,3}", previous):
        raise ValueError("Build versions must be positive integers of at most four digits")
    if int(build) <= int(previous):
        raise ValueError("CODEX_PHONE_BUILD_VERSION must exceed CODEX_PHONE_PREVIOUS_BUILD_VERSION")
    info = {
        "CFBundleIdentifier": "local.codex-hub.preview",
        "CFBundleName": "codex手机助手", "CFBundleDisplayName": "codex手机助手",
        "CFBundleShortVersionString": version, "CFBundleVersion": build,
        "CFBundleExecutable": "CodexHub", "CFBundlePackageType": "APPL",
        "CFBundleIconFile": "AppIcon", "LSMinimumSystemVersion": "12.0",
        "NSAppTransportSecurity": {"NSAllowsLocalNetworking": True},
        "SUEnableAutomaticChecks": True,
        "SUAllowsAutomaticUpdates": False, "SUAutomaticallyUpdate": False,
        "SUEnableSystemProfiling": False,
        "SUVerifyUpdateBeforeExtraction": True, "SURequireSignedFeed": True,
        "SUSignedFeedFailureExpirationInterval": 0,
        "SUScheduledCheckInterval": 86400,
    }
    feed = env.get("CODEX_PHONE_UPDATE_FEED_URL", "")
    key = env.get("CODEX_PHONE_UPDATE_PUBLIC_KEY", "")
    if bool(feed) != bool(key):
        raise ValueError("Update feed and EdDSA public key must both be configured")
    if feed:
        url = urlsplit(feed)
        if (url.scheme != "https" or not url.hostname or url.username is not None
                or url.password is not None or url.fragment
                or any(ord(c) <= 32 or ord(c) == 127 for c in feed)):
            raise ValueError("Update feed must be an HTTPS URL without credentials or fragment")
        try:
            _ = url.port
        except ValueError:
            raise ValueError("Update feed has an invalid port") from None
        try:
            decoded = base64.b64decode(key, validate=True)
        except ValueError:
            raise ValueError("EdDSA public key must be canonical base64") from None
        if len(decoded) != 32 or not any(decoded) or base64.b64encode(decoded).decode() != key:
            raise ValueError("EdDSA public key must encode a nonzero 32-byte Ed25519 public key")
        info.update(SUFeedURL=feed, SUPublicEDKey=key)
    return info


if __name__ == "__main__":
    try:
        info = configuration(os.environ)
        with open(sys.argv[1], "wb") as output:
            plistlib.dump(info, output)
    except (ValueError, OSError, IndexError) as error:
        sys.exit(f"Invalid macOS build configuration: {error}")
