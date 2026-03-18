---
title: "PyMuPDF insert_text loses font identity after show_pdf_page overlay"
category: "runtime-errors"
date: "2026-03-18"
tags:
  - pymupdf
  - fitz
  - fonts
  - pdf-generation
  - order-forms
severity: medium
component: "python/core/order_form_generator.py"
symptoms:
  - "Bold text renders as regular weight"
  - "Italic text renders as roman (upright)"
  - "Font name field is empty when extracting text from generated PDF"
---

## Problem

After overlaying a template page via `page.show_pdf_page()`, calling `page.insert_text()` with base14 font names like `'Times-Bold'` or `'Times-Italic'` silently fails to apply the font style. The text appears but renders in the default weight/style — bold looks regular, italic looks upright.

Extracting text from the generated PDF confirms the issue: the `font` field is empty for the inserted text spans.

## Root Cause

`show_pdf_page()` inserts the template as an XObject form with its own font resource dictionary. When `insert_text()` then tries to use base14 font names, PyMuPDF's font resolution conflicts with the XObject's font resources. The result is that the font name reference in the content stream doesn't properly link to a font resource, causing the PDF viewer to fall back to a default font.

## Solution

Use `fitz.TextWriter` with explicit `fitz.Font()` objects instead of `page.insert_text()`:

```python
# BROKEN — font identity lost after show_pdf_page overlay
page.show_pdf_page(page.rect, template_doc, 0)
page.insert_text(point, text, fontname='Times-Bold', fontsize=14)  # renders as regular

# WORKING — explicit Font objects preserve identity
page.show_pdf_page(page.rect, template_doc, 0)
font_bold = fitz.Font('tibo')     # Times Bold
font_italic = fitz.Font('tiit')   # Times Italic
writer = fitz.TextWriter(page.rect)
writer.append(point, text, font=font_bold, fontsize=14)
writer.write_text(page, color=(0, 0, 0))
```

PyMuPDF internal font names: `tibo` (Times Bold), `tiro` (Times Roman), `tiit` (Times Italic).

## Key Insight

`page.insert_text()` works fine on blank pages or pages without XObject overlays. The conflict only manifests when `show_pdf_page()` has been called first. The text IS inserted (it's visible), but the font style is silently wrong — making this hard to catch without visual inspection.
