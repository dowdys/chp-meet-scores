---
title: "Fix gym highlights level-group splitting, division ordering, and agent behavior bugs"
type: fix
status: completed
date: 2026-03-19
---

# Fix Gym Highlights Level-Group Splitting, Division Ordering, and Agent Behavior Bugs

## Overview

Three production test runs on 2026-03-19 revealed multiple issues: (1) gym highlights PDFs include ALL levels instead of being split by page group (8.5x11 should only have numbered levels, 8.5x14 should only have Xcel), (2) Arkansas divisions with compound names like JR A1, JR B2, SR C3 are not sorted youngest-to-oldest, (3) agent wastes iterations on redundant searches and doesn't load the output_generation skill when it should, and (4) the `--level-groups` flag is being ignored on `--regenerate` (the diagnostic shows 4 pages despite custom 2-group layout).

## Problem 1: Gym Highlights Not Split by Page Group

**Source:** Nevada test run (both Dowdy's and user's runs)

When the user requests split backs (Xcel on 8.5x14, Levels 2-10 on 8.5x11), the gym highlights PDFs should match:
- `gym_highlights.pdf` (8.5x11) → only Levels 2-10 winners highlighted
- `gym_highlights_8.5x14.pdf` (8.5x14) → only Xcel winners highlighted

**Current behavior:** Both gym highlights PDFs include ALL 285 winners across ALL pages. Both have 27 pages (should be ~11 and ~16 respectively).

**Root cause:** `generate_gym_highlights_pdf` generates highlights for all winners in the database without filtering by which page group they belong to. The `--page-size-legal` flag creates a separate legal-size shirt back, but the gym highlights don't know which levels belong to which size.

**Fix:** When `--page-size-legal` is used with level groups, the gym highlights generator needs to:
1. For `gym_highlights.pdf` (letter): only include winners from the non-legal page groups
2. For `gym_highlights_8.5x14.pdf` (legal): only include winners from the legal page groups
3. This requires passing the level-group→page-size mapping to the gym highlights generator, or generating highlights from the actual shirt PDF (which already has the correct pages)

## Problem 2: `--level-groups` Ignored on `--regenerate`

**Source:** Nevada test run (Dowdy's run, iteration 19)

The user passed `--regenerate shirt --level-groups "XSA,XD,XP,XG,XS,XB;10,9,8,7,6,5,4,3,2"` but the diagnostic still shows:
```
SHIRT_DIAG: final page_groups (4 pages): [('XCEL', 4), ('XCEL', 2), ('LEVELS 6-10', 5), ('LEVELS 2-5', 4)]
```
This is the AUTO-binpacked layout, not the requested 2-group custom layout. The custom `--level-groups` appears later in the output, suggesting the first `precompute_shirt_data` call (for the pre-check or PDF) didn't receive it.

**Root cause:** Likely the cached `precomputed` dict from the first call (without level_groups) is being reused for subsequent calls. The `level_groups` and `exclude_levels` are run-time overrides that must be passed to EVERY `precompute_shirt_data` call, even when using cached data — or the cache must include them.

**Fix:** Ensure `level_groups` and `exclude_levels` are passed through to ALL precompute calls in the `--regenerate` path, and that the cached precomputed result includes the correct level_groups.

## Problem 3: Arkansas Division Ordering (JR A1/B2/C3)

**Source:** Arkansas test run (process_log (9).md)

The user reported: "It's not putting the JR1A, JR1B, etc in the correct order....like the first time"

The division order detected was:
```
['JR', 'Jr A', 'JR A', 'JR B', 'Jr B', 'Jr C', 'JR C', 'Jr D', 'JR D', 'JR B1', 'JR C3', 'JR B3', 'JR A3', 'JR A2', 'JR C1', 'JR A1', 'JR C2', 'JR B2', 'JR E', 'SR', 'Sr A', 'SR A', 'Sr B', 'SR B', 'SR C', 'Sr C', 'SR D', 'SR B2', 'SR A3', 'SR A1', 'SR E', 'SR B3', 'SR A2', 'SR B1', 'ALL']
```

The correct order should be: JR A1, JR A2, JR A3, JR B1, JR B2, JR B3, JR C1, JR C2, JR C3, JR D, JR E, then SR A1, SR A2, etc. (youngest first within each tier, then older tiers).

**Root cause:** The `division_detector.py` scoring algorithm doesn't handle compound division names like "JR A1", "JR B2", "SR C3" correctly. It likely scores "JR" divisions generically without parsing the letter+number suffix into a meaningful age order. The `_score_division()` function needs to recognize these patterns.

**Additional issue:** Case inconsistency — both "JR A" and "Jr A" and "JR A1" appear as separate divisions. These should be normalized (e.g., all uppercase) before scoring.

**Fix:** Update `division_detector.py` to:
1. Normalize case (JR A = Jr A = jr a)
2. Parse compound divisions: "JR A1" → tier=JR, group=A, number=1
3. Sort: JR before SR, then A before B before C, then 1 before 2 before 3
4. Handle edge cases: "JR" alone (no sub-group), "ALL", unnamed divisions

## Problem 4: Agent Behavior Issues

**Source:** All three test runs

### 4a. Redundant ScoreCat search after MSO success (Nevada)
The agent found the meet on MSO (meetId 34775) but then also searched ScoreCat unnecessarily. The meet_discovery skill says: "if one search finds a meet on MSO, do NOT also search ScoreCat."

### 4b. Agent doesn't load output_generation skill
In the Nevada run, when the user asked for specific level grouping and gym highlights splitting, the agent didn't load the `output_generation` skill which has detailed instructions for `--page-size-legal` and `--level-groups` flags. It tried to guess the flags instead.

### 4c. UnicodeDecodeError on Windows (Arkansas user's machine)
The `run_script` tool crashed with `UnicodeDecodeError: 'charmap' codec can't decode byte 0x8d` when reading the extracted JSON. This is because Windows Python defaults to cp1252 encoding. The agent had to manually add `encoding='utf-8'` to work around it.

### 4d. Agent applied layout changes globally instead of per-page-group (Arkansas)
When the user asked to "make the names spread out more so that it takes up more of the page — only on the xcel back," the agent adjusted `--min-font-size`, `--max-font-size`, `--line-spacing`, `--level-gap` globally, which changed BOTH pages. These layout params currently apply uniformly to all page groups — there's no way to adjust one page group without affecting others.

### 4e. ICML still generated (Arkansas)
The output includes `back_of_shirt.icml` even though we deprecated ICML in the refactoring. The PyInstaller binary being used is an older version that still generates ICML.

## Proposed Solution

### Fix 1: Gym highlights level-group filtering

Add a `page_group_filter` parameter to `generate_gym_highlights_pdf` and `generate_gym_highlights_from_pdf`. When present, only include winners whose level is in the specified page group's level list.

In `process_meet.py`, when `--page-size-legal` is used:
- Call `generate_gym_highlights_pdf` for letter size with `page_group_filter` set to the non-legal groups' levels
- Call `generate_gym_highlights_pdf` for legal size with `page_group_filter` set to the legal groups' levels

### Fix 2: Level-groups on --regenerate

Audit the `--regenerate` path in `process_meet.py` to ensure `level_groups` and `exclude_levels` are passed to the precompute call, not just to the downstream generators. If using cached precomputed data, the cache must have been computed WITH the correct level_groups.

### Fix 3: Division ordering for compound names

Rewrite `_score_division()` in `division_detector.py` to handle:
1. Case normalization before scoring
2. Compound patterns: parse "JR A1" into (tier_score, group_score, number_score)
3. Tier ordering: JR=100, SR=200 (or similar base scores)
4. Group ordering: A=1, B=2, C=3, D=4, E=5
5. Number ordering: 1, 2, 3 within each group
6. Merge duplicate divisions (case-insensitive: "JR A" = "Jr A")

### Fix 4: Agent behavior improvements

4a. Strengthen the system prompt: "After finding a meet on MSO, STOP searching. Do NOT also search ScoreCat."
4b. Add to system prompt: "When user requests custom level grouping or page sizes, ALWAYS load the output_generation skill first."
4c. The UnicodeDecodeError is already fixed — the refactored code adds `encoding='utf-8'` everywhere. But the deployed binary needs to be rebuilt.
4d. Per-page-group layout params: this is a feature request, not a bug. Flag for future consideration.
4e. Rebuild and deploy the PyInstaller binary with the refactored code (ICML removed, all fixes applied).

## Acceptance Criteria

- [x] `gym_highlights.pdf` (letter) only contains winners from letter-size page groups
- [x] `gym_highlights_8.5x14.pdf` (legal) only contains winners from legal-size page groups
- [x] `--level-groups` on `--regenerate` produces the correct page layout (not auto-binpacked)
- [x] Arkansas-style divisions (JR A1, JR B2, SR C3) sort correctly: youngest first within each tier
- [x] Division case normalization: "JR A" and "Jr A" treated as same division
- [x] Agent stops searching after MSO success (update system prompt)
- [x] Agent loads output_generation skill for custom layout requests
- [x] PyInstaller binary rebuilt with all refactoring changes

## Technical Details

### Files to modify:
- `python/core/pdf_generator.py` — add `page_group_filter` to gym highlights functions
- `python/process_meet.py` — pass level-group→size mapping to gym highlights, fix --regenerate level_groups
- `python/core/division_detector.py` — rewrite `_score_division()` for compound division names
- `python/core/layout_engine.py` — ensure precompute cache respects level_groups
- `skills/system-prompt.md` — agent behavior improvements
- `skills/output_generation.md` — ensure gym highlights splitting is documented

### Priority:
1. **P1:** Gym highlights splitting (affects every meet with split backs — this is a production blocker)
2. **P1:** Level-groups on --regenerate (the flag is being ignored)
3. **P1:** Division ordering (Arkansas user saw wrong results)
4. **P2:** Agent behavior improvements (system prompt updates)
5. **P2:** Binary rebuild with refactored code

## Sources
- Nevada test run: `C:\Users\goduk\OneDrive\Documents\Gymnastics Champions\2026 Nevada State Championships\process_log.md`
- User test run (Nevada): `C:\Users\goduk\Downloads\process_log (8).md`
- User test run (Arkansas): `C:\Users\goduk\Downloads\process_log (9).md`
