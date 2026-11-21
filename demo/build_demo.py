#!/usr/bin/env python3
"""Build the static GitHub Pages demo.

Indexes a fonts folder with the real server code, then writes a static site:
  <out>/index.html, static/      the normal front end, with demo mode switched on
  <out>/demo/library.json        what /api/library would return
  <out>/demo/family/<key>.json   what /api/family/<key> would return
  <out>/demo/chars/<id>.json     glyph lists
  <out>/demo/fonts/<id>          one browser-loadable file per face
  <out>/demo/zip/<key>.zip       family downloads

Usage: python demo/build_demo.py <fonts-dir> <out-dir> [repo-url]
"""
import json
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main(fonts, out, repo):
    fonts, out = Path(fonts).resolve(), Path(out).resolve()
    data = Path(tempfile.mkdtemp(prefix="typestash-demo-"))
    os.environ["TYPESTASH_FONTS"] = str(fonts)
    os.environ["TYPESTASH_DATA"] = str(data)
    sys.path.insert(0, str(ROOT / "app"))
    import server  # noqa: E402  (reads the env vars above at import)

    server.scan()
    lib = server.library()
    if lib["broken"]:
        print("unreadable fonts:", lib["broken"])
    lib["scan"] = {"scanning": False, "done": 0, "total": 0, "last": time.time(), "errors": 0}

    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(ROOT / "app" / "static", out / "static")
    demo = out / "demo"
    for sub in ("family", "chars", "fonts", "zip"):
        (demo / sub).mkdir(parents=True)

    def dump(path, obj):
        path.write_text(json.dumps(obj, separators=(",", ":")), encoding="utf-8")

    dump(demo / "library.json", lib)
    faces = 0
    for fam in lib["families"]:
        f = server.family(fam["key"])
        # Paths on the build machine are meaningless to visitors; keep them relative.
        dump(demo / "family" / f"{fam['key']}.json", f)
        for face in f["faces"]:
            row = server.face_row(face["id"])
            src, _ = server.face_bytes_path(row)
            shutil.copyfile(src, demo / "fonts" / face["id"])
            dump(demo / "chars" / f"{face['id']}.json", server.chars(face["id"]))
            faces += 1
        tmp, _ = server.family_zip(fam["key"])
        (demo / "zip" / f"{fam['key']}.zip").write_bytes(tmp.read())

    html = (ROOT / "app" / "static" / "index.html").read_text(encoding="utf-8")
    flag = f"<script>window.TYPESTASH_DEMO = {json.dumps({'repo': repo})};</script>\n"
    html = html.replace('<script src="static/app.js">', flag + '<script src="static/app.js">')
    (out / "index.html").write_text(html, encoding="utf-8")
    (out / ".nojekyll").write_text("")
    shutil.copyfile(ROOT / "app" / "static" / "favicon.svg", out / "favicon.svg")
    size = sum(p.stat().st_size for p in out.rglob("*") if p.is_file())
    print(f"demo: {len(lib['families'])} families, {faces} faces, {size / 1048576:.1f} MB -> {out}")
    shutil.rmtree(data, ignore_errors=True)


if __name__ == "__main__":
    if len(sys.argv) not in (3, 4):
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) == 4 else "https://github.com/jatinkrmalik/typestash")
