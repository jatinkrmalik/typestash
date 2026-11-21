#!/usr/bin/env python3
"""Regenerate the Typestash icon: a monospace "ts" with a block cursor.

The letters are JetBrains Mono ExtraBold (SIL OFL) converted to outlines, so the SVG
does not depend on any installed font. Writes app/static/favicon.svg,
icon-512.png and apple-touch-icon.png.

Usage: python tools/make_icons.py path/to/JetBrainsMono[wght].ttf
Needs: fonttools, Pillow
"""
import sys
from pathlib import Path

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from PIL import Image, ImageDraw

INK, PAPER, TOMATO = "#17140f", "#f3eee4", "#ff4a1c"
SIZE = 64          # viewBox
RADIUS = 14
FONT_PX = 32       # letter size inside the 64 box
GAP = 2.5          # between "s" and the cursor
WEIGHT = 800

STATIC = Path(__file__).resolve().parent.parent / "app" / "static"


def layout(font):
    """Glyph outlines + cursor rect, centred in the 64x64 box (y down)."""
    upm = font["head"].unitsPerEm
    scale = FONT_PX / upm
    gs = font.getGlyphSet()
    cmap = font.getBestCmap()
    names = [cmap[ord(c)] for c in "ts"]
    advance = font["hmtx"][names[0]][0] * scale
    cursor_w = advance * 0.5
    total = advance * 2 + GAP + cursor_w

    # vertical extent of "t" (tallest) in font units
    bp = BoundsPen(gs)
    gs[names[0]].draw(bp)
    t_top = bp.bounds[3] * scale
    x0 = (SIZE - total) / 2
    baseline = (SIZE + t_top) / 2          # centre the ink of "ts" vertically

    paths = []
    for i, n in enumerate(names):
        pen = SVGPathPen(gs, ntos=lambda v: f"{v:.2f}".rstrip("0").rstrip("."))
        # font units (y up) -> box units (y down)
        tp = TransformPen(pen, (scale, 0, 0, -scale, x0 + i * advance, baseline))
        gs[n].draw(tp)
        paths.append(pen.getCommands())
    x_height = font["OS/2"].sxHeight * scale
    cursor = (x0 + advance * 2 + GAP, baseline - t_top, cursor_w, t_top)
    return paths, cursor, x_height


def svg(paths, cursor):
    cx, cy, cw, ch = cursor
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {SIZE} {SIZE}">'
        f'<rect width="{SIZE}" height="{SIZE}" rx="{RADIUS}" fill="{INK}"/>'
        f'<path fill="{PAPER}" d="{" ".join(paths)}"/>'
        f'<rect x="{cx:.2f}" y="{cy:.2f}" width="{cw:.2f}" height="{ch:.2f}" fill="{TOMATO}"/>'
        "</svg>\n"
    )


def png(font, out, px):
    """Rasterise by flattening the outlines at a large size, then downsample."""
    from fontTools.pens.recordingPen import DecomposingRecordingPen
    big = px * 4
    k = big / SIZE
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((0, 0, big - 1, big - 1), radius=RADIUS * k, fill=INK)

    upm = font["head"].unitsPerEm
    scale = FONT_PX / upm
    gs = font.getGlyphSet()
    cmap = font.getBestCmap()
    names = [cmap[ord(c)] for c in "ts"]
    advance = font["hmtx"][names[0]][0] * scale
    _, cursor, _ = layout(font)
    x0 = cursor[0] - GAP - advance * 2
    baseline = cursor[1] + cursor[3]

    # Draw each glyph with even-odd compositing: fill outer contours, then
    # holes, using a mask per glyph (nonzero winding via polygon XOR is enough
    # for these simple letters).
    for i, n in enumerate(names):
        rec = DecomposingRecordingPen(gs)
        gs[n].draw(rec)
        mask = Image.new("L", (big, big), 0)
        md = ImageDraw.Draw(mask)
        for contour in contours(rec.value):
            pts = [((x0 + i * advance + x * scale) * k, (baseline - y * scale) * k) for x, y in contour]
            tmp = Image.new("L", (big, big), 0)
            ImageDraw.Draw(tmp).polygon(pts, fill=255)
            mask = xor(mask, tmp)
        img.paste(Image.new("RGBA", (big, big), PAPER), (0, 0), mask)
    cx, cy, cw, ch = cursor
    d.rectangle((cx * k, cy * k, (cx + cw) * k, (cy + ch) * k), fill=TOMATO)
    img.resize((px, px), Image.LANCZOS).save(out)


def xor(a, b):
    from PIL import ImageChops
    return ImageChops.logical_xor(a.convert("1"), b.convert("1")).convert("L")


def contours(ops, steps=24):
    """Flatten recorded pen ops into point lists."""
    out, cur, last = [], [], None
    for op, args in ops:
        if op == "moveTo":
            cur = [args[0]]
            last = args[0]
        elif op == "lineTo":
            cur.append(args[0])
            last = args[0]
        elif op == "qCurveTo":
            pts = list(args)
            # implied on-curve points between consecutive off-curve points
            start = last
            for j in range(len(pts) - 1):
                c = pts[j]
                end = pts[j + 1] if j == len(pts) - 2 else ((pts[j][0] + pts[j + 1][0]) / 2, (pts[j][1] + pts[j + 1][1]) / 2)
                for s in range(1, steps + 1):
                    t = s / steps
                    cur.append(((1 - t) ** 2 * start[0] + 2 * (1 - t) * t * c[0] + t * t * end[0],
                                (1 - t) ** 2 * start[1] + 2 * (1 - t) * t * c[1] + t * t * end[1]))
                start = end
            last = start
        elif op == "curveTo":
            c1, c2, end = args
            start = last
            for s in range(1, steps + 1):
                t = s / steps
                mt = 1 - t
                cur.append((mt ** 3 * start[0] + 3 * mt * mt * t * c1[0] + 3 * mt * t * t * c2[0] + t ** 3 * end[0],
                            mt ** 3 * start[1] + 3 * mt * mt * t * c1[1] + 3 * mt * t * t * c2[1] + t ** 3 * end[1]))
            last = end
        elif op in ("closePath", "endPath"):
            if cur:
                out.append(cur)
            cur = []
    if cur:
        out.append(cur)
    return out


def main(path):
    font = TTFont(path)
    if "fvar" in font:
        font = instantiateVariableFont(font, {"wght": WEIGHT})
    paths, cursor, _ = layout(font)
    (STATIC / "favicon.svg").write_text(svg(paths, cursor), encoding="utf-8")
    png(font, STATIC / "icon-512.png", 512)
    png(font, STATIC / "apple-touch-icon.png", 180)
    print("wrote favicon.svg, icon-512.png, apple-touch-icon.png")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
