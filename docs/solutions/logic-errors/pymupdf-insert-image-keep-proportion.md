---
title: "PyMuPDF insert_image uses keep_proportion=True by default — causes margins when scaling"
category: logic-errors
date: 2026-03-20
tags: [pymupdf, fitz, insert-image, scaling, legal-to-letter]
components: [process_meet, pdf_generator]
severity: p2
---

# PyMuPDF insert_image uses keep_proportion=True by default

## Problem

When scaling a legal-size (8.5x14) PDF page down to letter size (8.5x11) by rasterizing at 300 DPI and inserting as an image, the result had visible margins on both sides — the content didn't fill the full page width.

## Root Cause

`page.insert_image(fitz.Rect(0, 0, 612, 792), pixmap=pix)` has a `keep_proportion` parameter that defaults to `True`. Since the source pixmap has a legal aspect ratio (612:1008 = 0.607) but the target rect has a letter aspect ratio (612:792 = 0.773), PyMuPDF shrinks the width proportionally to preserve the original aspect ratio, centering the image with margins on both sides.

The source and target have the same WIDTH (612pt), but PyMuPDF scales by the constraining dimension (height), which then shrinks the width.

## Solution

Set `keep_proportion=False`:

```python
new_pg.insert_image(
    fitz.Rect(0, 0, _LETTER_W, _LETTER_H),
    pixmap=pix,
    keep_proportion=False  # Stretch to fill full rect
)
```

This slightly distorts the content vertically (squished by 21%) but fills the full page width, which looks correct for order form backs.

## Prevention

When using `insert_image` to scale between different page sizes, always check whether `keep_proportion` should be True or False. The default (True) is usually right for photos but wrong for document-to-document scaling where you want to fill the target page.
