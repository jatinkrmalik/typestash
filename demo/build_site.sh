#!/usr/bin/env bash
# Build the whole GitHub Pages site:
#   <out>/            landing page (site/), screenshots in img/
#   <out>/demo/       the live demo (demo/build_demo.py)
# Usage: bash demo/build_site.sh <fonts-dir> <out-dir> [repo-url]
# Set PYTHON to pick the interpreter (default: python).
set -euo pipefail
cd "$(dirname "$0")/.."
fonts="$1"; out="$2"; repo="${3:-https://github.com/jatinkrmalik/typestash}"
py="${PYTHON:-python}"

rm -rf "$out"
"$py" demo/build_demo.py "$fonts" "$out/demo" "$repo"
cp -r site/. "$out/"
mkdir -p "$out/img"
cp docs/*.png app/static/icon-512.png app/static/apple-touch-icon.png "$out/img/"
cp app/static/favicon.svg "$out/"
touch "$out/.nojekyll"
du -sh "$out"
