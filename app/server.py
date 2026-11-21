#!/usr/bin/env python3
"""Typestash: a self-hosted font library.

Indexes every font file under TYPESTASH_FONTS (recursively) with fontTools,
reading the real family/style names, weight, width, italic, monospace,
variable axes, designer, foundry, license and script coverage into a SQLite
index in TYPESTASH_DATA. Serves a single-page gallery plus a small JSON API:

  GET  /api/library              families + stats + scan status
  GET  /api/family/<key>         every face of one family
  GET  /api/face/<id>/chars      codepoints in a face (glyph grid)
  GET  /font/<id>                face bytes for browser preview (TTC faces extracted)
  GET  /download/<id>            original file
  GET  /download/family/<key>    whole family as a zip
  PUT  /api/upload?name=<file>   raw body: a font or a .zip of fonts
  POST /api/favorite/<key>       toggle favourite
  POST /api/rescan               re-index now

The font files stay plain files: Samba, File Browser and backups see the same
folder. Uploads are filed under <fonts>/<TYPESTASH_UPLOAD_DIR>/<Family>/.
No auth or TLS here; it runs behind Caddy + Authentik.
"""
import base64
import hashlib
import hmac
import io
import json
import os
import re
import shutil
import sqlite3
import tempfile
import threading
import time
import urllib.parse
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from fontTools.ttLib import TTCollection, TTFont

FONTS = Path(os.environ.get("TYPESTASH_FONTS", "/fonts"))
DATA = Path(os.environ.get("TYPESTASH_DATA", "/data"))
BIND = os.environ.get("TYPESTASH_BIND", "0.0.0.0")
PORT = int(os.environ.get("TYPESTASH_PORT", "8080"))
RESCAN_SECONDS = int(os.environ.get("TYPESTASH_RESCAN_SECONDS", "600"))
UPLOAD_DIR = os.environ.get("TYPESTASH_UPLOAD_DIR", "Uploads")
MAX_UPLOAD = int(os.environ.get("TYPESTASH_MAX_UPLOAD_MB", "512")) * 1024 * 1024
STATIC = Path(__file__).parent / "static"
AUTH_USER = os.environ.get("TYPESTASH_USER", "typestash")
AUTH_PASSWORD = os.environ.get("TYPESTASH_PASSWORD", "")
UPLOADS = os.environ.get("TYPESTASH_UPLOADS", "true").lower() not in ("0", "false", "no", "off")
CACHE = DATA / "cache"

FONT_EXT = {".ttf", ".otf", ".woff", ".woff2", ".ttc", ".otc"}
COLLECTION_EXT = {".ttc", ".otc"}
CATEGORIES = ("sans", "serif", "mono", "display", "script", "symbol", "other")
__version__ = "0.1.0"   # bump with each release tag
INDEX_VERSION = "7"   # bump to force a full re-index after parser changes
MIME = {".ttf": "font/ttf", ".otf": "font/otf", ".woff": "font/woff", ".woff2": "font/woff2",
        ".ttc": "font/collection", ".otc": "font/collection"}
STATIC_MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
               ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
               ".ico": "image/x-icon", ".json": "application/json"}

# ------------------------------------------------------------------ database
DATA.mkdir(parents=True, exist_ok=True)
CACHE.mkdir(parents=True, exist_ok=True)
db = sqlite3.connect(DATA / "index.db", check_same_thread=False)
db.row_factory = sqlite3.Row
dblock = threading.RLock()
with dblock:
    db.executescript("""
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS files(
        path TEXT PRIMARY KEY, size INTEGER, mtime REAL, sha TEXT, error TEXT, added REAL);
    CREATE TABLE IF NOT EXISTS faces(
        id TEXT PRIMARY KEY, path TEXT, idx INTEGER, sha TEXT,
        family TEXT, fkey TEXT, style TEXT, full TEXT, ps TEXT,
        weight INTEGER, width INTEGER, italic INTEGER, mono INTEGER, variable INTEGER,
        axes TEXT, category TEXT, designer TEXT, designer_url TEXT, foundry TEXT,
        license TEXT, license_url TEXT, version TEXT, glyphs INTEGER, chars INTEGER,
        scripts TEXT, features TEXT, fmt TEXT, size INTEGER, added REAL, metrics TEXT);
    CREATE INDEX IF NOT EXISTS faces_fkey ON faces(fkey);
    CREATE INDEX IF NOT EXISTS faces_path ON faces(path);
    CREATE TABLE IF NOT EXISTS favorites(fkey TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS notes(fkey TEXT PRIMARY KEY, note TEXT);
    CREATE TABLE IF NOT EXISTS overrides(fkey TEXT PRIMARY KEY, category TEXT);
    CREATE TABLE IF NOT EXISTS collections(id INTEGER PRIMARY KEY, name TEXT UNIQUE, color TEXT, created REAL);
    CREATE TABLE IF NOT EXISTS collection_fonts(cid INTEGER, fkey TEXT, PRIMARY KEY(cid, fkey));
    """)

with dblock:
    try:
        db.execute("ALTER TABLE faces ADD COLUMN metrics TEXT")
    except sqlite3.OperationalError:
        pass                       # already there
    _v = db.execute("SELECT v FROM meta WHERE k='index_version'").fetchone()
    if not _v or _v[0] != INDEX_VERSION:
        db.execute("DELETE FROM files")
        db.execute("DELETE FROM faces")
        db.execute("INSERT OR REPLACE INTO meta(k, v) VALUES('index_version', ?)", (INDEX_VERSION,))
        db.commit()

scan_state = {"scanning": False, "done": 0, "total": 0, "last": 0, "errors": 0}
scan_lock = threading.Lock()
cache_lock = threading.Lock()


# ------------------------------------------------------------------ font parsing
def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-") or "untitled"


def name_of(font, *ids):
    table = font.get("name") if "name" in font else None
    if table is None:
        return ""
    for i in ids:
        s = None
        # Prefer Windows/Unicode English records; Mac Roman ones are often mis-encoded.
        rec = table.getName(i, 3, 1, 0x409) or next(
            (r for r in table.names if r.nameID == i and r.platformID in (0, 3)), None)
        if rec is not None:
            try:
                s = rec.toUnicode()
            except Exception:  # noqa: BLE001
                s = None
        if not s:
            try:
                s = table.getDebugName(i)
            except Exception:  # noqa: BLE001
                s = None
        if s and s.strip():
            return fix_mojibake(s.strip())
    return ""


def fix_mojibake(s):
    """Some fonts store Mac Roman bytes in their Unicode name records, so 'é'
    arrives as U+008E. C1 control characters never belong in a name: map them
    back through Mac Roman."""
    if not any(0x80 <= ord(c) <= 0x9F for c in s):
        return s
    return "".join(bytes([ord(c)]).decode("mac_roman") if 0x80 <= ord(c) <= 0x9F else c for c in s)


SCRIPT_TESTS = [
    # (label, codepoint range, how many must be present)
    ("Latin", (0x41, 0x7A), 52),
    ("Latin Extended", (0x100, 0x17F), 64),
    ("Greek", (0x391, 0x3C9), 45),
    ("Cyrillic", (0x410, 0x44F), 56),
    ("Hebrew", (0x5D0, 0x5EA), 22),
    ("Arabic", (0x621, 0x64A), 30),
    ("Devanagari", (0x905, 0x939), 40),
    ("Bengali", (0x985, 0x9B9), 30),
    ("Tamil", (0xB85, 0xBB9), 20),
    ("Thai", (0xE01, 0xE2E), 40),
    ("Hangul", (0xAC00, 0xD7A3), 1000),
    ("Kana", (0x3041, 0x30FA), 120),
    ("CJK", (0x4E00, 0x9FFF), 1000),
]


def scripts_of(cps):
    out = []
    for label, (lo, hi), need in SCRIPT_TESTS:
        if label == "Latin":
            if all(c in cps for c in range(0x41, 0x5B)) and all(c in cps for c in range(0x61, 0x7B)):
                out.append(label)
            continue
        if sum(1 for c in range(lo, hi + 1) if c in cps) >= need:
            out.append(label)
    emoji = sum(1 for c in cps if 0x1F300 <= c <= 0x1FAFF)
    if emoji >= 200:
        out.append("Emoji")
    return out


KEYWORDS = [  # checked in order against the family name
    (r"\b(mono|monospace|code|coding|terminal|console)\b|mono$", "mono"),
    (r"\b(script|hand|handwriting|handwritten|brush|marker|calligraph\w*|signature|cursive)\b", "script"),
    (r"\b(sans|grotesk|grotesque|gothic)\b|sans", "sans"),
    (r"\b(serif|slab|antiqua|roman|garamond|caslon|bodoni|didot)\b", "serif"),
    (r"\b(symbol|symbols|icons?|dingbats?|emoji|wingdings|webdings)\b", "symbol"),
]
LATE_KEYWORDS = [
    (r"\b(display|poster|headline|titling|stencil|decorative|shadow|outline|inline)\b", "display"),
]


def shape_of_I(font, italic=False):
    """Guess sans/serif/script from the outline of capital I.

    Measures the ink width of the I near its foot, middle and head. Serifs
    make the foot and head much wider than the stem; a sans I is the same
    width all the way up. Anything else that is mostly curves reads as script.
    """
    try:
        from fontTools.pens.boundsPen import BoundsPen
        from fontTools.pens.pointInsidePen import PointInsidePen
        from fontTools.pens.recordingPen import RecordingPen
        gname = (font.getBestCmap() or {}).get(ord("I"))
        if not gname:
            return None
        gs = font.getGlyphSet()
        glyph = gs[gname]
        bp = BoundsPen(gs)
        glyph.draw(bp)
        if not bp.bounds:
            return None
        x0, y0, x1, y1 = bp.bounds
        h = y1 - y0
        if h <= 0 or x1 <= x0:
            return None

        def ink(frac):
            """(share of the width that is ink, centre of the ink) at height frac."""
            y = y0 + h * frac
            steps, xs = 120, []
            for i in range(steps + 1):
                x = x0 + (x1 - x0) * i / steps
                pen = PointInsidePen(gs, (x, y))
                glyph.draw(pen)
                if pen.getResult():
                    xs.append(x)
            return len(xs) / (steps + 1), (sum(xs) / len(xs) if xs else None)

        (low, _), (mid, cmid), (high, _) = ink(0.015), ink(0.5), ink(0.985)
        (_, c25), (_, c75) = ink(0.25), ink(0.75)
        slanted = c25 is not None and c75 is not None and abs(c75 - c25) / h > 0.08
        rec = RecordingPen()
        glyph.draw(rec)
        lines = sum(1 for op, _ in rec.value if op == "lineTo")
        curves = sum(len(args) for op, args in rec.value if op in ("curveTo", "qCurveTo"))
        if mid <= 0:
            return None
        if min(low, high) / mid >= 1.4:
            return "serif"
        if slanted and not italic:
            return "script"
        if max(low, high) / mid <= 1.25 and curves <= lines * 3 + 4:
            return "sans"
        if curves > lines * 2:
            return "script"
    except Exception:  # noqa: BLE001
        return None
    return None


def categorize(font, family, mono, italic=False):
    if mono:
        return "mono"
    low = family.lower()
    for pattern, cat in KEYWORDS:
        if re.search(pattern, low):
            return cat
    os2 = font["OS/2"] if "OS/2" in font else None
    if os2 is not None:
        p = getattr(os2, "panose", None)
        if p is not None:
            if p.bFamilyType == 2:
                if p.bProportion == 9:
                    return "mono"
                if p.bSerifStyle in (11, 12, 13, 14, 15):
                    return "sans"
                if 2 <= p.bSerifStyle <= 10:
                    return "serif"
            elif p.bFamilyType == 3:
                return "script"
            elif p.bFamilyType == 4:
                return "display"
            elif p.bFamilyType == 5:
                return "symbol"
        cls = (getattr(os2, "sFamilyClass", 0) or 0) >> 8
        if cls in (1, 2, 3, 4, 5, 7):
            return "serif"
        if cls == 8:
            return "sans"
        if cls == 9:
            return "display"
        if cls == 10:
            return "script"
        if cls == 12:
            return "symbol"
    shape = shape_of_I(font, italic)
    for pattern, cat in LATE_KEYWORDS:
        if re.search(pattern, low) and shape != "serif":
            return cat
    return shape or "other"


def metrics_of(font, cmap):
    """Vertical and horizontal proportions as fractions of the em, for comparing fonts."""
    out = {}
    try:
        upm = font["head"].unitsPerEm or 1000
        os2 = font["OS/2"] if "OS/2" in font else None
        hhea = font["hhea"] if "hhea" in font else None
        gs = font.getGlyphSet()

        def top_of(ch):
            g = cmap.get(ord(ch))
            if not g:
                return None
            from fontTools.pens.boundsPen import BoundsPen
            bp = BoundsPen(gs)
            gs[g].draw(bp)
            return bp.bounds[3] if bp.bounds else None

        xh = getattr(os2, "sxHeight", 0) if os2 is not None and os2.version >= 2 else 0
        ch = getattr(os2, "sCapHeight", 0) if os2 is not None and os2.version >= 2 else 0
        xh = xh or top_of("x") or 0
        ch = ch or top_of("H") or 0
        asc = (getattr(os2, "sTypoAscender", 0) if os2 is not None else 0) or (hhea.ascent if hhea else 0)
        desc = (getattr(os2, "sTypoDescender", 0) if os2 is not None else 0) or (hhea.descent if hhea else 0)
        hmtx = font["hmtx"] if "hmtx" in font else None
        widths = [hmtx[cmap[c]][0] for c in range(ord("a"), ord("z") + 1) if hmtx and c in cmap]
        r = lambda v: round(v / upm, 3)  # noqa: E731
        out = {"upm": upm, "x_height": r(xh), "cap_height": r(ch), "ascender": r(asc),
               "descender": r(abs(desc)), "width": r(sum(widths) / len(widths)) if widths else 0}
    except Exception:  # noqa: BLE001 - metrics are nice to have
        pass
    return out


def describe(font):
    """Everything we index about one face (a TTFont)."""
    family = name_of(font, 16, 1) or "Untitled"
    style = name_of(font, 17, 2) or "Regular"
    os2 = font["OS/2"] if "OS/2" in font else None
    post = font["post"] if "post" in font else None
    head = font["head"] if "head" in font else None
    weight = int(getattr(os2, "usWeightClass", 400) or 400) if os2 is not None else 400
    if weight < 100:              # some old fonts store 1..9
        weight *= 100
    weight = max(1, min(1000, weight))
    width = int(getattr(os2, "usWidthClass", 5) or 5) if os2 is not None else 5
    italic = bool(
        (os2 is not None and getattr(os2, "fsSelection", 0) & 1)
        or (head is not None and getattr(head, "macStyle", 0) & 2)
        or (post is not None and getattr(post, "italicAngle", 0))
        or re.search(r"italic|oblique", style, re.I))
    mono = bool(post is not None and getattr(post, "isFixedPitch", 0))
    variable = "fvar" in font
    axes = {}
    if variable:
        fvar = font["fvar"]
        axes["axes"] = [{"tag": a.axisTag, "name": name_of(font, a.axisNameID) or a.axisTag,
                         "min": a.minValue, "default": a.defaultValue, "max": a.maxValue}
                        for a in fvar.axes]
        axes["instances"] = [{"name": name_of(font, i.subfamilyNameID) or "", "coords": i.coordinates}
                             for i in fvar.instances]
    feats = set()
    for tag in ("GSUB", "GPOS"):
        if tag in font:
            try:
                fl = font[tag].table.FeatureList
                feats.update(fr.FeatureTag for fr in (fl.FeatureRecord if fl else []))
            except Exception:  # noqa: BLE001
                pass
    cmap = font.getBestCmap() or {}
    cps = set(cmap.keys())
    try:
        glyphs = len(font.getGlyphOrder())
    except Exception:
        glyphs = 0
    return {
        "family": family, "fkey": slug(family), "style": style,
        "full": name_of(font, 4) or f"{family} {style}", "ps": name_of(font, 6),
        "weight": weight, "width": width, "italic": int(italic), "mono": int(mono),
        "variable": int(variable), "axes": json.dumps(axes) if axes else "",
        "category": categorize(font, family, mono, italic),
        "designer": name_of(font, 9), "designer_url": name_of(font, 12),
        "foundry": name_of(font, 8), "license": name_of(font, 13), "license_url": name_of(font, 14),
        "version": name_of(font, 5), "glyphs": glyphs, "chars": len(cps),
        "scripts": ",".join(scripts_of(cps)),
        "features": ",".join(sorted(feats)),
        "metrics": json.dumps(metrics_of(font, cmap)),
    }


def faces_in(path_or_file, ext):
    """Yield (index, TTFont) for every face in a file or file-like object."""
    if ext in COLLECTION_EXT:
        coll = TTCollection(path_or_file, lazy=True)
        for i, f in enumerate(coll.fonts):
            yield i, f
    else:
        yield 0, TTFont(path_or_file, lazy=True)


def sha_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def face_id(rel, idx):
    return hashlib.sha1(f"{rel}#{idx}".encode()).hexdigest()[:16]


def index_file(path, st=None):
    """(Re)index one file. Returns number of faces, or raises on bad fonts."""
    st = st or path.stat()
    rel = path.relative_to(FONTS).as_posix()
    ext = path.suffix.lower()
    sha = sha_file(path)
    rows, error = [], None
    try:
        for idx, font in faces_in(str(path), ext):
            d = describe(font)
            d.update(id=face_id(rel, idx), path=rel, idx=idx, sha=sha, fmt=ext[1:],
                     size=st.st_size)
            rows.append(d)
    except Exception as e:  # noqa: BLE001 - any broken font is just recorded
        error = f"{type(e).__name__}: {e}"[:300]
    with dblock:
        old = db.execute("SELECT added FROM files WHERE path=?", (rel,)).fetchone()
        added = old["added"] if old and old["added"] else time.time()
        db.execute("DELETE FROM faces WHERE path=?", (rel,))
        db.execute("INSERT OR REPLACE INTO files(path,size,mtime,sha,error,added) VALUES(?,?,?,?,?,?)",
                   (rel, st.st_size, st.st_mtime, sha, error, added))
        for d in rows:
            d["added"] = added
            cols = ",".join(d)
            db.execute(f"INSERT OR REPLACE INTO faces({cols}) VALUES({','.join('?' * len(d))})",
                       list(d.values()))
        db.commit()
    return len(rows), error


def scan():
    """Walk the fonts folder, index new/changed files, drop deleted ones."""
    if not scan_lock.acquire(blocking=False):
        return
    try:
        found = {}
        for root, dirs, files in os.walk(FONTS):
            dirs[:] = [d for d in dirs if not d.startswith(".")]
            for name in files:
                p = Path(root) / name
                if p.suffix.lower() in FONT_EXT and not name.startswith("._"):
                    try:
                        found[p.relative_to(FONTS).as_posix()] = (p, p.stat())
                    except OSError:
                        pass
        with dblock:
            known = {r["path"]: (r["size"], r["mtime"]) for r in db.execute("SELECT path,size,mtime FROM files")}
        todo = [(p, st) for rel, (p, st) in found.items()
                if known.get(rel) != (st.st_size, st.st_mtime)]
        gone = [rel for rel in known if rel not in found]
        scan_state.update(scanning=True, done=0, total=len(todo))
        if gone:
            with dblock:
                for rel in gone:
                    db.execute("DELETE FROM faces WHERE path=?", (rel,))
                    db.execute("DELETE FROM files WHERE path=?", (rel,))
                db.commit()
        for p, st in todo:
            try:
                index_file(p, st)
            except OSError:
                pass
            scan_state["done"] += 1
        with dblock:
            scan_state["errors"] = db.execute("SELECT COUNT(*) FROM files WHERE error IS NOT NULL").fetchone()[0]
        if todo or gone:
            print(f"scan: {len(todo)} indexed, {len(gone)} removed, {len(found)} files", flush=True)
    finally:
        scan_state.update(scanning=False, last=time.time())
        scan_lock.release()


def scan_loop():
    while True:
        try:
            scan()
        except Exception as e:  # noqa: BLE001
            print(f"scan failed: {e}", flush=True)
        time.sleep(RESCAN_SECONDS)


# ------------------------------------------------------------------ library views
def face_public(r):
    d = dict(r)
    d["axes"] = json.loads(d["axes"]) if d["axes"] else None
    d["scripts"] = [s for s in (d["scripts"] or "").split(",") if s]
    d["features"] = [s for s in (d["features"] or "").split(",") if s]
    d["metrics"] = json.loads(d["metrics"]) if d.get("metrics") else {}
    d["italic"], d["mono"], d["variable"] = bool(d["italic"]), bool(d["mono"]), bool(d["variable"])
    return d


def unique_faces(rows):
    """Drop exact duplicate files (same hash + face index), keep the shortest path."""
    best = {}
    for r in rows:
        k = (r["sha"], r["idx"])
        if k not in best or len(r["path"]) < len(best[k]["path"]):
            best[k] = r
    return list(best.values())


def rep_face(faces):
    return min(faces, key=lambda f: (f["italic"], abs(f["weight"] - 400), abs(f["width"] - 5), f["style"]))


def curation():
    """Favourites, notes and collection membership, loaded once per request."""
    with dblock:
        favs = {r[0] for r in db.execute("SELECT fkey FROM favorites")}
        notes = {r[0]: r[1] for r in db.execute("SELECT fkey, note FROM notes")}
        cats = {r[0]: r[1] for r in db.execute("SELECT fkey, category FROM overrides")}
        member = {}
        for cid, fk in db.execute("SELECT cid, fkey FROM collection_fonts"):
            member.setdefault(fk, []).append(cid)
        colls = [dict(r) for r in db.execute(
            "SELECT c.id, c.name, c.color, COUNT(cf.fkey) AS count FROM collections c "
            "LEFT JOIN collection_fonts cf ON cf.cid=c.id GROUP BY c.id ORDER BY c.name COLLATE NOCASE")]
    return {"favs": favs, "notes": notes, "member": member, "collections": colls, "cats": cats}


def family_summary(fkey, faces, cur):
    rep = rep_face(faces)
    cats = [f["category"] for f in faces]
    scripts = []
    for f in faces:
        for s in (f["scripts"] or "").split(","):
            if s and s not in scripts:
                scripts.append(s)
    pick = lambda k: next((f[k] for f in [rep, *faces] if f[k]), "")  # noqa: E731
    ordered = sorted(faces, key=lambda f: (f["italic"], f["weight"], f["width"], f["style"]))
    return {
        "key": fkey, "name": rep["family"],
        "category": cur["cats"].get(fkey) or max(sorted(set(cats)), key=cats.count),
        "category_auto": max(sorted(set(cats)), key=cats.count),
        "styles": len(faces), "rep": rep["id"],
        "faces": [{"id": f["id"], "style": f["style"], "weight": f["weight"], "italic": bool(f["italic"])}
                  for f in ordered],
        "weights": sorted({f["weight"] for f in faces}),
        "italic": any(f["italic"] for f in faces), "mono": any(f["mono"] for f in faces),
        "variable": any(f["variable"] for f in faces),
        "axes": json.loads(rep["axes"]) if rep["axes"] else None,
        "metrics": json.loads(rep["metrics"]) if rep["metrics"] else {},
        "glyphs": max(f["glyphs"] or 0 for f in faces),
        "designer": pick("designer"), "foundry": pick("foundry"),
        "license": pick("license")[:160], "scripts": scripts,
        "folder": str(Path(rep["path"]).parent).replace("\\", "/"),
        "files": sorted({Path(f["path"]).name for f in faces}),
        "added": max(f["added"] or 0 for f in faces),
        "size": sum(f["size"] or 0 for f in {f["path"]: f for f in faces}.values()),
        "favorite": fkey in cur["favs"],
        "note": cur["notes"].get(fkey, ""),
        "collections": cur["member"].get(fkey, []),
        "features": sorted({t for f in faces for t in (f["features"] or "").split(",") if t}),
    }


def library():
    with dblock:
        rows = db.execute("SELECT * FROM faces").fetchall()
        errors = [dict(r) for r in db.execute("SELECT path, error FROM files WHERE error IS NOT NULL ORDER BY path LIMIT 200")]
        nfiles = db.execute("SELECT COUNT(*), COALESCE(SUM(size),0) FROM files").fetchone()
    groups = {}
    for r in unique_faces(rows):
        groups.setdefault(r["fkey"], []).append(r)
    cur = curation()
    fams = [family_summary(k, v, cur) for k, v in groups.items()]
    fams.sort(key=lambda f: f["name"].lower())
    return {
        "families": fams,
        "stats": {"families": len(fams), "faces": sum(f["styles"] for f in fams),
                  "files": nfiles[0], "bytes": nfiles[1], "duplicates": len(rows) - sum(f["styles"] for f in fams),
                  "broken": len(errors)},
        "broken": errors,
        "collections": cur["collections"],
        "uploads": UPLOADS,
        "version": __version__,
        "scan": scan_state,
    }


def family(fkey):
    with dblock:
        rows = db.execute("SELECT * FROM faces WHERE fkey=?", (fkey,)).fetchall()
    if not rows:
        return None
    faces = unique_faces(rows)
    out = family_summary(fkey, faces, curation())
    out["faces"] = [face_public(f) for f in sorted(faces, key=lambda f: (f["italic"], f["weight"], f["width"], f["style"]))]
    paths = {}
    for r in rows:
        paths.setdefault(r["path"], r["size"])
    out["paths"] = [{"path": p, "size": s} for p, s in sorted(paths.items())]
    rep = next(f for f in faces if f["id"] == out["rep"])
    out["license_full"] = rep["license"] or next((f["license"] for f in faces if f["license"]), "")
    out["license_url"] = rep["license_url"] or next((f["license_url"] for f in faces if f["license_url"]), "")
    out["designer_url"] = rep["designer_url"] or ""
    out["version"] = rep["version"] or ""
    return out


def face_row(fid):
    with dblock:
        return db.execute("SELECT * FROM faces WHERE id=?", (fid,)).fetchone()


def face_bytes_path(r):
    """A path the browser can load: the file itself, or a face extracted from a collection."""
    path = FONTS / r["path"]
    if r["fmt"] not in ("ttc", "otc"):
        return path, MIME.get("." + r["fmt"], "application/octet-stream")
    out = CACHE / f"{r['id']}-{r['sha'][:12]}.{'otf' if 'CFF ' in TTFont(str(path), fontNumber=r['idx'], lazy=True) else 'ttf'}"
    with cache_lock:
        if not out.exists():
            f = TTFont(str(path), fontNumber=r["idx"])
            tmp = out.with_suffix(".tmp")
            f.save(str(tmp))
            tmp.replace(out)
    return out, MIME.get(out.suffix, "font/ttf")


def chars(fid):
    r = face_row(fid)
    if not r:
        return None
    for idx, font in faces_in(str(FONTS / r["path"]), "." + r["fmt"]):
        if idx == r["idx"]:
            return sorted(c for c in (font.getBestCmap() or {}) if c >= 0x20 and not (0x7F <= c < 0xA0))
    return []


# ------------------------------------------------------------------ uploads
def safe_name(name, fallback="font"):
    name = Path(name.replace("\\", "/")).name
    name = re.sub(r"[^\w.\-()&+ ]+", "_", name).strip(" ._")
    return (name or fallback)[:150]


def add_font_bytes(data, filename):
    """Validate, de-duplicate and file one font. Returns a result dict."""
    ext = Path(filename).suffix.lower()
    result = {"name": filename}
    if ext not in FONT_EXT:
        return {**result, "status": "skipped", "reason": "not a font file"}
    sha = hashlib.sha256(data).hexdigest()
    with dblock:
        dup = db.execute("SELECT f.path, x.family, x.fkey FROM files f LEFT JOIN faces x ON x.path=f.path "
                         "WHERE f.sha=? LIMIT 1", (sha,)).fetchone()
    if dup:
        return {**result, "status": "duplicate", "family": dup["family"], "key": dup["fkey"], "path": dup["path"]}
    try:
        fam = None
        for _, font in faces_in(io.BytesIO(data), ext):
            fam = name_of(font, 16, 1) or "Untitled"
            break
        if fam is None:
            raise ValueError("no faces")
    except Exception as e:  # noqa: BLE001
        return {**result, "status": "rejected", "reason": f"not a valid font ({type(e).__name__})"}
    folder = FONTS / UPLOAD_DIR / safe_name(fam, "Untitled")
    folder.mkdir(parents=True, exist_ok=True)
    stem, n = safe_name(Path(filename).stem), 0
    dest = folder / f"{stem}{ext}"
    while dest.exists():
        n += 1
        dest = folder / f"{stem}-{n}{ext}"
    tmp = folder / f".{dest.name}.part"
    tmp.write_bytes(data)
    tmp.replace(dest)
    index_file(dest)
    return {**result, "status": "added", "family": fam, "key": slug(fam), "path": dest.relative_to(FONTS).as_posix()}


def add_upload(fileobj, filename):
    if Path(filename).suffix.lower() == ".zip":
        results = []
        try:
            zf = zipfile.ZipFile(fileobj)
        except zipfile.BadZipFile:
            return [{"name": filename, "status": "rejected", "reason": "broken zip"}]
        total = 0
        for info in zf.infolist():
            base = Path(info.filename).name
            if info.is_dir() or base.startswith(".") or "__MACOSX" in info.filename:
                continue
            if Path(base).suffix.lower() not in FONT_EXT:
                continue
            total += info.file_size
            if info.file_size > MAX_UPLOAD or total > MAX_UPLOAD * 4:
                results.append({"name": base, "status": "rejected", "reason": "too big"})
                continue
            results.append(add_font_bytes(zf.read(info), base))
        if not results:
            results.append({"name": filename, "status": "skipped", "reason": "no fonts inside"})
        return results
    return [add_font_bytes(fileobj.read(), filename)]


def duplicates():
    """Groups of files with identical bytes (same SHA-256)."""
    with dblock:
        rows = db.execute(
            "SELECT f.sha, f.path, f.size, (SELECT family FROM faces x WHERE x.path=f.path LIMIT 1) AS family "
            "FROM files f WHERE f.sha IN (SELECT sha FROM files GROUP BY sha HAVING COUNT(*)>1) "
            "ORDER BY f.sha, length(f.path)").fetchall()
    groups = {}
    for r in rows:
        groups.setdefault(r["sha"], []).append(dict(r))
    return [{"sha": k, "family": v[0]["family"], "size": v[0]["size"], "paths": [x["path"] for x in v]}
            for k, v in groups.items()]


def zip_of(rows, title):
    if not rows:
        return None, None
    seen, files = set(), []
    for r in sorted(unique_faces(rows), key=lambda r: (r["family"], r["path"])):
        if r["sha"] in seen:
            continue
        seen.add(r["sha"])
        files.append((FONTS / r["path"], safe_name(r["family"], "Untitled")))
    tmp = tempfile.SpooledTemporaryFile(max_size=64 * 1024 * 1024)
    names = set()
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        multi = len({fam for _, fam in files}) > 1
        for p, fam in files:
            folder = f"{title}/{fam}" if multi else title
            arc, n = f"{folder}/{p.name}", 0
            while arc in names:
                n += 1
                arc = f"{folder}/{p.stem}-{n}{p.suffix}"
            names.add(arc)
            z.write(p, arc)
    tmp.seek(0)
    return tmp, title


def family_zip(fkey):
    with dblock:
        rows = db.execute("SELECT * FROM faces WHERE fkey=?", (fkey,)).fetchall()
    return zip_of(rows, rows[0]["family"] if rows else "")


def collection_zip(cid):
    with dblock:
        c = db.execute("SELECT name FROM collections WHERE id=?", (cid,)).fetchone()
        rows = db.execute("SELECT x.* FROM faces x JOIN collection_fonts cf ON cf.fkey=x.fkey WHERE cf.cid=?",
                          (cid,)).fetchall()
    return zip_of(rows, safe_name(c["name"], "Collection")) if c else (None, None)


# ------------------------------------------------------------------ http
def disposition(name):
    ascii_name = name.encode("ascii", "ignore").decode() or "font"
    ascii_name = ascii_name.replace('"', "")
    return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{urllib.parse.quote(name)}"


class Handler(BaseHTTPRequestHandler):
    server_version = "Typestash"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if os.environ.get("TYPESTASH_ACCESS_LOG"):
            super().log_message(fmt, *args)

    def send_json(self, obj, code=200):
        body = json.dumps(obj, separators=(",", ":")).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, path, ctype, cache="no-cache", download=None, etag=None):
        if etag and self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        size = path.stat().st_size
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(size))
        self.send_header("Cache-Control", cache)
        if etag:
            self.send_header("ETag", etag)
        if download:
            self.send_header("Content-Disposition", disposition(download))
        self.end_headers()
        with open(path, "rb") as fh:
            shutil.copyfileobj(fh, self.wfile)

    def authorized(self):
        """Optional HTTP basic auth (TYPESTASH_PASSWORD). /healthz stays open."""
        if not AUTH_PASSWORD or self.path == "/healthz":
            return True
        h = self.headers.get("Authorization", "")
        if h.startswith("Basic "):
            try:
                user, _, pw = base64.b64decode(h[6:]).decode("utf-8").partition(":")
            except (ValueError, UnicodeDecodeError):
                user = pw = ""
            if hmac.compare_digest(user.encode(), AUTH_USER.encode()) and                     hmac.compare_digest(pw.encode(), AUTH_PASSWORD.encode()):
                return True
        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Basic realm="Typestash", charset="UTF-8"')
        self.send_header("Content-Length", "0")
        self.end_headers()
        return False

    def not_found(self):
        self.send_json({"error": "not found"}, 404)

    def do_GET(self):
        if not self.authorized():
            return
        u = urllib.parse.urlsplit(self.path)
        parts = [urllib.parse.unquote(p) for p in u.path.split("/") if p]
        try:
            if not parts:
                return self.send_file(STATIC / "index.html", STATIC_MIME[".html"])
            head = parts[0]
            if head == "healthz":
                return self.send_json({"ok": True})
            if head == "static" and len(parts) >= 2:
                p = (STATIC / "/".join(parts[1:])).resolve()
                if STATIC.resolve() not in p.parents or not p.is_file():
                    return self.not_found()
                return self.send_file(p, STATIC_MIME.get(p.suffix, "application/octet-stream"))
            if head == "api":
                if parts[1:] == ["library"]:
                    return self.send_json(library())
                if len(parts) == 3 and parts[1] == "family":
                    f = family(parts[2])
                    return self.send_json(f) if f else self.not_found()
                if len(parts) == 4 and parts[1] == "face" and parts[3] == "chars":
                    c = chars(parts[2])
                    return self.send_json(c) if c is not None else self.not_found()
                if parts[1:] == ["scan"]:
                    return self.send_json(scan_state)
                if parts[1:] == ["duplicates"]:
                    return self.send_json(duplicates())
                return self.not_found()
            if head == "font" and len(parts) == 2:
                r = face_row(parts[1])
                if not r:
                    return self.not_found()
                path, ctype = face_bytes_path(r)
                return self.send_file(path, ctype, cache="private, max-age=86400", etag=f'"{r["sha"][:20]}-{r["idx"]}"')
            if head == "download" and len(parts) == 3 and parts[1] in ("family", "collection"):
                if parts[1] == "family":
                    tmp, fam = family_zip(parts[2])
                else:
                    tmp, fam = collection_zip(int(parts[2])) if parts[2].isdigit() else (None, None)
                if not tmp:
                    return self.not_found()
                data = tmp.read()
                self.send_response(200)
                self.send_header("Content-Type", "application/zip")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Content-Disposition", disposition(f"{fam}.zip"))
                self.end_headers()
                self.wfile.write(data)
                return
            if head == "download" and len(parts) == 2:
                r = face_row(parts[1])
                if not r:
                    return self.not_found()
                path = FONTS / r["path"]
                return self.send_file(path, MIME.get(path.suffix.lower(), "application/octet-stream"),
                                      download=path.name)
            return self.not_found()
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:  # noqa: BLE001
            print(f"GET {self.path}: {type(e).__name__}: {e}", flush=True)
            try:
                self.send_json({"error": str(e)}, 500)
            except Exception:  # noqa: BLE001
                pass

    def do_POST(self):
        if not self.authorized():
            return
        parts = [urllib.parse.unquote(p) for p in urllib.parse.urlsplit(self.path).path.split("/") if p]
        length = int(self.headers.get("Content-Length") or 0)
        body = {}
        if 0 < length <= 1 << 16:
            try:
                body = json.loads(self.rfile.read(length) or b"{}")
            except ValueError:
                return self.send_json({"error": "bad json"}, 400)
        elif length:
            return self.send_json({"error": "too big"}, 413)
        if parts[:1] != ["api"]:
            return self.not_found()
        p = parts[1:]
        if p == ["rescan"]:
            threading.Thread(target=scan, daemon=True).start()
            return self.send_json({"ok": True})
        with dblock:
            if len(p) == 2 and p[0] == "favorite":
                if db.execute("SELECT 1 FROM favorites WHERE fkey=?", (p[1],)).fetchone():
                    db.execute("DELETE FROM favorites WHERE fkey=?", (p[1],))
                    fav = False
                else:
                    db.execute("INSERT INTO favorites(fkey) VALUES(?)", (p[1],))
                    fav = True
                db.commit()
                return self.send_json({"favorite": fav})
            if len(p) == 2 and p[0] == "category":
                cat = str(body.get("category", ""))
                if cat in CATEGORIES:
                    db.execute("INSERT OR REPLACE INTO overrides(fkey, category) VALUES(?,?)", (p[1], cat))
                else:
                    db.execute("DELETE FROM overrides WHERE fkey=?", (p[1],))
                db.commit()
                return self.send_json({"category": cat if cat in CATEGORIES else None})
            if len(p) == 2 and p[0] == "note":
                note = str(body.get("note", ""))[:4000].strip()
                if note:
                    db.execute("INSERT OR REPLACE INTO notes(fkey, note) VALUES(?,?)", (p[1], note))
                else:
                    db.execute("DELETE FROM notes WHERE fkey=?", (p[1],))
                db.commit()
                return self.send_json({"note": note})
            if p == ["collections"]:
                name = str(body.get("name", "")).strip()[:80]
                if not name:
                    return self.send_json({"error": "name required"}, 400)
                db.execute("INSERT OR IGNORE INTO collections(name, color, created) VALUES(?,?,?)",
                           (name, str(body.get("color", ""))[:20], time.time()))
                cid = db.execute("SELECT id FROM collections WHERE name=?", (name,)).fetchone()[0]
                for fk in list(body.get("fonts", []))[:5000]:
                    db.execute("INSERT OR IGNORE INTO collection_fonts(cid, fkey) VALUES(?,?)", (cid, str(fk)))
                db.commit()
                return self.send_json({"id": cid, "name": name})
            if len(p) >= 3 and p[0] == "collections" and p[1].isdigit():
                cid = int(p[1])
                if p[2] == "delete":
                    db.execute("DELETE FROM collection_fonts WHERE cid=?", (cid,))
                    db.execute("DELETE FROM collections WHERE id=?", (cid,))
                    db.commit()
                    return self.send_json({"ok": True})
                if p[2] == "rename":
                    name = str(body.get("name", "")).strip()[:80]
                    if name:
                        try:
                            db.execute("UPDATE collections SET name=? WHERE id=?", (name, cid))
                        except sqlite3.IntegrityError:
                            return self.send_json({"error": "name taken"}, 409)
                        db.commit()
                    return self.send_json({"ok": True})
                if p[2] == "toggle" and len(p) == 4:
                    if db.execute("SELECT 1 FROM collection_fonts WHERE cid=? AND fkey=?", (cid, p[3])).fetchone():
                        db.execute("DELETE FROM collection_fonts WHERE cid=? AND fkey=?", (cid, p[3]))
                        member = False
                    else:
                        db.execute("INSERT INTO collection_fonts(cid, fkey) VALUES(?,?)", (cid, p[3]))
                        member = True
                    db.commit()
                    return self.send_json({"member": member})
        return self.not_found()

    def do_PUT(self):
        if not self.authorized():
            return
        u = urllib.parse.urlsplit(self.path)
        if u.path != "/api/upload":
            return self.not_found()
        if not UPLOADS:
            return self.send_json({"error": "uploads are turned off on this server"}, 403)
        name = (urllib.parse.parse_qs(u.query).get("name") or [""])[0]
        length = int(self.headers.get("Content-Length") or 0)
        if not name or length <= 0:
            return self.send_json({"error": "need ?name= and a body"}, 400)
        if length > MAX_UPLOAD:
            return self.send_json({"error": "too big"}, 413)
        buf = tempfile.SpooledTemporaryFile(max_size=32 * 1024 * 1024)
        left = length
        while left > 0:
            chunk = self.rfile.read(min(left, 1 << 20))
            if not chunk:
                break
            buf.write(chunk)
            left -= len(chunk)
        buf.seek(0)
        try:
            results = add_upload(buf, safe_name(name))
        except Exception as e:  # noqa: BLE001
            print(f"upload {name}: {type(e).__name__}: {e}", flush=True)
            results = [{"name": name, "status": "rejected", "reason": str(e)[:200]}]
        self.send_json({"results": results})


def main():
    FONTS.mkdir(parents=True, exist_ok=True)
    threading.Thread(target=scan_loop, daemon=True).start()
    srv = ThreadingHTTPServer((BIND, PORT), Handler)
    srv.daemon_threads = True
    print(f"typestash on {BIND}:{PORT}, fonts in {FONTS}, index in {DATA}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
