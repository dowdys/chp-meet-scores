---
title: "Fix data quality ordering, meet summary stats, order form sorting, search_meets gaps, sticky param leaking, default legal size"
type: fix
status: completed
date: 2026-03-21
---

# Fix: Mississippi Process Log Issues

## Overview

Six issues found from the 2025 Mississippi State Championship processing run. Ranges from architectural bugs (sticky params leaking between meets) to feature requests (gym-level winner stats, order form sorting).

## Issues

### 1. Data quality checks run AFTER output generation [ARCHITECTURE]
**Problem**: `build_database` generates all output files (PDFs, IDMLs) and THEN the agent runs quality checks. If quality checks find issues, all outputs need to be regenerated. This is backwards and wasteful.
**Fix**: Make `build_database` ONLY build the database by default — no output generation. The flow becomes:
1. `build_database` → parse data, normalize gyms, build results + winners tables (NO output files)
2. Agent runs quality checks on the staging DB
3. Agent calls `regenerate_output` to generate all output files ONLY after quality passes
This is cleaner, more efficient, and matches the natural workflow. No flag needed — this is the new default behavior.
**Implementation**: Remove the output generation calls from the Python full-pipeline path (the `--source` code path in process_meet.py). The `--regenerate` path already handles output generation independently.

### 2. Meet summary needs gym-level winner counts [FEATURE]
**Problem**: Meet summary shows winner counts per level and per event, but not per gym or per level per gym.
**Fix**: Add two new sections to `generate_meet_summary`:
- "Winners per gym" — alphabetical, showing total unique winners for each gym
- "Winners per level per gym" — nested breakdown

### 3. Order forms should be sorted by back page, then by gym [FEATURE]
**Problem**: Order forms are currently ordered by gym alphabetically across all levels. User wants: group by back page (all athletes on back page 1 together, then all on page 2), and within each group, sort by gym alphabetically.
**Fix**: Modify `generate_order_forms_pdf` to sort athletes by page group first, then by gym. This requires knowing which athletes are on which shirt page.

### 4. search_meets can't find older/archived meets on MSO [BUG]
**Problem**: The 2025 Mississippi State Championship (MSO ID 34508) is NOT in the MSO Results.All page — it's been archived. `search_meets` only searches Results.All, so it missed this meet entirely.

**Investigation findings:**
- MSO JSON API still returns data for archived meet 34508 (613 athletes) — data is there, just not listed
- No search/list API on MSO — we can only get data if we know the meet ID
- Results.All only shows recent/active meets (~1465 total)
- Calendar pages mention archived meets but are JS-rendered (can't parse with http_fetch)
- Direct URL `/R34508` works — meet page is accessible, just not discoverable via Results.All
- Google web search DOES find the meet URL when agent uses `web_search` through Chrome

**Fix**: Add **Perplexity** as a fallback in `search_meets`:
- If MSO Results.All returns NO state championship matches for the queried state/year, call Perplexity: `"What is the MeetScoresOnline.com meet ID for the {year} {state} State Championship gymnastics meet?"`
- Perplexity returns the meet ID directly (tested: returns "34508" for Mississippi)
- Parse the response for `/R{meetid}` patterns or numeric meet IDs
- No Chrome needed — Perplexity is a direct API call via `perplexity ask`
- MSO API confirmed: `lookup_meet` with meetid+eventid returns full metadata (name, dates, host, location)
- MSO API limitation: cannot search by state/year — needs the meet ID first

**Implementation**: In `search_meets` executor (search-tools.ts):
1. Search Algolia (ScoreCat) — existing
2. Search MSO Results.All — existing
3. NEW: If no state championship found AND Perplexity API key is configured, call Perplexity
4. Parse Perplexity response for MSO meet IDs or source hints
5. Verify found IDs via MSO `lookup_scores` API (confirms data exists, pure API)
6. If no Perplexity key, skip gracefully — agent falls back to web_search as before

**API key requirement**: Add `perplexityApiKey` to app settings (config-store.ts, Settings tab). Stored encrypted like the LLM API key. search_meets checks if key exists and skips Perplexity step if not configured.

**Flow for MSO archived meets**: Perplexity → get meet ID → mso_extract (direct API, no Chrome). Pure API calls end to end.

**Broader use**: Perplexity should be the FIRST fallback whenever search_meets can't find a meet — it can identify the source (MSO, ScoreCat, MyMeetScores, or other) and point the agent to the right extraction tool.

### 5. Sticky params leak between meets [CRITICAL BUG]
**Problem**: `shirt_layout.json` is in the shared data directory, not per-meet. Nevada's `level_groups` ("XSA,XD,XP,XG,XS,XB;10,9,8,7,6,5,4,3,2") and `page_size_legal` leaked into the Mississippi run, causing:
- Unwanted 8.5x14 legal-size outputs
- Xcel being split into a separate page group (which Mississippi may or may not want)
- gym_highlights_8.5x14.pdf failing with "cannot save with zero pages" (because Mississippi had no legal-size page groups)
**Fix**: Reset `shirt_layout.json` at the start of each new `build_database` call. Per-meet sticky params should only persist across regenerations of the SAME meet, not carry over to different meets.

### 6. Legal size should NEVER be generated unless explicitly requested [ARCHITECTURE]
**Problem**: The system generated `back_of_shirt_8.5x14.pdf` and `back_of_shirt_8.5x14.idml` for Mississippi without anyone asking for legal size. Every state is different — legal size should only happen when the user explicitly requests it.
**Fix**: Related to #5 — once sticky params are reset per-meet, legal size won't carry over. But also: the Python code should not generate legal-size outputs unless `page_size_legal` is explicitly set. Check if the code generates legal-size outputs by default.

## Acceptance Criteria

- [x] `build_database` only builds DB by default (no output generation) — `do_all = False`
- [x] Database phase prompt tells agent: build DB → quality checks → advance to output_finalize → generate outputs
- [x] Meet summary includes winners per gym and winners per level per gym
- [x] Order forms sorted by back page group, then alphabetically by gym
- [x] `shirt_layout.json` reset at start of each `build_database` call for NEW meets
- [x] Legal-size outputs only generated when `page_size_legal` is explicitly set (reset clears it)
- [x] `search_meets` falls back to Perplexity for archived meets (requires API key in settings)

## Implementation Priority

1. **#5 (sticky param leaking)** — most critical, causes wrong outputs
2. **#6 (default legal size)** — directly related to #5
3. **#1 (quality before outputs)** — architectural improvement
4. **#4 (search_meets)** — discovery improvement
5. **#2 (meet summary stats)** — feature
6. **#3 (order form sorting)** — feature
