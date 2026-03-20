---
title: "level_groups and page_size_legal must be sticky params"
category: logic-errors
date: 2026-03-20
tags: [sticky-params, shirt-layout, level-groups, regeneration]
components: [process_meet, layout_engine]
severity: p1
---

# level_groups and page_size_legal must be sticky params

## Problem

User set custom level grouping ("all Xcel on one page, Levels 2-10 on another" = 2 pages). Any subsequent `--regenerate` call that didn't explicitly re-pass `--level-groups` reverted to the auto-grouping algorithm, which produced 4 pages. The agent would regenerate to adjust dates or font sizes, and the page layout silently reverted.

## Root Cause

`level_groups` and `page_size_legal` were intentionally excluded from `STICKY_FIELDS` in `models.py` with the comment "destructive filters must NEVER be included here." The reasoning was that these params fundamentally change which athletes appear on the shirt, so they shouldn't persist accidentally.

But in practice, NOT persisting them is MORE destructive: every regeneration without explicit level_groups wipes the user's layout decision and reverts to 4 pages. The user then has to re-specify the grouping, wasting iterations.

## Solution

Added save/restore logic in `process_meet.py`:
- After generating shirt PDF, save `level_groups` and `page_size_legal` to `shirt_layout.json`
- On regeneration, if these params aren't provided on CLI, restore them from `shirt_layout.json`
- `--force` still clears all sticky params (including these) for a fresh start

## Prevention

When deciding whether a parameter should be sticky: consider what happens when the user calls `--regenerate` for an unrelated reason (e.g., changing dates). If the parameter silently reverts to default and produces a visibly different output, it should be sticky. The "destructive filter" exception should only apply to params whose default behavior is safe, not to params whose default behavior is *different from what the user chose*.
