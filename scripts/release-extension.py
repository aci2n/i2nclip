#!/usr/bin/env python3
"""Build the add-on XPI, refresh extension/updates.json, and create a GitHub release."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "manifest.json"
UPDATES = ROOT / "extension" / "updates.json"
XPI_OUT = ROOT / "dist" / "i2nclip.xpi"
XPI_ASSET = "i2nclip.xpi"
ADDON_ID = "i2nclip@i2n"


def main() -> int:
    repo = os.environ.get("GH_REPO", "aci2n/i2nclip")
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    version = manifest.get("version")
    if not version or not re.fullmatch(r"\d+\.\d+\.\d+", version):
        print(f"manifest.json version must be semver (got {version!r})", file=sys.stderr)
        return 1

    pack = ROOT / "scripts" / "pack-extension.py"
    subprocess.run([sys.executable, str(pack)], check=True, cwd=ROOT)
    if not XPI_OUT.is_file():
        print(f"missing {XPI_OUT}", file=sys.stderr)
        return 1

    tag = f"v{version}"
    update_link = f"https://github.com/{repo}/releases/download/{tag}/{XPI_ASSET}"
    digest = hashlib.sha256(XPI_OUT.read_bytes()).hexdigest()
    entry = {
        "version": version,
        "update_link": update_link,
        "update_hash": f"sha256:{digest}",
    }
    write_updates(entry)

    if shutil.which("gh") is None:
        print("gh CLI not found; wrote updates.json and dist/i2nclip.xpi only", file=sys.stderr)
        return 1

    gh = ["gh", "release", "create", tag, str(XPI_OUT), "--repo", repo, "--title", tag]
    notes = os.environ.get("RELEASE_NOTES")
    if notes:
        gh.extend(["--notes", notes])
    else:
        gh.append("--generate-notes")

    if release_exists(repo, tag):
        subprocess.run(
            ["gh", "release", "upload", tag, str(XPI_OUT), "--repo", repo, "--clobber"],
            check=True,
        )
        print(f"Uploaded {XPI_ASSET} to existing release {tag}")
    else:
        subprocess.run(gh, check=True)
        print(f"Created release {tag}")

    print(f"Push {UPDATES.relative_to(ROOT)} on master so update_url serves the new manifest.")
    return 0


def release_exists(repo: str, tag: str) -> bool:
    proc = subprocess.run(
        ["gh", "release", "view", tag, "--repo", repo],
        capture_output=True,
    )
    return proc.returncode == 0


def write_updates(entry: dict[str, str]) -> None:
    data: dict = {"addons": {ADDON_ID: {"updates": []}}}
    if UPDATES.is_file():
        data = json.loads(UPDATES.read_text(encoding="utf-8"))
    updates = data.setdefault("addons", {}).setdefault(ADDON_ID, {}).setdefault("updates", [])
    updates = [u for u in updates if u.get("version") != entry["version"]]
    updates.insert(0, entry)
    data["addons"][ADDON_ID]["updates"] = updates
    UPDATES.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {UPDATES.relative_to(ROOT)}")


if __name__ == "__main__":
    raise SystemExit(main())
