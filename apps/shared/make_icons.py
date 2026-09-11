"""Generates the DocFlow app icons for Windows (.ico/.png) and macOS (.iconset).

Run from anywhere: python apps/shared/make_icons.py
Requires Pillow and a CJK-capable font (Microsoft YaHei, PingFang or Noto Sans CJK).
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[1]
WINDOWS_ASSETS = ROOT / "windows" / "DocFlow" / "Assets"
MAC_ICONSET = ROOT / "macos" / "Resources" / "AppIcon.iconset"

TOP = (37, 99, 235)  # blue
BOTTOM = (8, 145, 178)  # cyan
GLYPH = (30, 64, 175)

FONT_CANDIDATES = [
    "C:/Windows/Fonts/msyhbd.ttc",
    "C:/Windows/Fonts/msyh.ttc",
    "/System/Library/Fonts/PingFang.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
]


def font(size: int) -> ImageFont.FreeTypeFont:
    for candidate in FONT_CANDIDATES:
        if Path(candidate).exists():
            return ImageFont.truetype(candidate, size)
    sys.exit("No CJK font found; install Microsoft YaHei, PingFang or Noto Sans CJK")


def gradient(size: int) -> Image.Image:
    image = Image.new("RGB", (size, size))
    pixels = image.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1))
            pixels[x, y] = tuple(int(TOP[i] + (BOTTOM[i] - TOP[i]) * t) for i in range(3))
    return image


def master(size: int = 1024) -> Image.Image:
    """macOS proportions: an 824 px plate inside a 1024 px canvas."""
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    plate = int(size * 0.805)
    offset = (size - plate) // 2
    radius = int(plate * 0.225)

    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(
        (offset, offset + size * 0.012, offset + plate, offset + plate + size * 0.012),
        radius,
        fill=(0, 0, 0, 90),
    )
    canvas.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(size * 0.018)))

    mask = Image.new("L", (plate, plate), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, plate - 1, plate - 1), radius, fill=255)
    canvas.paste(gradient(plate), (offset, offset), mask)

    draw = ImageDraw.Draw(canvas)
    # Document page with a folded corner.
    page_w, page_h = plate * 0.50, plate * 0.62
    left = size / 2 - page_w / 2 - plate * 0.02
    top = size / 2 - page_h / 2
    fold = page_w * 0.26
    page = [
        (left, top + plate * 0.03),
        (left + page_w - fold, top),
        (left + page_w, top + fold),
        (left + page_w, top + page_h),
        (left, top + page_h),
    ]
    page_shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(page_shadow).polygon([(x + size * 0.01, y + size * 0.016) for x, y in page], fill=(0, 0, 0, 70))
    canvas.alpha_composite(page_shadow.filter(ImageFilter.GaussianBlur(size * 0.012)))
    draw.rounded_rectangle((left, top, left + page_w, top + page_h), radius=plate * 0.045, fill=(255, 255, 255, 255))
    draw.polygon([(left + page_w - fold, top - 2), (left + page_w + 2, top - 2), (left + page_w + 2, top + fold)], fill=(0, 0, 0, 0))
    # Re-open the corner on the plate colour, then draw the fold.
    corner = gradient(plate).crop((int(left + page_w - fold - offset), int(top - offset - 2), int(left + page_w - offset + 3), int(top + fold - offset + 1)))
    corner_mask = Image.new("L", corner.size, 0)
    ImageDraw.Draw(corner_mask).polygon([(0, 0), (corner.size[0], 0), (corner.size[0], corner.size[1])], fill=255)
    canvas.paste(corner, (int(left + page_w - fold), int(top - 2)), corner_mask)
    draw.polygon([(left + page_w - fold, top), (left + page_w - fold, top + fold), (left + page_w, top + fold)], fill=(191, 219, 254, 255))

    glyph = font(int(page_w * 0.62))
    draw.text((left + page_w / 2, top + page_h * 0.47), "文", font=glyph, fill=GLYPH + (255,), anchor="mm")
    # Flow lines under the glyph.
    line_y = top + page_h * 0.80
    for index, width in enumerate((0.58, 0.40)):
        y = line_y + index * page_h * 0.085
        draw.rounded_rectangle(
            (left + page_w * 0.21, y, left + page_w * (0.21 + width), y + page_h * 0.035),
            radius=page_h * 0.02,
            fill=(147, 197, 253, 255) if index else (59, 130, 246, 255),
        )
    return canvas


def main() -> None:
    icon = master()
    WINDOWS_ASSETS.mkdir(parents=True, exist_ok=True)
    # Windows: trim the macOS safe area so the plate fills the tile.
    trimmed = icon.crop((80, 80, 944, 944)).resize((256, 256), Image.LANCZOS)
    trimmed.save(WINDOWS_ASSETS / "AppIcon.ico", sizes=[(16, 16), (20, 20), (24, 24), (32, 32), (40, 40), (48, 48), (64, 64), (96, 96), (128, 128), (256, 256)])
    trimmed.save(WINDOWS_ASSETS / "AppIcon.png")
    MAC_ICONSET.mkdir(parents=True, exist_ok=True)
    for points in (16, 32, 128, 256, 512):
        for scale in (1, 2):
            pixels = points * scale
            name = f"icon_{points}x{points}{'@2x' if scale == 2 else ''}.png"
            icon.resize((pixels, pixels), Image.LANCZOS).save(MAC_ICONSET / name)
    icon.save(ROOT / "shared" / "AppIcon-1024.png")
    print("icons written")


if __name__ == "__main__":
    main()
