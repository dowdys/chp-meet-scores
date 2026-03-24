---
title: "Fix activity log scroll, staging DB bugs, date formatting, meet name standardization, search_meets MSO"
type: fix
status: completed
date: 2026-03-21
---

# Fix: Activity Log, DB Architecture, Dates, Meet Names, Search

## Overview

Six issues from Mississippi process log review and architectural audit. Ranges from UI bugs (scroll position) to data architecture (staging DB, meet naming convention).

## Issues

### 1. ActivityLog scroll still yanks to bottom [UI BUG]
**Problem**: `scrollIntoView` on the sentinel div fires on every new entry. Layout shifts from new content trigger the `onScroll` handler, which recalculates `distanceFromBottom` and can reset `userScrolledUp` to false before the useEffect checks it. The 50px threshold is too small.
**Fix**:
- Replace `scrollIntoView` with direct `scrollTop` assignment
- Track intentional user scrolls vs layout-shift scrolls using a `isAutoScrolling` ref guard
- Increase threshold or use a different detection method (track `scrollTop` before/after renders)

**File**: `src/renderer/components/ActivityLog.tsx`

### 2. search_meets only checks current season on MSO [BUG]
**Problem**: `search_meets` only fetches `Results.All` (current season 2025-2026). Meets from previous seasons live on season-specific pages like `Results.All.2024-2025`. The 2025 Mississippi State Championship (meetId 34508) is on the 2024-2025 season page, so `search_meets` never found it and jumped straight to Perplexity.
**Confirmed**: The raw HTML fetch works fine — MSO server-side renders 1,465+ `data-meetid` attributes. No Chrome needed. The regex matches correctly. The only issue is which season page we search.
**Fix** (verified end-to-end — confirmed working):
- Extract the year from the query (e.g., "2025" from "2025 mississippi state championship")
- Determine which MSO season that year falls in: year N → season "{N-1}-{N}"
- If the query year's season differs from the current season, ALSO fetch `Results.All.{N-1}-{N}`
- Example: query year 2025 → season "2024-2025" → fetch `Results.All.2024-2025`
- Always search current season first (fast path for recent meets), then add previous season if year suggests it
- Verified: `Results.All.2024-2025` returns 1,777 meets with server-rendered `data-meetid` attributes; meet 34508 found with 4/4 query word match
- Perplexity remains the fallback only for truly unfindable meets

**File**: `src/main/tools/search-tools.ts`

### 3. Staging vs Central DB — multiple bugs [CRITICAL]

#### 3a. openDb() has no phase awareness
**Problem**: `openDb()` calls `getStagingDbPath()` which returns a path, but the staging DB file only exists after `build_database` creates it. Before that, `fs.existsSync()` returns false → falls through to central DB. The agent has no idea which DB was queried.
**Fix**:
- Accept an optional `phase` parameter in `openDb()`
- During database/output_finalize phases: if staging doesn't exist, return an error message ("Staging DB not created yet — run build_database first") instead of silently falling through
- Always include which DB was queried in the response: `"[staging]"` or `"[central]"` prefix

#### 3b. Staging file fallback sorts alphabetically
**Problem**: `finalize_meet` fallback does `.sort().reverse()` on filenames like `staging_1710000000000.db`. Alphabetical sort ≠ numeric sort for timestamps.
**Fix**: Sort by extracting the numeric timestamp: `.sort((a, b) => { ... extract numbers ... })`.

#### 3c. No orphaned staging file cleanup
**Problem**: If a session crashes, old `staging_*.db` files persist forever in the data directory.
**Fix**: On session start (or in `resetStagingDb()`), scan for and delete any `staging_*.db` files older than 24 hours.

#### 3d. Meet name is the only dedup key
**Problem**: `finalize_meet` deletes by `meet_name` before inserting. Different names for the same meet = duplicates in central.
**Fix**: Addressed by issue #5 (meet name standardization). Once names are standardized, this is solved. But also add a warning if the state+year combo already exists under a different meet name.

**Files**: `src/main/tools/db-tools.ts`, `src/main/tools/python-tools.ts`

### 4. Date formatting drops year when agent omits it [BUG]
**Problem**: `_format_date()` tries formats with year (`%B %d, %Y`) but not year-less (`%B %d`). "April 4" matches nothing → returned as-is. Tool descriptions give the agent no format guidance.
**Fix**:
- Add year-less format handlers (`%B %d`, `%b %d`, `%m/%d`) that default to the **meet year** (NOT current year — use the `year` param already passed to `generate_order_forms_pdf`)
- Pass `year` into `_format_date()` as a fallback year parameter
- Update tool definitions to specify date format: "April 4, 2026" with full month name and year
- Update workflow phase prompts to tell agent to always include year
- Update discovery phase prompt to tell agent to request dates with year from user

**Files**: `python/core/order_form_generator.py`, `src/main/tool-definitions.ts`, `src/main/workflow-phases.ts`

### 5. Meet names are not standardized [ARCHITECTURE]
**Problem**: Meet names come from whatever the user types or the agent guesses. "2025 Mississippi All Levels", "2025 Mississippi State Championship", "2025 MISSISSIPPI STATE CHAMPIONSHIPS" would all be different entries in the DB. No source metadata is stored.

**Fix — Naming Convention**:
Standardized internal format:
```
[Association] [Gender] [Sport] - [Year] [State] State Championship [Date(s)]
```
Examples:
- `USAG Women's Gymnastics - 2025 Mississippi State Championship April 4-6`
- `USAG Women's Gymnastics - 2026 Nevada State Championships March 14-16`
- `AAU Women's Gymnastics - 2025 Alabama State Championship May 2-3`

**Fix — Source Metadata in DB**:
Add a `meets` table to track source metadata:
```sql
CREATE TABLE IF NOT EXISTS meets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meet_name TEXT UNIQUE,        -- standardized internal name (the dedup key)
  source TEXT,                  -- "mso", "scorecat", "mymeetscores"
  source_id TEXT,               -- MSO meet ID, ScoreCat Algolia ID, etc.
  source_name TEXT,             -- exact name from the source ("2025 Mississippi State Championship" as MSO lists it)
  state TEXT,
  association TEXT,             -- "USAG", "AAU"
  year TEXT,
  dates TEXT,                   -- "April 4-6, 2025"
  created_at TEXT DEFAULT (datetime('now'))
);
```

**Fix — Name Generation**:
- After extraction, the agent (or tool) constructs the standardized name from known metadata
- `mso_extract` should return the canonical meet name from MSO in its response (query `lookup_meet`)
- `set_output_name` should accept structured components (association, gender, year, state) OR a pre-formatted string
- `build_database` should validate the meet name matches the convention
- `finalize_meet` should populate the `meets` table with source metadata

**Files**: `python/core/db_builder.py`, `src/main/tools/extraction-tools.ts`, `src/main/tools/python-tools.ts`, `src/main/tool-definitions.ts`, `src/main/context-tools.ts`, `src/main/workflow-phases.ts`

### 6. Add direct meet ID lookup tool [FEATURE]
**Problem**: When search_meets fails and Perplexity can't find the meet, the user may have the MSO ID bookmarked but there's no tool to accept it directly.
**Fix**: Add a `lookup_meet` tool that:
- Accepts a known source + meet ID (e.g., source="mso", id="34508")
- Calls the MSO API to verify the meet exists and fetch metadata
- Returns the canonical name, state, dates, athlete count
- Agent must know the exact ID — this is NOT a search tool

**File**: `src/main/tools/search-tools.ts`, `src/main/tool-definitions.ts`

## Acceptance Criteria

- [x] Activity log holds scroll position when user scrolls up, even as new messages arrive
- [x] `search_meets` searches the correct MSO season page based on the year in the query (e.g., 2025 → Results.All.2024-2025)
- [x] `query_db` response includes which database was queried (staging vs central)
- [x] During database phase, `query_db` errors if staging DB doesn't exist instead of silently using central
- [x] Staging file fallback sorts by numeric timestamp, not alphabetically
- [x] Old orphaned staging files are cleaned up on session start
- [x] `_format_date("April 4")` with year="2025" returns "April 4, 2025"
- [x] Tool definitions specify date format with year
- [x] Agent prompts request dates with year from user
- [x] Meets table stores source metadata (source, source_id, source_name)
- [x] Meet names follow standardized convention (prompt guidance added)
- [x] `mso_extract` returns canonical meet name from MSO API
- [x] `lookup_meet` tool accepts direct meet ID and returns metadata
- [x] `finalize_meet` warns if state+year already exists under a different name

## Implementation Priority

1. **#1 (scroll fix)** — quick win, annoying UX bug
2. **#2 (search_meets MSO season)** — verified fix, eliminates Perplexity dependency for recent meets
3. **#3a (query_db phase awareness)** — most impactful for reducing wasted iterations
4. **#3b,3c (staging sort + cleanup)** — correctness bugs
5. **#4 (date formatting)** — output quality
6. **#5 (meet name standardization + meets table)** — architecture improvement
7. **#6 (lookup_meet tool)** — nice to have
8. **#3d (dedup warning)** — depends on #5
