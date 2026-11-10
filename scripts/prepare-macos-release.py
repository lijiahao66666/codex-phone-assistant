#!/usr/bin/env python3
"""Review, package and sign an existing final macOS app locally; never publish.

Default: read-only plan. Execution requires the hash of the reviewed plan and a
fresh output directory. Production signing uses only the project Keychain account
through official Sparkle tools. No private-key export or file option is exposed.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import tarfile
import tempfile
from urllib.parse import urlsplit
import xml.etree.ElementTree as ET

ACCOUNT = "codex-phone-assistant"
PUBLIC_KEY = "rh524xGIFunPmLuhfGnEAznoXq4XMqmjtHkzDfH8hyw="
FEED_URL = "https://codex.air-inc.top/download/appcast.xml"
SPARKLE_SHA = "1a856d2a9edb8e628de88121d7be04cf0e2167f8641650b78fca00b14244cf27"
NAMESPACE = "http://www.andymatuschak.org/xml-namespaces/sparkle"


def run(arguments, timeout=None):
    try:
        result = subprocess.run([str(arg) for arg in arguments], check=True, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise RuntimeError("Sparkle signing timed out; check the macOS Keychain access prompt and retry") from None
    except subprocess.CalledProcessError as error:
        raise RuntimeError(f"{Path(arguments[0]).name} failed (exit {error.returncode}): {error.stderr.strip() or 'no diagnostic output'}") from None
    return result.stdout.strip()


def sha(path):
    value = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def tree_sha(root):
    value = hashlib.sha256()
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root).as_posix()
        if path.is_symlink():
            entry = [relative, "link", os.readlink(path)]
        elif path.is_file():
            entry = [relative, "file", path.stat().st_mode & 0o777, sha(path)]
        elif path.is_dir():
            entry = [relative, "directory", path.stat().st_mode & 0o777]
        else:
            raise ValueError("Unexpected bundle file type: " + relative)
        value.update(json.dumps(entry, ensure_ascii=False, separators=(",", ":")).encode() + b"\n")
    return value.hexdigest()


def validate_metadata(info, previous):
    expected = {"CFBundleIdentifier": "local.codex-hub.preview", "SUPublicEDKey": PUBLIC_KEY,
                "SUFeedURL": FEED_URL, "SURequireSignedFeed": True,
                "SUVerifyUpdateBeforeExtraction": True, "SUSignedFeedFailureExpirationInterval": 0,
                "SUAllowsAutomaticUpdates": False, "SUAutomaticallyUpdate": False}
    for field, value in expected.items():
        if info.get(field) != value:
            raise ValueError("Release app has unexpected " + field)
    build = info.get("CFBundleVersion", "")
    version = info.get("CFBundleShortVersionString", "")
    if not isinstance(build, str) or not re.fullmatch(r"[1-9][0-9]{0,3}", build) or int(build) <= previous:
        raise ValueError("Release build must exceed the declared previous build")
    if not isinstance(version, str) or not re.fullmatch(r"[0-9]+\.[0-9]+(?:\.[0-9]+)?", version):
        raise ValueError("Invalid release version")
    return version, build


def validate_appcast(path, plan, archive):
    root = ET.parse(path).getroot()
    items = root.findall("./channel/item")
    if len(items) != 1:
        raise ValueError("Initial candidate feed must contain exactly one reviewed release")
    item = items[0]
    enclosure = item.find("enclosure")
    if enclosure is None:
        raise ValueError("Missing update enclosure")
    version = item.findtext("{" + NAMESPACE + "}version") or enclosure.get("{" + NAMESPACE + "}version")
    if version != plan["build"]:
        raise ValueError("Appcast build does not match the app")
    url = enclosure.get("url", "")
    if url != plan["urls"]["zip"] or urlsplit(url).scheme != "https":
        raise ValueError("Appcast enclosure must be the reviewed HTTPS URL")
    if enclosure.get("length") != str(archive.stat().st_size):
        raise ValueError("Appcast enclosure size mismatch")
    signature = enclosure.get("{" + NAMESPACE + "}edSignature", "")
    try:
        if len(base64.b64decode(signature, validate=True)) != 64:
            raise ValueError("Invalid update signature")
    except ValueError:
        raise ValueError("Missing or malformed enclosure EdDSA signature") from None
    if "sparkle-signatures:" not in path.read_text():
        raise ValueError("Appcast has no embedded feed signature")
    return signature


def plan_release(args):
    app = args.app.resolve(strict=True)
    archive = args.sparkle_archive.resolve(strict=True)
    output = args.output.resolve()
    if not app.is_dir() or app.suffix != ".app" or app.is_symlink():
        raise ValueError("Input must be an existing final application bundle")
    if output.exists() or not output.parent.is_dir():
        raise ValueError("Use a fresh output directory under an existing parent")
    if app == output or app in output.parents or output in app.parents:
        raise ValueError("Output must be separate from the input app")
    if not re.fullmatch(r"stable[1-9][0-9]*", args.release_label):
        raise ValueError("Release label must be stable plus a positive integer")
    if args.previous_build < 1:
        raise ValueError("Previous published build must be positive")
    if sha(archive) != SPARKLE_SHA:
        raise ValueError("Official Sparkle 2.10.1 archive checksum mismatch")
    info = plistlib.load((app / "Contents/Info.plist").open("rb"))
    version, build = validate_metadata(info, args.previous_build)
    run(["codesign", "--verify", "--deep", "--strict", app])
    framework = app / "Contents/Frameworks/Sparkle.framework/Resources/Info.plist"
    if plistlib.load(framework.open("rb"))["CFBundleShortVersionString"] != "2.10.1":
        raise ValueError("Input application must bundle official Sparkle 2.10.1")
    architectures = run(["lipo", "-archs", app / "Contents/MacOS/CodexHub"]).split()
    if set(architectures) == {"arm64", "x86_64"}:
        architecture = "universal"
    elif architectures in (["arm64"], ["x86_64"]):
        architecture = architectures[0]
    else:
        raise ValueError("Unsupported release architecture")
    stem = f"codex-phone-assistant-macos-{architecture}-{version}-build{build}-{args.release_label}"
    prefix = FEED_URL.rsplit("/", 1)[0] + "/"
    notes = args.notes.resolve(strict=True) if args.notes else None
    if notes and (not notes.is_file() or notes.suffix not in (".html", ".md", ".txt")):
        raise ValueError("Release notes must be an explicitly reviewed HTML, Markdown or text file")
    return {"app": str(app), "appTreeSHA256": tree_sha(app), "output": str(output),
            "releaseScriptSHA256": sha(Path(__file__).resolve()),
            "version": version, "build": build, "previousPublishedBuild": args.previous_build,
            "releaseLabel": args.release_label, "architecture": architecture,
            "sparkleArchive": str(archive), "sparkleSHA256": SPARKLE_SHA,
            "keychainAccount": ACCOUNT, "publicKey": PUBLIC_KEY, "feedURL": FEED_URL,
            "notes": str(notes) if notes else None, "notesSHA256": sha(notes) if notes else None,
            "files": {"zip": stem + ".zip", "dmg": stem + ".dmg", "appcast": "appcast.xml"},
            "urls": {"zip": prefix + stem + ".zip", "dmg": prefix + stem + ".dmg", "appcast": FEED_URL},
            "publishes": False, "replacesInstalledApplication": False}


def execute(plan):
    output = Path(plan["output"])
    with tempfile.TemporaryDirectory(prefix="codex-macos-release-", dir=output.parent) as temporary:
        work = Path(temporary)
        distribution = work / "sparkle"
        distribution.mkdir()
        with tarfile.open(plan["sparkleArchive"], "r:xz") as source:
            # The entire archive is pinned above. Extract only the official
            # framework/tools, retaining framework symlinks required by macOS.
            members = [member for member in source.getmembers() if member.name.lstrip("./").split("/", 1)[0] in ("bin", "Sparkle.framework")]
            source.extractall(distribution, members=members)
        tools = distribution / "bin"
        public = run([tools / "generate_keys", "--account", ACCOUNT, "-p"], timeout=120)
        if public != PUBLIC_KEY:
            raise ValueError("Project Keychain account does not match the app's public key")
        assets = work / "assets"
        assets.mkdir()
        snapshot = work / "snapshot" / "codex手机助手.app"
        snapshot.parent.mkdir()
        run(["ditto", plan["app"], snapshot])
        if tree_sha(snapshot) != plan["appTreeSHA256"] or tree_sha(Path(plan["app"])) != plan["appTreeSHA256"]:
            raise ValueError("Reviewed app changed before packaging")
        run(["codesign", "--verify", "--deep", "--strict", snapshot])
        feed_input = work / "feed-input"
        feed_input.mkdir()
        zip_path = feed_input / plan["files"]["zip"]
        run(["ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", snapshot, zip_path])
        if plan["notes"]:
            notes = Path(plan["notes"])
            if sha(notes) != plan["notesSHA256"]:
                raise ValueError("Reviewed notes changed before packaging")
            shutil.copyfile(notes, zip_path.with_suffix(notes.suffix))
        appcast = assets / "appcast.xml"
        run([tools / "generate_appcast", "--account", ACCOUNT, "--maximum-deltas", "0",
             "--download-url-prefix", FEED_URL.rsplit("/", 1)[0] + "/", "--embed-release-notes", "-o", appcast, feed_input], timeout=120)
        signature = validate_appcast(appcast, plan, zip_path)
        run([tools / "sign_update", "--account", ACCOUNT, "--verify", zip_path, signature], timeout=120)
        run([tools / "sign_update", "--account", ACCOUNT, "--verify", appcast], timeout=120)
        shutil.copyfile(zip_path, assets / zip_path.name)
        dmg_root = work / "dmg-root"
        dmg_root.mkdir()
        run(["ditto", snapshot, dmg_root / snapshot.name])
        os.symlink("/Applications", dmg_root / "Applications")
        dmg = assets / plan["files"]["dmg"]
        run(["hdiutil", "create", "-volname", "codex手机助手", "-srcfolder", dmg_root, "-format", "UDZO", dmg])
        run(["hdiutil", "verify", dmg])
        dmg_signature = run([tools / "sign_update", "--account", ACCOUNT, "-p", dmg], timeout=120)
        run([tools / "sign_update", "--account", ACCOUNT, "--verify", dmg, dmg_signature], timeout=120)
        receipt = {"reviewedPlan": plan, "artifacts": {path.name: {"sha256": sha(path), "bytes": path.stat().st_size} for path in sorted(assets.iterdir())},
                   "signatures": {plan["files"]["zip"]: signature, plan["files"]["dmg"]: dmg_signature},
                   "verified": ["ZIP EdDSA", "appcast embedded EdDSA", "DMG EdDSA", "DMG container", "input app codesign"],
                   "uploaded": False}
        (assets / "macos-release.json").write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n")
        checksums = "".join(f"{sha(path)}  {path.name}\n" for path in sorted(assets.iterdir()))
        (assets / "SHA256SUMS.txt").write_text(checksums)
        if output.exists():
            raise ValueError("Output appeared after review; refusing to overwrite")
        assets.rename(output)
    return {"status": "LOCAL_CANDIDATE_SIGNED", "output": str(output), "uploaded": False}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--app", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--sparkle-archive", type=Path, required=True)
    parser.add_argument("--release-label", required=True)
    parser.add_argument("--previous-build", type=int, required=True)
    parser.add_argument("--notes", type=Path)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--reviewed-plan-sha256")
    args = parser.parse_args()
    plan = plan_release(args)
    canonical = json.dumps(plan, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    review_hash = hashlib.sha256(canonical).hexdigest()
    if not args.execute:
        print(json.dumps({"status": "DRY_RUN_REVIEW_REQUIRED", "planSHA256": review_hash, "plan": plan}, ensure_ascii=False, indent=2))
        return
    if args.reviewed_plan_sha256 != review_hash:
        raise ValueError("Review the current dry-run plan, then pass its exact --reviewed-plan-sha256")
    print(json.dumps(execute(plan), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
