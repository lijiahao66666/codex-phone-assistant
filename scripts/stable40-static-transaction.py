#!/usr/bin/env python3
"""Verify and publish stable40 static files in both live directories."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

PACKAGE = Path(__file__).resolve().parent
BASELINE = {"desktop.html": "a7c8cd3c811edba010ea272cd163d7a19d029e9d5ac4261c10cccae5ed70dbd6", "desktop.js": "8ddedd5ccd9917de40159e026ec9304ce3e1b23f0c7d74af6bea34c94e5b5353"}
SERVER_SHA = "6a51fcf73a5f932f339db08c6ca5e9fa2765ba1f51124d356a82c1be544282dd"
NAMES = ("desktop.js", "desktop.html")


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def replace(source, destination):
    previous = destination.stat()
    descriptor, name = tempfile.mkstemp(prefix=".stable40-", dir=destination.parent)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(source.read_bytes())
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(name, previous.st_mode & 0o777)
        os.chown(name, previous.st_uid, previous.st_gid)
        os.replace(name, destination)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def public_hash(origin, path):
    request = urllib.request.Request(origin.rstrip("/") + path, headers={"Cache-Control": "no-cache", "Accept-Encoding": "identity"})
    for attempt in range(10):
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                assert response.status == 200 and "no-store" in response.headers.get("Cache-Control", ""), "Unexpected public status or cache policy"
                return hashlib.sha256(response.read()).hexdigest()
        except urllib.error.HTTPError as error:
            if error.code not in (502, 503, 504) or attempt == 9:
                raise
        except (urllib.error.URLError, TimeoutError):
            if attempt == 9:
                raise
        time.sleep(1)


def main():
    if not __debug__:
        raise RuntimeError("Assertions must be enabled for deployment")
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["preflight", "deploy", "rollback"])
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--service", required=True)
    parser.add_argument("--node", type=Path, required=True)
    parser.add_argument("--origin", required=True)
    parser.add_argument("--backup", type=Path)
    args = parser.parse_args()
    root = args.root.resolve(strict=True)
    assert re.search(r"(?:from\s*|import\s*)['\"]\./pair-relay\.mjs['\"]", (root / "pair-relay-managed.mjs").read_text()), "Unexpected managed wrapper"
    match = re.fullmatch(r"\s*export\s*\{\s*createPairRelay\s*\}\s*from\s*['\"](\./[^'\"]+)['\"];?\s*", (root / "pair-relay.mjs").read_text())
    assert match, "Unexpected relay entry"
    server = (root / match.group(1)).resolve(strict=True)
    assert root in server.parents and digest(server) == SERVER_SHA, "Relay baseline changed"
    dirs = list(dict.fromkeys([root / "public", server.parent.parent.parent / "public"]))
    for directory in dirs:
        assert directory.is_dir() and not directory.is_symlink() and root in directory.resolve().parents, "Unexpected static directory"
        for name in NAMES:
            assert (directory / name).is_file() and not (directory / name).is_symlink(), "Unexpected static file"
    manifest = json.loads((PACKAGE / "manifest.json").read_text())
    assert manifest["version"] == "20261109-stable40" and set(manifest["files"]) == {"public/" + n for n in NAMES}, "Unexpected manifest"
    for name, expected in manifest["files"].items():
        assert digest(PACKAGE / "payload" / name) == expected, "Package hash mismatch"
    assert "20261109-stable40" in (PACKAGE / "payload/public/desktop.html").read_text(), "Wrong HTML version"
    subprocess.run([str(args.node), "--check", str(PACKAGE / "payload/public/desktop.js")], check=True, timeout=15)
    subprocess.run(["systemctl", "is-active", "--quiet", args.service], check=True, timeout=15)
    unit = subprocess.check_output(["systemctl", "show", args.service, "--property=WorkingDirectory,ExecStart"], text=True, timeout=15)
    assert f"WorkingDirectory={root}" in unit.splitlines() and str(root / "pair-relay-managed.mjs") in unit, "Service does not run the inspected application"
    with (root / ".stable36-deploy.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        live = {str((directory / name).relative_to(root)): directory / name for directory in dirs for name in NAMES}
        def restore(backup):
            errors = []
            for key, path in live.items():
                try:
                    replace(backup / "static" / key, path)
                except Exception as error:
                    errors.append(str(error))
            if errors:
                raise RuntimeError("Static rollback incomplete: " + "; ".join(errors))
        if args.action == "rollback":
            assert args.backup, "Backup required"
            backup = args.backup.resolve(strict=True)
            assert (root / "backups").resolve() in backup.parents, "Backup outside application"
            receipt = json.loads((backup / "transaction.json").read_text())
            assert set(receipt["before"]) == set(live), "Backup paths mismatch"
            for key, path in live.items():
                assert digest(backup / "static" / key) == receipt["before"][key], "Backup hash mismatch"
                assert digest(path) in (receipt["before"][key], manifest["files"]["public/" + path.name]), "Live file changed since deploy"
            restore(backup)
            assert public_hash(args.origin, "/") == BASELINE["desktop.html"] and public_hash(args.origin, "/desktop.js?v=stable40-rollback") == BASELINE["desktop.js"], "Rollback public verification failed"
            print(json.dumps({"status": "ROLLED_BACK_STATIC", "backup": str(backup), "serviceRestarted": False, "databaseTouched": False}))
            return
        pairs = [{name: digest(directory / name) for name in NAMES} for directory in dirs]
        assert all(pair == BASELINE for pair in pairs), "Static baseline changed"
        assert public_hash(args.origin, "/") == BASELINE["desktop.html"] and public_hash(args.origin, "/desktop.js?v=stable40-preflight") == BASELINE["desktop.js"], "Public baseline mismatch"
        before = {key: digest(path) for key, path in live.items()}
        if args.action == "preflight":
            print(json.dumps({"status": "PREFLIGHT_OK", "server": str(server), "before": before}))
            return
        backup = root / "backups" / ("stable40-" + time.strftime("%Y%m%d-%H%M%S") + "-" + str(os.getpid()))
        backup.mkdir(parents=True, mode=0o700)
        for key, path in live.items():
            destination = backup / "static" / key
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, destination)
        (backup / "transaction.json").write_text(json.dumps({"before": before}, indent=2) + "\n")
        try:
            for name in NAMES:
                for directory in dirs:
                    replace(PACKAGE / "payload/public" / name, directory / name)
            for name, path in [("desktop.html", "/"), ("desktop.js", "/desktop.js?v=20261109-stable40")]:
                expected = manifest["files"]["public/" + name]
                assert all(digest(directory / name) == expected for directory in dirs) and public_hash(args.origin, path) == expected, "Published resource mismatch"
            subprocess.run(["systemctl", "is-active", "--quiet", args.service], check=True, timeout=15)
            assert digest(server) == SERVER_SHA, "Relay changed during deployment"
        except BaseException:
            restore(backup)
            raise
        print(json.dumps({"status": "STATIC_DEPLOYED", "backup": str(backup), "serviceRestarted": False, "databaseTouched": False, "files": manifest["files"]}))


if __name__ == "__main__":
    main()
