---
title: "Shirt regeneration cascade must be conditional on import status"
category: logic-errors
tags:
  - cascade
  - regeneration
  - gym-highlights
  - import-backs
  - output-dependencies
module: process_meet
symptom: "Gym highlights overlay positions are misaligned after shirt layout changes because gym_highlights was not included in the regeneration cascade"
root_cause: "The output dependency graph differs by workflow mode — gym_highlights depends on back_of_shirt.pdf in code-generated mode but is independent in imported mode. A static cascade is wrong for one of the two modes."
date: 2026-03-31
---

# Shirt regeneration cascade must be conditional on import status

## Problem

The `--regenerate shirt` cascade originally included all 5 outputs (shirt, idml, order_forms, gym_highlights, summary). This was wasteful for layout tweaks. Removing `gym_highlights` from the cascade seemed safe because "gym_highlights is independent of the shirt PDF."

This is only true for the **imported workflow**. In the **code-generated workflow**, `gym_highlights.pdf` uses `back_of_shirt.pdf` as a background image and overlays highlighted names at specific X/Y coordinates derived from the shirt layout.

If the shirt layout changes (different font size, different page breaks, different bin-packing) but `gym_highlights` is not regenerated, the highlight overlays are misaligned against the new shirt — names highlighted in the wrong positions.

## Root Cause

The output dependency graph differs based on workflow mode:

| Output | Code-generated mode | Imported mode |
|--------|--------------------|---------------|
| `gym_highlights` | Depends on `back_of_shirt.pdf` (reads it as background, derives overlay X/Y from shirt layout) | Independent — regenerated from DB data, does not use the imported PDF as base |

A static cascade (always include or always exclude `gym_highlights`) is wrong for one of the two modes.

## Solution

Check `saved_layout.get('_source')` to determine the workflow mode before deciding whether to include `gym_highlights` in the cascade:

```python
if 'shirt' in regen_set:
    regen_set.update(['order_forms', 'summary'])
    if saved_layout.get('_source') != 'imported':
        regen_set.add('gym_highlights')
```

The `_source` sentinel in `shirt_layout.json` is the authoritative indicator of which mode is active.

**File:** `python/process_meet.py` (regeneration cascade section)

## Key Insight

Output dependency graphs can be workflow-conditional. Before removing an output from a cascade, trace its dependencies in **all workflow modes** (code-generated, imported, mixed), not just the one you are currently testing.

The same output can be a downstream dependent in one mode and a fully independent artifact in another. The fact that something "seemed safe to remove" during imported-mode testing does not mean it is safe to remove for code-generated mode.

## Prevention

When modifying regeneration cascades:

1. Draw the dependency graph for each workflow mode explicitly.
2. Verify the cascade is correct for all modes before committing.
3. Use the `_source` sentinel in `shirt_layout.json` as the branch condition — do not infer mode from other heuristics.
4. If a cascade change is only tested in one mode, add a comment noting the untested mode and what its expected behavior should be.
