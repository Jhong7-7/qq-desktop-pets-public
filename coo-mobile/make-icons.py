"""Generate Coo PWA icons with the Python standard library only.

Produces a rounded-square any icon (192/512) and a full-bleed maskable icon
whose artwork stays inside the 80% safe zone. Colours follow mobile-console.html.
"""
import math
import struct
import zlib
from pathlib import Path

WEB = Path(r"D:\coopanion\resources\app\node_modules\cortico-world-desktop-pet\web")


def rgb(h):
    return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))


BG_A = rgb("#3E9E90")
BG_B = rgb("#3F6691")
FACE = rgb("#FCFAF4")
INNER_EAR = rgb("#EFB9B2")
INK = rgb("#1B2226")
BLUSH = rgb("#E9A6A0")
ONLINE = rgb("#7CE0C6")


def clamp(v):
    return 0.0 if v < 0.0 else (1.0 if v > 1.0 else v)


def smooth(a, b, x):
    t = clamp((x - a) / (b - a))
    return t * t * (3.0 - 2.0 * t)


def mix(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


def over(dst, src, alpha):
    return tuple(dst[i] + (src[i] - dst[i]) * alpha for i in range(3))


def circle(u, v, cx, cy, r, feather):
    d = math.hypot(u - cx, v - cy)
    return 1.0 - smooth(r - feather, r + feather, d)


def ellipse(u, v, cx, cy, rx, ry, feather):
    d = math.hypot((u - cx) / rx, (v - cy) / ry)
    return 1.0 - smooth(1.0 - feather, 1.0 + feather, d)


def seg_dist(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = clamp(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def triangle(u, v, pts, feather):
    (ax, ay), (bx, by), (cx, cy) = pts
    d1 = (bx - ax) * (v - ay) - (by - ay) * (u - ax)
    d2 = (cx - bx) * (v - by) - (cy - by) * (u - bx)
    d3 = (ax - cx) * (v - cy) - (ay - cy) * (u - cx)
    inside = (d1 >= 0 and d2 >= 0 and d3 >= 0) or (d1 <= 0 and d2 <= 0 and d3 <= 0)
    d = min(
        seg_dist(u, v, ax, ay, bx, by),
        seg_dist(u, v, bx, by, cx, cy),
        seg_dist(u, v, cx, cy, ax, ay),
    )
    # Inside: fade in from the edge. Outside: fade out just past the edge.
    return smooth(0.0, feather, d) if inside else 1.0 - smooth(0.0, feather, d)


def rounded_rect_alpha(u, v, radius, feather):
    """Signed distance-ish coverage of a rounded square in [0,1]^2."""
    cx = min(max(u, radius), 1.0 - radius)
    cy = min(max(v, radius), 1.0 - radius)
    d = math.hypot(u - cx, v - cy)
    return 1.0 - smooth(radius - feather, radius + feather, d)


def paint(u, v):
    """Return (r,g,b) for the artwork at normalized coords."""
    # background gradient + soft light in the upper right
    col = mix(BG_A, BG_B, clamp((u * 0.55 + v * 0.75) - 0.15))
    glow = circle(u, v, 0.80, 0.16, 0.52, 0.45)
    col = over(col, (150, 220, 210), glow * 0.18)

    # ears (behind the face)
    for pts in (
        ((0.255, 0.455), (0.300, 0.190), (0.490, 0.335)),
        ((0.745, 0.455), (0.700, 0.190), (0.510, 0.335)),
    ):
        col = over(col, FACE, triangle(u, v, pts, 0.012))
    for (ax, ay, bx, by) in (
        (0.320, 0.400, 0.335, 0.265),
        (0.680, 0.400, 0.665, 0.265),
    ):
        inner_pts = ((ax, ay), (bx, by), (0.500 if ax < 0.5 else 0.500, 0.345))
        col = over(col, INNER_EAR, triangle(u, v, inner_pts, 0.010) * 0.85)

    # face
    col = over(col, FACE, circle(u, v, 0.5, 0.545, 0.265, 0.010))

    # blush
    for cx in (0.335, 0.665):
        col = over(col, BLUSH, ellipse(u, v, cx, 0.605, 0.050, 0.032, 0.30) * 0.42)

    # eyes + catchlights
    for cx in (0.410, 0.590):
        col = over(col, INK, circle(u, v, cx, 0.525, 0.037, 0.010))
        col = over(col, (255, 255, 255), circle(u, v, cx - 0.012, 0.512, 0.012, 0.012))

    # nose + smile
    col = over(col, INNER_EAR, ellipse(u, v, 0.5, 0.595, 0.028, 0.020, 0.18))
    d = math.hypot(u - 0.5, v - 0.615)
    if v > 0.615:
        col = over(col, INK, (1.0 - smooth(0.004, 0.012, abs(d - 0.055))) * 0.75)

    # little online dot (bottom right, clear of the ears and face)
    col = over(col, FACE, circle(u, v, 0.775, 0.755, 0.070, 0.010))
    col = over(col, ONLINE, circle(u, v, 0.775, 0.755, 0.048, 0.010))
    return col


def render(size, maskable=False):
    scale = 0.80 if maskable else 1.0
    feather = 1.6 / size
    rows = []
    for y in range(size):
        v = (y + 0.5) / size
        row = bytearray()
        for x in range(size):
            u = (x + 0.5) / size
            # map into the (possibly shrunk) artwork space
            au = (u - 0.5) / scale + 0.5
            av = (v - 0.5) / scale + 0.5
            if maskable:
                alpha = 1.0 if 0.0 <= au <= 1.0 and 0.0 <= av <= 1.0 else 0.0
            else:
                alpha = rounded_rect_alpha(u, v, 0.225, feather)
            if alpha <= 0.0:
                row += bytes((0, 0, 0, 0))
                continue
            c = paint(clamp(au), clamp(av))
            row += bytes((int(c[0]), int(c[1]), int(c[2]), int(alpha * 255 + 0.5)))
        rows.append(bytes(row))
    return rows


def write_png(path, size, rows):
    def chunk(tag, data):
        return (
            struct.pack(">I", len(data)) + tag + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    raw = b"".join(b"\x00" + r for r in rows)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    path.write_bytes(png)
    print(f"  {path.name}: {size}x{size}, {len(png):,} bytes")


if __name__ == "__main__":
    for size, name, maskable in (
        (192, "icon-192.png", False),
        (512, "icon-512.png", False),
        (512, "icon-maskable-512.png", True),
    ):
        write_png(WEB / name, size, render(size, maskable))
