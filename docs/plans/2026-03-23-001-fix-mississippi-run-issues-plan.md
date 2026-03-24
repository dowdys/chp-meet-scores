---
title: "Fix critical issues from Mississippi 2025 process log: duplicate data, state filter, orphan winners, order form pages"
type: fix
status: completed
date: 2026-03-23
---

# Fix: Mississippi 2025 Process Log Issues

## Overview

40-iteration run (87K input tokens) exposed 11 distinct issues. Many stem from the same root causes: duplicate extraction data, meet name inconsistency, state filter normalization, and the agent manually modifying the central DB. The run should have taken ~15 iterations.

## Critical Issues

### 1. MSO extraction produces ~4x duplicate records [CRITICAL BUG]
**Observed**: `build_database` reported "Parsed 613 athletes" but DB had 2,558 records. After exact-duplicate removal, 1,939 records remained with 57 gyms (should be 22).
**Impact**: Agent spent 8 iterations (4-10) writing custom dedup scripts. Data quality was wrong throughout.
**Root cause hypothesis**: The MSO API `lookup_scores` may return multiple result sets (e.g., preliminary + final scores), and `mso_extract` concatenates them all. Or the `generic` adapter is loading the file multiple times.
**Investigation needed**:
- Check `mso_extract` response for duplicate athlete entries in the raw JSON
- Check `generic_adapter.py` for any logic that could multiply records
- Check if `build_database` is loading stale extract files alongside the new one
**Fix**: Deduplicate at extraction time (in `mso_extract`) or in the generic adapter before DB insert.

**Files**: `src/main/tools/extraction-tools.ts`, `python/adapters/generic_adapter.py`, `python/process_meet.py`

### 2. search_meets state filter doesn't normalize state names [BUG]
**Observed**: Query `"Mississippi State 2025"` with state `"Mississippi"` → MSO regex compares `"mississippi" !== "ms"` → all MSO results filtered out. Only Perplexity found the meet.
**Impact**: Season-aware search (the fix we just implemented) was bypassed because the state filter killed all MSO results before they could be evaluated.
**Fix**: Normalize state filter to handle both full names ("Mississippi") and 2-letter codes ("MS"). Add a state name → abbreviation map.

**File**: `src/main/tools/search-tools.ts`

### 3. Agent manually modifies central DB, creating orphan winners [ARCHITECTURE]
**Observed**: Agent wrote custom Python scripts to delete duplicates and rebuild the winners table directly in the central DB. This created 614 orphan winners (winners without matching results) because the meet name in the central DB was `"2025 Mississippi All Levels"` (from a previous run) while the winners were under `"2025 Mississippi State Championships"`.
**Impact**: 11 iterations (21-31) debugging the orphan winners. Order forms had 774 pages, then 367 after rebuild — both wrong.
**Root cause**:
1. `run_script` allows the agent to write arbitrary SQL, including to the central DB
2. No architectural guard prevents the agent from modifying the central DB directly
3. The staging → finalize flow was bypassed entirely
**Fix**:
- `run_script` should ONLY have write access to the staging DB during processing
- Add a read-only flag to central DB connections during processing phases
- OR: make `run_script` SQL execution read-only (SELECT only) like `query_db`
- The agent should NEVER rebuild winners manually — it should re-run `build_database`

**Files**: `src/main/tools/python-tools.ts`, `python/process_meet.py`

### 4. Order forms page count is wrong (367 instead of ~370) [BUG]
**Observed**: 185 unique winners × 2 pages each = 370 expected. Got 367 (183 forms × 2 + 1 extra header page). 2 winners are missing their order forms.
**Impact**: Missing backs for some athletes, orphan header page at end with misplaced stars.
**Investigation needed**: Check `order_form_generator.py` — which 2 winners are being dropped? Is it a name search failure?
**Fix**: Debug the 2 missing winners and fix the orphan page.

**File**: `python/core/order_form_generator.py`

### 5. Dead source types still mislead agent [CARRY-OVER]
**Observed**: In the PREVIOUS run (not this one), agent used `source: "mso_html"` instead of `"generic"`. This run used `"generic"` correctly, but the dead options still exist.
**Fix**: Remove `mso_html` and `mso_pdf` from the source enum. Rename `source` parameter to represent data provenance ("mso", "scorecat") and auto-detect file format.

**Files**: `src/main/tool-definitions.ts`, `python/process_meet.py`, `python/adapters/`

### 6. Dates have wrong year (2026 instead of 2025) [BUG]
**Observed**: Agent passed `"2026-04-12"` for postmark date (line 217) even though the meet is 2025. User said "April 12, 17, 25" without specifying year. The date formatting fix should catch this (use meet year), but the agent also needs to ask for clarification.
**Impact**: Order forms show "APRIL 12" without year — may be OK for the form, but the internal data is wrong.
**Fix**: The `_format_date` fix from the previous plan should handle this. But also: the agent prompt should say "If the user doesn't specify a year, use the meet year."

**File**: `src/main/workflow-phases.ts`

### 7. No `[staging]`/`[central]` labels on query_db results [DEPLOYMENT]
**Observed**: All `query_db` results in the log lack the `[staging]` or `[central]` prefix. This confirms the previous code changes weren't deployed.
**Fix**: Already implemented — just needs proper build + sync verification.

### 8. Scroll still auto-scrolls to bottom [UI BUG]
**Observed**: User reported this at the start of this conversation.
**Fix**: Already re-implemented with simpler approach (check distance from bottom in useEffect, no scroll handler needed). Needs build + sync.

## Acceptance Criteria

- [x] `mso_extract` produces exactly 613 unique records for Mississippi (no duplicates) — root cause: stale garbled records from wrong source type not cleaned by meet_name-specific DELETE. Fixed: staging DB now truncates ALL data on each build.
- [x] `search_meets` with state `"Mississippi"` finds MSO meets listed under `"ms"` — added normalizeState() with full STATE_ABBREVS map
- [x] `run_script` cannot write to the central DB during processing phases — DB_PATH now points to staging DB when it exists
- [ ] Order forms have exactly 185 × 2 = 370 pages for 185 unique winners — added diagnostic logging to identify dropped athletes. Root cause likely in name search or clean_name_for_shirt. Needs data-specific testing.
- [x] `mso_html` and `mso_pdf` removed from source enum — only "scorecat" and "generic" remain in tool definition. Python treats legacy values as generic for backwards compat.
- [x] Dates default to meet year when year is omitted — prompt updated to use meet year, not current year
- [x] `query_db` shows `[staging]`/`[central]` labels — deployed and verified in build
- [x] Activity log holds scroll position — simplified approach deployed and verified

## Implementation Priority

1. **#1 (duplicate extraction)** — root cause of the worst iteration waste
2. **#2 (state filter normalization)** — broke the season-aware search
3. **#3 (protect central DB from run_script)** — prevents agent from creating orphans
4. **#5 (remove dead sources)** — prevents future source-type confusion
5. **#4 (order form page count)** — output quality
6. **#6 (date year)** — already partially fixed
7. **#7, #8 (deployment)** — already implemented, just needs sync
