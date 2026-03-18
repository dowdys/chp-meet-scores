---
title: "PyMuPDF insert_image ignores IDML negative-scale (flip) transforms"
category: "runtime-errors"
date: "2026-03-18"
tags:
  - pymupdf
  - fitz
  - idml
  - image-transform
  - scissors
severity: medium
component: "python/core/idml_parser.py"
symptoms:
  - "Embedded images render un-rotated despite flipped ItemTransform"
  - "Scissors icon appears backwards on order form"
  - "Image bounding box is correct but orientation is wrong"
---

## Problem

When an IDML `Rectangle` container has a negative-scale `ItemTransform` (e.g., `"-1 0 0 -1 tx ty"` for 180° rotation), the IDML parser's `_get_page_bounds()` correctly computes the axis-aligned bounding box. However, `page.insert_image(rect, ...)` places the image into that rect without any rotation — the image appears un-flipped.

This manifested as scissors pointing the wrong direction on the order form cut line.

## Root Cause

`_get_page_bounds()` transforms the four anchor points through the ItemTransform matrix, then computes the min/max bounding box. For a 180° rotation (`-1 0 0 -1`), the corners swap but the axis-aligned bounding box is identical to the un-rotated version. PyMuPDF's `insert_image()` has no knowledge of the source transform — it just fits the image into the rectangle.

## Solution

Detect negative-scale transforms in the container element and pass `rotate=180` to `insert_image()`:

```python
def _draw_placed_image(page, container_el, image_el, page_offset, zf):
    bounds = _get_page_bounds(container_el, page_offset)
    rect = fitz.Rect(*bounds)

    # Detect 180° flip from container transform (negative scale on both axes)
    tf = _parse_transform(container_el.get('ItemTransform', '1 0 0 1 0 0'))
    rotate = 180 if (tf[0] < 0 and tf[3] < 0) else 0

    # ... later:
    page.insert_image(rect, stream=image_data, rotate=rotate)
    # or:
    page.insert_image(rect, filename=candidate, rotate=rotate)
```

## Key Insight

The bounding box is transform-invariant for 180° rotations (swapping all corners produces the same min/max rect). This makes the bug invisible at the geometry level — the image appears in the right position and size, just with the wrong orientation. You can only catch this by visual inspection of the rendered output.

This same pattern would apply to 90° and 270° rotations (`tf[1]` and `tf[2]` non-zero), though those would also change the bounding box aspect ratio.
