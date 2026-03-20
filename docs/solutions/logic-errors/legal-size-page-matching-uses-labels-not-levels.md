---
title: "Legal-size page matching must use level set intersection, not label substring"
category: logic-errors
date: 2026-03-20
tags: [page-size-legal, pdf-generator, idml-generator, layout-engine]
components: [pdf_generator, idml_generator, process_meet]
severity: p1
---

# Legal-size page matching must use level set intersection, not label substring

## Problem

`--page-size-legal "XSA,XD,XP,XG,XS,XB"` always produced "cannot save with zero pages" for the shirt PDF. The gym_highlights legal/letter split also failed — both files got all levels.

## Root Cause

Three places in the Python code used **substring matching against page group labels** to determine which pages go on legal size:

```python
# BROKEN: checks if "XSA" is a substring of "XCEL" — fails!
if any(f.upper() in label.upper() for f in page_group_filter):
```

The layout engine labels Xcel page groups as `"XCEL"`, not the individual level codes. So `"XSA"` is not a substring of `"XCEL"`. But `"XS"` IS — causing inconsistent matching.

Meanwhile, the gym_highlights code in `process_meet.py` used the same broken pattern for splitting levels between letter and legal sizes.

## Solution

Changed all three locations to use **set intersection against actual levels in the page group**:

```python
# FIXED: checks if any filter level is in the page group's level list
filter_set = set(f.upper() for f in page_group_filter)
if filter_set & set(lv.upper() for lv in page_group_levels):
```

Affected files:
- `pdf_generator.py` (shirt PDF legal extraction)
- `idml_generator.py` (IDML legal extraction)
- `process_meet.py` (gym_highlights legal/letter split)

## Prevention

When filtering page groups, always match against the **data** (actual levels in the group), never the **label** (human-readable name). Labels are for display; levels are for logic.
