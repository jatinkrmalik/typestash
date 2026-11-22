#!/usr/bin/env python3
"""Download the demo fonts listed in demo/fonts.txt from github.com/google/fonts.

One API call lists the repository; the files come from raw.githubusercontent.com
in parallel. Files already present with the right size are skipped.

Usage: python demo/fetch_fonts.py demo/fonts.txt <out-dir>
Set GITHUB_TOKEN to avoid the anonymous API limit.
"""
import json
import os
import sys
import urllib.request

try:  # use the OS certificate store when available (helps behind HTTPS-inspecting proxies)
    import truststore
    truststore.inject_into_ssl()
except ImportError:
    pass
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

TREE = "https://api.github.com/repos/google/fonts/git/trees/main?recursive=1"
RAW = "https://raw.githubusercontent.com/google/fonts/main/"


def get(url, tries=4):
    req = urllib.request.Request(url, headers={"User-Agent": "typestash-demo-builder"})
    token = os.environ.get("GITHUB_TOKEN")
    if token and url.startswith("https://api.github.com/"):
        req.add_header("Authorization", f"Bearer {token}")
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.read()
        except Exception:
            if attempt == tries - 1:
                raise


def main(listfile, out):
    out = Path(out)
    folders = {line.strip() for line in Path(listfile).read_text().splitlines()
               if line.strip() and not line.startswith("#")}
    jobs = []
    for e in json.loads(get(TREE))["tree"]:
        parts = e["path"].split("/")
        if e["type"] == "blob" and len(parts) == 3 and f"{parts[0]}/{parts[1]}" in folders \
                and parts[2].lower().endswith((".ttf", ".otf")):
            jobs.append((e["path"], out / parts[1] / parts[2], e["size"]))
    found = {"/".join(p.split("/")[:2]) for p, _, _ in jobs}
    for missing in sorted(folders - found):
        print(f"  not found in google/fonts: {missing}")

    def fetch(job):
        path, target, size = job
        if not (target.exists() and target.stat().st_size == size):
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(get(RAW + path))
        return size

    with ThreadPoolExecutor(16) as pool:
        total = sum(pool.map(fetch, jobs))
    print(f"{len(found)} families, {len(jobs)} files, {total / 1048576:.1f} MB in {out}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
