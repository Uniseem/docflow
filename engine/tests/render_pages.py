"""Renders PDF pages to PNG for visual review: render_pages.py OUT.png PDF [PAGE ...]"""

import sys

import pymupdf

output, source, *pages = sys.argv[1:]
with pymupdf.open(source) as document:
    indices = [int(page) for page in pages] or [0]
    images = [document[index].get_pixmap(dpi=110) for index in indices if index < document.page_count]
    width = sum(image.width for image in images) + 12 * (len(images) - 1)
    height = max(image.height for image in images)
    sheet = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, width, height), False)
    sheet.clear_with(200)
    x = 0
    for image in images:
        image.set_origin(x, 0)
        sheet.copy(image, image.irect)
        x += image.width + 12
    sheet.save(output)
    print(f"{document.page_count} pages; wrote {output}")
