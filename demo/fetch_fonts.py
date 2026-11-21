#!/usr/bin/env python3
"""Download the demo fonts listed in demo/fonts.txt from github.com/google/fonts.

Usage: python demo/fetch_fonts.py demo/fonts.txt <out-dir>
Set GITHUB_TOKEN to avoid the 60 requests/hour anonymous API limit.
"""
import json
import os
import sys
import urllib.request
from pathlib import Path

API = "https://api.github.com/repos/google/fonts/contents/"


def get(url, raw=False):
    req = urllib.request.Request(url, headers={"User-Agent": "typestash-demo-builder"})
    token = os.environ.get("GITHUB_TOKEN")
    if token and url.startswith("https://api.github.com/"):
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read()
    return data if raw else json.loads(data)


def main(listfile, out):
    out = Path(out)
    folders = [line.strip() for line in Path(listfile).read_text().splitlines()
               if line.strip() and not line.startswith("#")]
    total = 0
    for folder in folders:
        dest = out / folder.split("/")[-1]
        dest.mkdir(parents=True, exist_ok=True)
        for item in get(API + folder):
            if item["type"] != "file" or not item["name"].lower().endswith((".ttf", ".otf")):
                continue
            target = dest / item["name"]
            if not target.exists() or target.stat().st_size != item["size"]:
                target.write_bytes(get(item["download_url"], raw=True))
            total += item["size"]
            print(f"  {folder}/{item['name']}", flush=True)
    print(f"{len(folders)} families, {total / 1048576:.1f} MB in {out}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
