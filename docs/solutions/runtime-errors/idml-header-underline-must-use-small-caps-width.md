---
title: IDML header underlines must use small-caps width measurement
category: runtime-errors
date: 2026-03-19
component: python/core/idml_generator.py
severity: medium
tags: [idml, rendering, font-measurement, small-caps, publishing-pipeline]
---

## Problem

IDML header underlines (the red lines under "VAULT", "BARS", "BEAM", etc.) were ~15% wider than the header text they underlined. The PDF output had correctly-sized underlines, but the IDML output was visibly misaligned.

## Root Cause

The IDML generator measured header width using plain text measurement:

```python
approx_w = fitz.get_text_length("VAULT", fontname="Times-Bold", fontsize=11)
```

But headers are rendered as **small caps** — the first character at the large size (11pt) and remaining characters at the small size (~8pt). The plain measurement assumes all characters are at 11pt, overestimating the rendered width.

For "VAULT" at hl=11, hs=8:
- Plain measurement: ~33pt (all chars at 11pt)
- Small-caps measurement: ~28pt (V at 11pt, AULT at 8pt)
- Difference: ~15% wider underlines in IDML

The PDF generator was correct because it used `measure_small_caps_width()` which accounts for the size difference.

## Solution

Use `measure_small_caps_width` (from `rendering_utils.py`) instead of `fitz.get_text_length` for any text that is rendered as small caps:

```python
from python.core.rendering_utils import measure_small_caps_width

# Headers are small caps: first char at hl, rest at hs
approx_w = measure_small_caps_width(header, hl, hs, font=font_bold)
```

Note: Level divider flanking lines use **letter-spacing** (not small caps), so `fitz.get_text_length` of the spaced text IS correct there. Only header underlines need the small-caps measurement.

## Prevention

When adding underlines, borders, or any width-dependent decoration to text in the IDML generator:
1. Check how the text is rendered (plain, small caps, letter-spaced)
2. Use the matching measurement function
3. Compare visually against the PDF output — underlines should align exactly

The PDF generator's measurement functions in `rendering_utils.py` are the source of truth for width calculations.
