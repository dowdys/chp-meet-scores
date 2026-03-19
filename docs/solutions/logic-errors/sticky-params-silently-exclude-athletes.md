---
title: "Sticky CLI params silently excluded athletes from shirt across runs"
category: "logic-errors"
date: "2026-03-19"
tags:
  - sticky-params
  - shirt-layout
  - exclude-levels
  - level-groups
  - silent-data-loss
severity: high
component: "python/process_meet.py"
symptoms:
  - "Shirt PDF missing entire level groups (e.g., all Xcel athletes)"
  - "163 athletes MISSING backs on order forms"
  - "meet_summary shows correct winner counts but shirt only has partial athletes"
  - "--level-groups flag appears to have no effect"
---

## Problem

After running `--exclude-levels "10,9,8,7,6,5,4,3,2"` once (to generate an Xcel-only legal sheet), every subsequent run — even without that flag — produced a 1-page shirt missing 122 athletes. The `--level-groups` flag also appeared to have no effect because the saved exclusions filtered levels before group parsing could see them.

## Root Cause

`exclude_levels`, `level_groups`, and `page_size` were included in `LAYOUT_PARAMS` — the list of CLI arguments saved to `shirt_layout.json` and automatically restored on future runs. This was intentional for true layout preferences (`line_spacing`, `font_family`, etc.) but catastrophic for **destructive filters** that change between runs.

The save/restore mechanism:
```python
# Saves ALL LAYOUT_PARAMS to shirt_layout.json after each run
for param in LAYOUT_PARAMS:
    val = getattr(args, param)
    if val is not None:
        effective_layout[param] = val

# Restores saved values when CLI doesn't explicitly set them
for param in LAYOUT_PARAMS:
    cli_val = getattr(args, param)
    if cli_val is None and param in saved_layout:
        setattr(args, param, saved_layout[param])  # Silent injection!
```

When `exclude_levels` was saved as `"10,9,8,7,6,5,4,3,2"`, every `--regenerate shirt` call silently loaded that exclusion. The script printed no warning that saved exclusions were being applied. The only visible symptom was a wrong athlete count in the output.

The same bug existed in `LAYOUT_PARAMS_IMPORT` (the import-idml code path) — a second copy of the list that also needed fixing.

## Solution

Removed `level_groups`, `exclude_levels`, and `page_size` from both `LAYOUT_PARAMS` and `LAYOUT_PARAMS_IMPORT`:

```python
# NOTE: level_groups, exclude_levels, and page_size are intentionally NOT
# persisted here — they are per-run overrides, not sticky layout settings.
# Persisting them caused bugs where subsequent runs applied stale exclusions.
LAYOUT_PARAMS = ['line_spacing', 'level_gap', 'max_fill',
                 'min_font_size', 'max_font_size', 'max_shirt_pages',
                 'title1_size', 'title2_size',
                 'copyright', 'accent_color', 'font_family',
                 'sport', 'title_prefix', 'header_size', 'divider_size']
```

## Prevention

**The rule:** Only persist params that adjust *appearance* (font size, spacing, colors). Never persist params that *filter data* (exclude levels, select groups) or *change file structure* (page size). The test: "If this value silently carries forward to the next run, could it produce wrong output?" If yes, don't persist it.
