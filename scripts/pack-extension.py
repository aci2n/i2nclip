#!/usr/bin/env python3
"""Pack the Firefox add-on as an XPI (zip). The archive root is the add-on root."""

import pathlib
import zipfile

root = pathlib.Path(__file__).resolve().parent.parent
out = root / "dist" / "i2nclip.xpi"
out.parent.mkdir(parents=True, exist_ok=True)

paths = [root / "manifest.json"]
paths += [path for path in (root / "extension").rglob("*") if path.is_file()]
paths += [
    path
    for path in (root / "client").rglob("*")
    if path.is_file()
    and not path.name.endswith(".test.js")
    and path.name != "test-vectors.json"
]

with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as archive:
    for path in sorted(paths):
        archive.write(path, path.relative_to(root).as_posix())

print(out.relative_to(root))
