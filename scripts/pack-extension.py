#!/usr/bin/env python3
"""Build and pack the Firefox add-on. Source and development tools stay out."""

import pathlib
import subprocess
import zipfile

root = pathlib.Path(__file__).resolve().parent.parent
subprocess.run(["npm", "run", "build:extension"], cwd=root / "client", check=True)
out = root / "client/dist/i2nclip.xpi"
out.parent.mkdir(parents=True, exist_ok=True)
built = root / "client/dist/extension"
paths = [path for path in built.rglob("*") if path.is_file() and path.name != "updates.json"]

with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as archive:
    for path in sorted(paths):
        archive.write(path, path.relative_to(built).as_posix())

print(out.relative_to(root))
