---
title: "Fix layout engine crash, division ordering, and stale file reuse"
type: fix
status: completed
date: 2026-03-19
---

# Fix Layout Engine Crash, Division Ordering, and Stale File Reuse

## Enhancement Summary

**Deepened on:** 2026-03-19
**Sections enhanced:** 3 (all fixes revised based on 6 parallel review agents)
**Review agents used:** kieran-python-reviewer, kieran-typescript-reviewer, architecture-strategist, publishing-pipeline-guardian, pattern-recognition-specialist, code-simplicity-reviewer

### Key Improvements from Reviews
1. **Bug 2 redesigned**: Fix at the source (`detect_division_order`) instead of adding consumer-side fallbacks. Pattern recognition found the same bug in 2 additional files (`output_generator.py:16`, `order_form_generator.py:288`) — source fix covers all 3 automatically.
2. **Bug 3 strengthened**: Structural enforcement (delete stale files) replaces prompt-only warning. Also fixes pre-existing side-effect bug in `toolListOutputFiles`.
3. **No changes to Bug 1**: All reviewers confirmed the variable hoisting fix is correct and minimal.

### New Considerations Discovered
- `empty_result` and normal return dicts must stay in sync (both have identical key sets — verified)
- `toolListOutputFiles` has a pre-existing bug: calls `getOutputDir(meetName)` with `createIfMissing=true`, silently creating the output directory
- Division ordering fix improves all outputs (PDF, IDML, order forms, gym highlights) since they share precomputed data

## Overview

Three recurring production bugs that share a common theme: **silent failures** that produce wrong output without obvious errors. Each requires an architectural fix rather than prompting changes.

1. **`_page_h` UnboundLocalError** — crashes PDF generation when `levels` is empty
2. **Wrong Gold ordering** — division names from `winners` table don't match `results` table, breaking age-based sort
3. **Agent reuses stale files** — fresh start gives no context about existing output files, so agent presents old files as new

## Problem Statement

These bugs keep recurring because prior fixes addressed symptoms, not root causes:
- Bug 1: Variable initialization order error introduced during the Phase 3 refactor (layout_engine.py extraction)
- Bug 2: `detect_division_order` queries `results` table but sorting in `get_winners_by_event_and_level` uses divisions from `winners` table. Case/whitespace differences between tables cause lookup misses, defaulting to position 99. **Same bug exists in `output_generator.py:16` and `order_form_generator.py:288`.**
- Bug 3: The agent's fresh-start prompt has zero awareness of existing output files. No architectural safeguard prevents the LLM from "discovering" old files and presenting them as done

### Systemic Pattern

All three bugs share a common architectural anti-pattern: **invariant enforcement deferred to downstream consumers rather than enforced at the source.** The fix principle: enforce invariants at write/creation boundaries, not read boundaries.

## Proposed Solution

### Fix 1: `_page_h` UnboundLocalError (`python/core/layout_engine.py`)

**Root cause**: `empty_result` dict (line 160-170) references `_page_h` at line 167, but `_page_h` isn't defined until line 190.

**Fix**: Move `_page_h = page_h or PAGE_H` and `_names_bottom` to before the `empty_result` dict. This is a simple variable hoisting — no logic change.

```python
# BEFORE (broken):
# line 160: empty_result = { ... 'page_h': _page_h, ... }  # _page_h undefined!
# line 190: _page_h = page_h or PAGE_H  # too late

# AFTER (fixed):
# After style dict (line 158), before empty_result (line 160):
_page_h = page_h or PAGE_H
_names_bottom = _page_h - 18

# empty_result now safely references _page_h
```

**File**: `python/core/layout_engine.py:154-192`

### Research Insights (Bug 1)

**Verified safe:** `empty_result` dict has identical keys to the normal return dict at line 252. All downstream consumers (`pdf_generator.py`, `idml_generator.py`, `order_form_generator.py`) check `if not levels` before iterating `data`, so `data: {}` in the empty result is never accessed.

**No other variables have this problem.** All other keys in `empty_result` (`lhr`, `lgap`, `t1l`, etc.) are assigned before line 160. `_page_h` is the only forward-reference.

---

### Fix 2: Division ordering — normalize at the source (`python/core/division_detector.py`)

**Root cause**: `detect_division_order` only queries `results` table for division names. The `winners` table may contain divisions with different case/whitespace. Three separate consumers use `div_order.get(division, 99)` with `winners` data:
- `layout_engine.py:470` — shirt name ordering
- `output_generator.py:16` — back-of-shirt text output
- `order_form_generator.py:288` — order form athlete sorting

**Fix (at the source, not per-consumer)**: Extend `detect_division_order` to also query `winners` table divisions and map any unmatched case variants. This fixes all 3 consumers automatically.

```python
# In detect_division_order(), inside the try block, after raw_divisions is built:
# Also include divisions from winners table (may have different case)
try:
    cur.execute('SELECT DISTINCT division FROM winners WHERE meet_name = ?',
                (meet_name,))
    winner_divs = [row[0] for row in cur.fetchall() if row[0]]
    for div in winner_divs:
        if div not in order:
            key = div.strip().upper()
            if key in canonical_pos:
                order[div] = canonical_pos[key]
            else:
                # Division exists only in winners, not results — score it directly
                score = _score_division(div)
                order[div] = score
except Exception:
    pass  # winners table may not exist yet during initial build
```

**Also add diagnostic logging** in `get_winners_by_event_and_level` (as a safety net):

```python
# After div_order is obtained, before sorting:
winner_divs = {r[1] for r in rows if r[1]}
unmatched = winner_divs - set(div_order.keys())
if unmatched:
    logger.debug("ORDERING_DIAG: %d winner divisions not in div_order: %s",
                 len(unmatched), unmatched)
```

**Files**: `python/core/division_detector.py:132-203`, `python/core/layout_engine.py:428-474`

### Research Insights (Bug 2)

**Why source fix is better than consumer fallback (per architecture + simplicity reviewers):**
- Eliminates the need for `div_order_upper` secondary dict and chained lambda lookup
- Keeps the sort lambda clean and readable
- Fixes all 3 affected consumers at once instead of patching them individually
- Follows the project's established pattern: normalize data at creation, not at consumption

**Edge cases verified safe:**
- `NULL` divisions: filtered by `if row[0]` guard
- `winners` table may not exist during initial DB build: wrapped in `try/except`
- Multiple case variants of same division: `canonical_pos` lookup handles correctly
- Concatenated MSO abbreviations: `_score_division` already handles via fallback regex

---

### Fix 3: Structural stale file cleanup + prompt warning (`src/main/agent-loop.ts`)

**Root cause**: Fresh start path gives zero context about existing output files. No structural enforcement prevents the agent from finding and presenting stale files.

**Fix (two parts — structural + informational)**:

**Part A: Delete stale output files on fresh start** (structural enforcement):

```typescript
// Inside the else block (fresh start), before context.messages.push:
let staleFileWarning = '';
const outputDir = getOutputDir(meetName, false);
if (fs.existsSync(outputDir)) {
  try {
    const staleFiles = fs.readdirSync(outputDir)
      .filter(f => !f.startsWith('.') && f !== 'process_log.md');
    if (staleFiles.length > 0) {
      for (const f of staleFiles) {
        fs.unlinkSync(path.join(outputDir, f));
      }
      this.onActivity(`Cleared ${staleFiles.length} stale file(s) from previous run`, 'warning');
      staleFileWarning = '\n\nNote: Stale output files from a previous run were cleared. Generate all outputs fresh.';
    }
  } catch {
    // Output directory not readable — skip stale file cleanup
  }
}
```

Then append `staleFileWarning` to the fresh-start user message.

**Part B: Fix pre-existing side-effect bug in `toolListOutputFiles`** (`context-tools.ts:279`):

```typescript
// BEFORE (creates directory as side effect):
const dir = getOutputDir(meetName);

// AFTER:
const dir = getOutputDir(meetName, false);
```

**Files**: `src/main/agent-loop.ts:154-160`, `src/main/context-tools.ts:279`

### Research Insights (Bug 3)

**Why structural enforcement over prompt-only (per architecture + TypeScript reviewers):**
- Prompt compliance is probabilistic; file deletion is deterministic
- Mirrors existing pattern: `resetStagingDb()` already deletes stale staging DB on line 88
- Mirrors data layer: `_create_winners_table` does `DELETE FROM winners WHERE meet_name = ?`
- `process_log.md` is preserved (excluded from deletion) so the user can still review what happened in the previous run

**Edge cases:**
- Resume path unaffected: stale file cleanup is strictly inside the `else` block (fresh start only)
- Empty directory: `staleFiles.length > 0` guard prevents unnecessary logging
- Locked files (e.g., PDF open in viewer): `unlinkSync` will throw on Windows, caught by try/catch. The agent will still regenerate and `_safe_move` in Python handles locked targets with `_NEW` suffix
- Hidden/OS files (`.DS_Store`, `Thumbs.db`): filtered by `!f.startsWith('.')`

## Acceptance Criteria

### Bug 1: `_page_h` fix
- [x] `_page_h` and `_names_bottom` are defined before `empty_result` dict in `precompute_shirt_data`
- [x] `precompute_shirt_data` returns successfully when `levels` is empty (no crash)
- [x] `empty_result` dict contains correct `page_h` value
- [x] Full pipeline (non-empty levels) still works identically

### Bug 2: Division ordering fix
- [x] `detect_division_order` queries both `results` and `winners` tables for division names
- [x] All case variants from `winners` are mapped in the returned `div_order` dict
- [x] Names sorted correctly by age group in `layout_engine.py`, `output_generator.py`, and `order_form_generator.py` — all benefit from source fix
- [x] Diagnostic debug logging in `get_winners_by_event_and_level` for safety net
- [x] Existing division detection logic (canonical forms, concatenated abbreviations) unchanged
- [x] `winners` table not existing (during initial build) handled gracefully

### Bug 3: Stale file cleanup
- [x] Stale output files deleted on fresh start (structural enforcement)
- [x] `process_log.md` preserved (not deleted)
- [x] Informational note in fresh-start prompt about cleared files
- [x] `onActivity` log message when stale files are cleared
- [x] Resume path (saved progress) unaffected — cleanup only in fresh-start branch
- [x] `toolListOutputFiles` fixed to use `getOutputDir(meetName, false)` — no side-effect directory creation
- [x] try/catch around `readdirSync`/`unlinkSync` for robustness

## Dependencies & Risks

- Python changes require PyInstaller rebuild (`npm run build` + rebuild binary)
- Division ordering fix is at the source — all consumers benefit automatically, no per-consumer changes needed
- Stale file deletion is safe: output files are generated artifacts that can always be regenerated
- `process_log.md` is preserved so previous run history is not lost
- On Windows, locked files (open in PDF viewer) may fail to delete — caught by try/catch, agent will still regenerate and Python's `_safe_move` handles locked targets

## Implementation Order

1. **Bug 1** first (blocks PDF generation — most critical)
2. **Bug 2** second (wrong output is worse than no output)
3. **Bug 3** third (agent behavior improvement + side-effect bug fix)
