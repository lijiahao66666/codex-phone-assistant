#!/usr/bin/env python3
"""Publish stable46 relay and static files with an exact baseline and rollback."""
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
BASELINE = {
    "desktop.html": "673e3b6981418e518f1a372691a21eaa4ab55e416cc411a40017e005d3de4f0d",
    "desktop.js": "efdc6efbd1d63376363d7ed7bd8f9fd985b8987bfb7333b4bf501d5c519d85ed",
    "desktop.css": "89c109fec370de497d7efdf10ea6e67683bbadc8d1e9f790e16cb60f1756998a",
}
SERVER_SHA = "6a51fcf73a5f932f339db08c6ca5e9fa2765ba1f51124d356a82c1be544282dd"
NAMES = ("desktop.js", "desktop.css", "desktop.html")
SERVER_PAYLOAD = "src/relay/server.mjs"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def replace(source, destination):
    previous = destination.stat()
    descriptor, name = tempfile.mkstemp(prefix=".stable46-", dir=destination.parent)
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
    parser.add_argument("--restart-idle-confirmed", action="store_true", help="Operator has verified no unresolved send, upload, approval, model or recovery operation; streams will reconnect")
    args = parser.parse_args()
    if args.action in ("deploy", "rollback"):
        assert args.restart_idle_confirmed, "Verify unresolved operations immediately before relay restart"
    root = args.root.resolve(strict=True)
    assert re.search(r"(?:from\s*|import\s*)['\"]\./pair-relay\.mjs['\"]", (root / "pair-relay-managed.mjs").read_text()), "Unexpected managed wrapper"
    match = re.fullmatch(r"\s*export\s*\{\s*createPairRelay\s*\}\s*from\s*['\"](\./[^'\"]+)['\"];?\s*", (root / "pair-relay.mjs").read_text())
    assert match, "Unexpected relay entry"
    server = (root / match.group(1)).resolve(strict=True)
    assert root in server.parents and server.is_file(), "Relay outside application"
    dirs = list(dict.fromkeys([root / "public", server.parent.parent.parent / "public"]))
    for directory in dirs:
        assert directory.is_dir() and not directory.is_symlink() and root in directory.resolve().parents, "Unexpected static directory"
        for name in NAMES:
            assert (directory / name).is_file() and not (directory / name).is_symlink(), "Unexpected static file"
    manifest = json.loads((PACKAGE / "manifest.json").read_text())
    expected_payloads = {"public/" + name for name in NAMES} | {SERVER_PAYLOAD}
    assert manifest["version"] == "20261109-stable46" and set(manifest["files"]) == expected_payloads, "Unexpected manifest"
    for name, expected in manifest["files"].items():
        assert digest(PACKAGE / "payload" / name) == expected, "Package hash mismatch"
    assert "20261109-stable46" in (PACKAGE / "payload/public/desktop.html").read_text(), "Wrong HTML version"
    for name in ("public/desktop.js", SERVER_PAYLOAD):
        subprocess.run([str(args.node), "--check", str(PACKAGE / "payload" / name)], check=True, timeout=15)
    if args.action != "rollback":
        subprocess.run(["systemctl", "is-active", "--quiet", args.service], check=True, timeout=15)
    unit = subprocess.check_output(["systemctl", "show", args.service, "--property=WorkingDirectory,ExecStart", "--no-pager"], text=True, timeout=15)
    assert f"WorkingDirectory={root}" in unit.splitlines() and str(root / "pair-relay-managed.mjs") in unit, "Service does not run the inspected application"
    # The existing lock coordinates releases; it does not drain requests.
    with (root / ".stable36-deploy.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        live = {str((directory / name).relative_to(root)): directory / name for directory in dirs for name in NAMES}
        server_key = str(server.relative_to(root))

        def verify_resources(expected, suffix):
            for name in NAMES:
                path = "/" if name == "desktop.html" else "/" + name + "?v=" + suffix
                assert all(digest(directory / name) == expected[name] for directory in dirs) and public_hash(args.origin, path) == expected[name], "Published resource mismatch: " + name

        def restart():
            subprocess.run(["systemctl", "restart", args.service], check=True, timeout=30)
            subprocess.run(["systemctl", "is-active", "--quiet", args.service], check=True, timeout=15)

        def restore(backup):
            # Attempt every file and the restart, even if an earlier restore fails.
            errors = []
            for key, path in live.items():
                try:
                    replace(backup / "static" / key, path)
                except BaseException as error:
                    errors.append(str(error))
            try:
                replace(backup / "server.mjs", server)
            except BaseException as error:
                errors.append(str(error))
            try:
                restart()
            except BaseException as error:
                errors.append(str(error))
            try:
                assert digest(server) == SERVER_SHA, "Restored relay hash mismatch"
                verify_resources(BASELINE, "stable46-rollback")
            except BaseException as error:
                errors.append(str(error))
            if errors:
                raise RuntimeError("Rollback incomplete: " + "; ".join(errors))

        if args.action == "rollback":
            assert args.backup, "Backup required"
            backup = args.backup.resolve(strict=True)
            assert (root / "backups").resolve() in backup.parents, "Backup outside application"
            receipt = json.loads((backup / "transaction.json").read_text())
            assert receipt["version"] == "20261109-stable46" and receipt["server"] == server_key and receipt["serverBefore"] == SERVER_SHA, "Backup relay mismatch"
            assert set(receipt["before"]) == set(live), "Backup paths mismatch"
            assert digest(backup / "server.mjs") == SERVER_SHA, "Backup relay hash mismatch"
            assert digest(server) in (SERVER_SHA, manifest["files"][SERVER_PAYLOAD]), "Relay changed since deploy"
            for key, path in live.items():
                assert receipt["before"][key] == BASELINE[path.name], "Unexpected backup baseline"
                assert digest(backup / "static" / key) == receipt["before"][key], "Backup hash mismatch"
                assert digest(path) in (receipt["before"][key], manifest["files"]["public/" + path.name]), "Live file changed since deploy"
            restore(backup)
            print(json.dumps({"status": "ROLLED_BACK_FULL", "backup": str(backup), "serviceRestarted": True, "databaseTouched": False}))
            return
        assert digest(server) == SERVER_SHA, "Relay baseline changed"
        pairs = [{name: digest(directory / name) for name in NAMES} for directory in dirs]
        assert all(pair == BASELINE for pair in pairs), "Static baseline changed"
        verify_resources(BASELINE, "stable46-preflight")
        before = {key: digest(path) for key, path in live.items()}
        if args.action == "preflight":
            print(json.dumps({"status": "PREFLIGHT_OK", "server": str(server), "serverBefore": SERVER_SHA, "before": before, "relayActivation": "requires just-completed idle check"}))
            return
        backup = root / "backups" / ("stable46-" + time.strftime("%Y%m%d-%H%M%S") + "-" + str(os.getpid()))
        backup.mkdir(parents=True, mode=0o700)
        for key, path in live.items():
            destination = backup / "static" / key
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, destination)
        shutil.copy2(server, backup / "server.mjs")
        receipt = {"version": "20261109-stable46", "before": before, "server": server_key, "serverBefore": SERVER_SHA, "serviceRestarted": True, "databaseTouched": False}
        (backup / "transaction.json").write_text(json.dumps(receipt, indent=2) + "\n")
        try:
            replace(PACKAGE / "payload" / SERVER_PAYLOAD, server)
            subprocess.run([str(args.node), "--check", str(server)], check=True, timeout=15)
            # Import at the real path to resolve the production dependencies.
            subprocess.run([str(args.node), "--input-type=module", "-e", "await import(process.argv[1]);", server.as_uri()], check=True, timeout=15)
            restart()
            # Publish HTML last after the new route and resources are available.
            for name in NAMES:
                for directory in dirs:
                    replace(PACKAGE / "payload/public" / name, directory / name)
            verify_resources({name: manifest["files"]["public/" + name] for name in NAMES}, "20261109-stable46")
            subprocess.run(["systemctl", "is-active", "--quiet", args.service], check=True, timeout=15)
            assert digest(server) == manifest["files"][SERVER_PAYLOAD], "Relay changed during deployment"
        except BaseException as error:
            try:
                restore(backup)
            except BaseException as rollback_error:
                raise RuntimeError("Deploy failed and automatic rollback failed: " + str(rollback_error)) from error
            raise
        print(json.dumps({"status": "FULL_DEPLOYED", "backup": str(backup), "serviceRestarted": True, "databaseTouched": False, "files": manifest["files"]}))


if __name__ == "__main__":
    main()
