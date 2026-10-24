#!/usr/bin/env python
"""Render the MultiDSH icon: three black whales stacked vertically, facing the
same direction, each overlapping the one below (like the DeepSeek whale mark).

The geometry is defined once in unit space and reused by the SVG, the raster
PNGs and the small brand mark embedded in the desktop renderer.

Run:  python render.py
"""

from __future__ import annotations

import math
import os

from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
INK = (11, 15, 20, 255)        # near-black
CLEAR = (0, 0, 0, 0)

# Layout: three whales in a vertical column, all facing the same way (head
# left), only the angle varies a little so the stack looks like it is swimming.
# Drawn bottom -> top; each front whale carves a small transparent gap out of
# the whale behind it, so the overlap reads as "stacked" instead of one blob.
LAYOUT = [
    (0.500, 0.770, 0.560, 4, False),    # bottom (back)
    (0.500, 0.500, 0.560, 0, False),    # middle
    (0.500, 0.230, 0.560, -4, False),   # top (front)
]
GAP = 0.012  # transparent gap between stacked whales, in canvas fractions


def _bezier(p0, p1, p2, p3, steps=24):
    pts = []
    for i in range(steps + 1):
        t = i / steps
        u = 1 - t
        x = u**3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t**3 * p3[0]
        y = u**3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t**3 * p3[1]
        pts.append((x, y))
    return pts


def whale_outline():
    """Whale silhouette in unit space: head left, compact fluke right."""
    pts = []
    # nose -> top of back
    pts += _bezier((0.04, 0.50), (0.06, 0.30), (0.20, 0.18), (0.38, 0.19))
    # back -> tail base
    pts += _bezier((0.38, 0.19), (0.50, 0.20), (0.60, 0.30), (0.65, 0.42))
    # fluke: upper lobe -> notch -> lower lobe
    pts.append((0.86, 0.26))
    pts.append((0.75, 0.50))
    pts.append((0.87, 0.74))
    pts.append((0.65, 0.58))
    # belly -> nose
    pts += _bezier((0.65, 0.58), (0.56, 0.76), (0.34, 0.82), (0.20, 0.72))
    pts += _bezier((0.20, 0.72), (0.10, 0.65), (0.04, 0.60), (0.04, 0.50))
    return pts


FIN = [(0.27, 0.64), (0.35, 0.86), (0.43, 0.65)]


def transform(points, cx, cy, scale, angle_deg, mirror=False):
    """Map unit points into canvas pixels around (cx, cy)."""
    a = math.radians(angle_deg)
    ca, sa = math.cos(a), math.sin(a)
    out = []
    for x, y in points:
        if mirror:
            x = 1.0 - x
        x -= 0.5
        y -= 0.5
        rx = x * ca - y * sa
        ry = x * sa + y * ca
        out.append((cx + rx * scale, cy + ry * scale))
    return out


def whale_polygons(cx, cy, scale, angle, mirror=False):
    body = transform(whale_outline(), cx, cy, scale, angle, mirror)
    fin = transform(FIN, cx, cy, scale, angle, mirror)
    return body, fin


def eye_center(cx, cy, scale, angle, mirror=False):
    ex, ey = 0.235, 0.475
    if mirror:
        ex = 1.0 - ex
    ex -= 0.5
    ey -= 0.5
    a = math.radians(angle)
    rx = ex * math.cos(a) - ey * math.sin(a)
    ry = ex * math.sin(a) + ey * math.cos(a)
    return cx + rx * scale, cy + ry * scale, scale * 0.030


def whale_mask(size, cx, cy, scale, angle, mirror=False):
    """L mask of one whale (body + fin), with the eye punched out."""
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    body, fin = whale_polygons(cx, cy, scale, angle, mirror)
    draw.polygon(body, fill=255)
    draw.polygon(fin, fill=255)
    ex, ey, r = eye_center(cx, cy, scale, angle, mirror)
    draw.ellipse((ex - r, ey - r, ex + r, ey + r), fill=0)
    return mask


def compose(size):
    """Three whales stacked vertically, front whales carving a gap out of the back."""
    img = Image.new("RGBA", (size, size), CLEAR)
    gap_px = max(1, round(size * GAP))
    for index, (cx, cy, scale, angle, mirror) in enumerate(LAYOUT):
        mask = whale_mask(size, cx * size, cy * size, scale * size, angle, mirror)
        if index > 0:
            # Erase a ring around this whale from everything already drawn.
            expanded = mask.filter(ImageFilter.MaxFilter(2 * gap_px + 1))
            alpha = img.getchannel("A")
            alpha.paste(0, (0, 0), expanded)
            img.putalpha(alpha)
        layer = Image.new("RGBA", (size, size), INK)
        img.paste(layer, (0, 0), mask)
    return img


def compose_preview(size, background=(245, 247, 250, 255)):
    bg = Image.new("RGBA", (size, size), background)
    bg.alpha_composite(compose(size))
    return bg


# --------------------------------------------------------------------- SVG ---

def polygon_path(points):
    cmds = [f"M {points[0][0]:.4f} {points[0][1]:.4f}"]
    for x, y in points[1:]:
        cmds.append(f"L {x:.4f} {y:.4f}")
    cmds.append("Z")
    return " ".join(cmds)


def _scaled_points(cx, cy, scale, angle, mirror):
    body, fin = whale_polygons(cx * 100, cy * 100, scale * 100, angle, mirror)
    return polygon_path(body), polygon_path(fin)


def mask_content():
    """Mask content (user units 0-100): white = visible, black = hidden."""
    parts = []
    for index, (cx, cy, scale, angle, mirror) in enumerate(LAYOUT):
        body, fin = _scaled_points(cx, cy, scale, angle, mirror)
        if index > 0:
            width = GAP * 2 * 100
            parts.append(
                f'<path d="{body} {fin}" fill="#000" stroke="#000" '
                f'stroke-width="{width:.3f}" stroke-linejoin="round"/>'
            )
        parts.append(f'<path d="{body} {fin}" fill="#fff"/>')
        ex, ey, r = eye_center(cx, cy, scale, angle, mirror)
        parts.append(
            f'<circle cx="{ex * 100:.4f}" cy="{ey * 100:.4f}" r="{r * 100:.4f}" fill="#000"/>'
        )
    return "\n      ".join(parts)


def build_svg():
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" '
        'width="1024" height="1024">\n'
        '  <mask id="whales">\n'
        f"      {mask_content()}\n"
        "  </mask>\n"
        '  <rect width="100" height="100" fill="#0B0F14" mask="url(#whales)"/>\n'
        "</svg>\n"
    )


def build_brand_snippet():
    """Inline <symbol> for the desktop renderer (currentColor, theme-aware)."""
    return (
        '<symbol id="multidsh-whales" viewBox="0 0 100 100">\n'
        '          <mask id="multidsh-whales-mask">\n'
        f"            {mask_content()}\n"
        "          </mask>\n"
        '          <rect width="100" height="100" fill="currentColor" '
        'mask="url(#multidsh-whales-mask)" />\n'
        "        </symbol>"
    )


def update_renderer_html(snippet):
    """Keep the header brand mark exactly in sync with the generated icon."""
    page = os.path.join(REPO, "packages", "desktop", "src", "renderer", "index.html")
    if not os.path.exists(page):
        return False
    with open(page, encoding="utf-8") as fh:
        html = fh.read()
    start = "<!-- brand-mark:start -->"
    end = "<!-- brand-mark:end -->"
    if start not in html or end not in html:
        return False
    before, rest = html.split(start, 1)
    _, after = rest.split(end, 1)
    html = (
        before
        + start
        + "\n        "
        + snippet
        + "\n        "
        + end
        + after
    )
    with open(page, "w", encoding="utf-8") as fh:
        fh.write(html)
    return True


def main():
    sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024]
    rendered = {}
    for size in sizes:
        img = compose(size)
        rendered[size] = img
        img.save(os.path.join(HERE, f"icon-{size}.png"))

    rendered[1024].save(os.path.join(HERE, "icon.png"))
    compose_preview(512).save(os.path.join(HERE, "preview-512.png"))
    compose_preview(512, (17, 19, 24, 255)).save(os.path.join(HERE, "preview-dark.png"))
    compose(32).resize((256, 256), Image.NEAREST).save(
        os.path.join(HERE, "preview-32-upscaled.png")
    )

    icon = rendered[256]
    icon.save(
        os.path.join(HERE, "icon.ico"),
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )

    with open(os.path.join(HERE, "icon.svg"), "w", encoding="utf-8") as fh:
        fh.write(build_svg())

    snippet = build_brand_snippet()
    with open(os.path.join(HERE, "brand-mark.snippet.html"), "w", encoding="utf-8") as fh:
        fh.write(snippet + "\n")
    synced = update_renderer_html(snippet)

    print(
        "rendered",
        ", ".join(f"icon-{s}.png" for s in sizes),
        "icon.ico icon.svg previews; brand mark synced to renderer:",
        synced,
    )


if __name__ == "__main__":
    main()
