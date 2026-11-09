#!/usr/bin/env python3
"""Build the static-only stable43 package without accessing production."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import tarfile

ROOT = Path(__file__).resolve().parents[1]
FILES = ["public/desktop.js", "public/desktop.html"]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    hashes = {}
    for name in FILES:
        destination = output / "payload" / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / name, destination)
        hashes[name] = hashlib.sha256(destination.read_bytes()).hexdigest()
    (output / "manifest.json").write_text(json.dumps({"version": "20261109-stable43", "files": hashes}, indent=2) + "\n")
    shutil.copyfile(ROOT / "scripts/stable43-static-transaction.py", output / "stable43-static-transaction.py")
    archive = output.with_suffix(".tar.gz")
    with tarfile.open(archive, "w:gz") as handle:
        for path in sorted(output.rglob("*")):
            if path.is_file():
                handle.add(path, arcname=str(path.relative_to(output)), recursive=False)
    print(json.dumps({"directory": str(output), "archive": str(archive), "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(), "files": hashes}, indent=2))


if __name__ == "__main__":
    main()
