#!/usr/bin/env python
"""Build Windows .ico files from the rendered PNGs.

Usage:  python scripts/make-ico.py
Input:  assets/icon/icon-dark-256.png  (white logo, for dark theme)
        assets/icon/icon-light-256.png (black logo, for day mode)
Output: assets/icon/icon.ico        (dark/white logo, fallback)
        assets/icon/icon-black.ico  (black logo, default exe/window/taskbar)
"""

import os

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICON_DIR = os.path.join(ROOT, "assets", "icon")

TARGETS = [
    ("icon.ico", "icon-dark-256.png"),
    ("icon-black.ico", "icon-light-256.png"),
]
SIZES = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]

for name, source in TARGETS:
    source_path = os.path.join(ICON_DIR, source)
    target_path = os.path.join(ICON_DIR, name)
    if not os.path.exists(source_path):
        raise SystemExit(f"missing {source_path}; run scripts/render-icons.cjs first")
    image = Image.open(source_path).convert("RGBA")
    image.save(target_path, sizes=SIZES)
    print(f"wrote {target_path} ({os.path.getsize(target_path)} bytes) from {source_path}")
