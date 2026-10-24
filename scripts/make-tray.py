#!/usr/bin/env python
"""Build the Windows tray icon: black whale logo on an opaque white tile.

Usage:  python scripts/make-tray.py
Input:  assets/icon/icon-light-256.png (black logo on transparent)
Output: assets/icon/tray.png     32x32 (used by Electron tray)
        assets/icon/tray-16.png 16x16
"""

import os

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICON_DIR = os.path.join(ROOT, "assets", "icon")
SOURCE = os.path.join(ICON_DIR, "icon-light-256.png")

if not os.path.exists(SOURCE):
    raise SystemExit(f"missing {SOURCE}; run scripts/render-icons.cjs first")

source = Image.open(SOURCE).convert("RGBA")


def make_tray(size):
    scale = 4
    canvas = Image.new("RGBA", (size * scale, size * scale), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)
    margin = 2 * scale
    radius = max(3, size // 6) * scale
    draw.rounded_rectangle(
        (margin, margin, size * scale - margin, size * scale - margin),
        radius=radius,
        fill=(255, 255, 255, 255),
    )
    bbox = source.getchannel("A").getbbox()
    glyph = source.crop(bbox)
    inner = int((size - 8) * scale)
    glyph.thumbnail((inner, inner), Image.Resampling.LANCZOS)
    canvas.alpha_composite(glyph, ((size * scale - glyph.width) // 2, (size * scale - glyph.height) // 2))
    return canvas.resize((size, size), Image.Resampling.LANCZOS)


for size, name in [(32, "tray.png"), (16, "tray-16.png")]:
    target = os.path.join(ICON_DIR, name)
    make_tray(size).save(target)
    print(f"wrote {target} ({os.path.getsize(target)} bytes)")
