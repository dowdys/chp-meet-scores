---
title: "feat: Query Architecture Overhaul, Name Cleanup, and Cloud Improvements"
type: feat
status: active
date: 2026-03-27
origin: docs/plans/2026-03-26-003-fix-meet-name-normalization-and-cloud-cleanup-plan.md
---

# feat: Query Architecture Overhaul, Name Cleanup, and Cloud Improvements

## Overview

Combined plan addressing three related systems: (1) rebuilding the Query Results tab to be fast and query Supabase directly, (2) deterministic meet name normalization to prevent duplicates in the central database, and (3) a robust athlete name cleanup function that handles all event code formats across data sources.

## Part 1: Query Results Tab Overhaul

### Problem

The Query Results tab currently sends every question through the full LLM agent loop (same model used for meet processing), which takes 5-15 seconds per question. It only queries local SQLite, missing data from other installations. It needs to be fast, query the central Supabase database, and cost almost nothing.

### Architecture: LLM Router + Supabase RPC Endpoints

```
User asks question
  ├── Keyword Matcher (instant, ~5ms, free)
  │   Detects: won/winner/best → WINNERS | athletes/how many → SUMMARY |
  │            search/find [name] → ATHLETE | list/what meets → MEET_LIST |
  │            gym/team → GYM_RESULTS
  │
  ├── If keyword match found → Supabase RPC (fast path)
  │   ├── get_event_winners(state, year, level, event) → formatted answer
  │   ├── get_meet_summary(state, year) → formatted answer
  │   ├── search_athletes(name, state?, year?) → formatted answer
  │   ├── list_meets(year?) → formatted answer
  │   └── get_gym_results(gym_name, state, year) → formatted answer
  │   Total: ~200ms (5ms match + 200ms RPC)
  │
  ├── If no keyword match → LLM Router (Mistral Small 3.1, ~300ms)
  │   Classifies into RPC category or COMPLEX
  │   Falls back to Gemini 2.5 Flash-Lite if Mistral fails
  │   → Routes to RPC endpoint or SQL generation
  │   Total: ~500ms (300ms router + 200ms RPC)
  │
  └── COMPLEX questions → LLM SQL Generation (MiniMax M2.7)
      ├── Send schema + question, get SQL back (single-shot)
      ├── Execute SQL against Supabase via supabase.rpc('exec_query', {sql})
      ├── Format answer with same model
      └── Total: ~2-3s
```

**Model Stack:**
- **Keyword matcher**: No LLM, instant, free. Handles ~70% of questions.
- **LLM Router**: Mistral Small 3.1 ($0.01/1K queries, ~300ms). Fallback: Gemini 2.5 Flash-Lite.
- **Complex SQL**: MiniMax M2.7 ($0.36/$1.44 per 1M tokens). Same model used for main meet processing -- proven capable.

### Supabase RPC Functions

```sql
-- Fast endpoint: winners by event for a specific level/state/year
CREATE OR REPLACE FUNCTION get_event_winners(
    p_state TEXT,
    p_year TEXT,
    p_level TEXT DEFAULT NULL,
    p_event TEXT DEFAULT NULL
) RETURNS TABLE (
    name TEXT, gym TEXT, level TEXT, division TEXT,
    event TEXT, score NUMERIC, is_tie BOOLEAN
) AS $$
BEGIN
    RETURN QUERY
    SELECT w.name, w.gym, w.level, w.division,
           w.event, w.score, w.is_tie
    FROM public.winners w
    JOIN public.meets m ON m.meet_name = w.meet_name
    WHERE m.state = p_state
      AND m.year = p_year
      AND (p_level IS NULL OR w.level = p_level)
      AND (p_event IS NULL OR w.event = p_event)
    ORDER BY w.level, w.event, w.score DESC;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '';

-- Fast endpoint: meet summary stats
CREATE OR REPLACE FUNCTION get_meet_summary(
    p_state TEXT,
    p_year TEXT
) RETURNS TABLE (
    meet_name TEXT, state TEXT, year TEXT,
    athlete_count INTEGER, winner_count INTEGER,
    dates TEXT, association TEXT
) AS $$
BEGIN
    RETURN QUERY
    SELECT m.meet_name, m.state, m.year,
           m.athlete_count, m.winner_count,
           m.dates, m.association
    FROM public.meets m
    WHERE m.state = p_state AND m.year = p_year;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '';

-- Fast endpoint: search athletes by name
CREATE OR REPLACE FUNCTION search_athletes(
    p_name TEXT,
    p_state TEXT DEFAULT NULL,
    p_year TEXT DEFAULT NULL
) RETURNS TABLE (
    name TEXT, gym TEXT, meet_name TEXT, state TEXT,
    level TEXT, division TEXT,
    vault NUMERIC, bars NUMERIC, beam NUMERIC, floor NUMERIC, aa NUMERIC
) AS $$
BEGIN
    RETURN QUERY
    SELECT r.name, r.gym, r.meet_name, m.state,
           r.level, r.division,
           r.vault, r.bars, r.beam, r.floor, r.aa
    FROM public.results r
    JOIN public.meets m ON m.meet_name = r.meet_name
    WHERE r.name ILIKE '%' || p_name || '%'
      AND (p_state IS NULL OR m.state = p_state)
      AND (p_year IS NULL OR m.year = p_year)
    ORDER BY r.name, r.level;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '';

-- Read-only SQL execution for complex queries (LLM fallback)
CREATE OR REPLACE FUNCTION exec_query(p_sql TEXT)
RETURNS JSONB AS $$
DECLARE
    v_result JSONB;
BEGIN
    -- Safety: only allow SELECT statements
    IF NOT (lower(trim(p_sql)) LIKE 'select%') THEN
        RAISE EXCEPTION 'Only SELECT queries are allowed';
    END IF;
    EXECUTE 'SELECT jsonb_agg(row_to_json(t)) FROM (' || p_sql || ') t'
        INTO v_result;
    RETURN COALESCE(v_result, '[]'::jsonb);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

-- Lock down all functions
REVOKE EXECUTE ON FUNCTION get_event_winners FROM anon;
GRANT EXECUTE ON FUNCTION get_event_winners TO authenticated;
REVOKE EXECUTE ON FUNCTION get_meet_summary FROM anon;
GRANT EXECUTE ON FUNCTION get_meet_summary TO authenticated;
REVOKE EXECUTE ON FUNCTION search_athletes FROM anon;
GRANT EXECUTE ON FUNCTION search_athletes TO authenticated;
REVOKE EXECUTE ON FUNCTION exec_query FROM anon;
GRANT EXECUTE ON FUNCTION exec_query TO authenticated;
```

### Query Model Selection

Add a separate model selector in Settings for the Query tab:

**Router models** (used when keyword matcher can't classify):
- Mistral Small 3.1 ($0.01/1K queries, ~300ms) -- **default router**
- Gemini 2.5 Flash-Lite ($0.04/1K queries, ~200ms) -- fallback if Mistral fails

**Complex query models** (used for SQL generation on unusual questions):
- MiniMax M2.7 ($0.36/$1.44, ~2s) -- **default**, same model as main processing
- GPT-4.1-mini ($0.40/$1.60, ~1.3s) -- alternative if MiniMax is slow/down

Most questions never hit an LLM at all (keyword matcher → RPC → done).

### Settings UI Changes

Add to Settings tab:
```
Complex Query Model (used for unusual questions only — most queries are instant)
[MiniMax M2.7 (Recommended)] ▼
  MiniMax M2.7 — same as main processing, $0.36/$1.44
  GPT-4.1-mini — best SQL accuracy, $0.40/$1.60
```

Config fields: `queryModel` (string, OpenRouter model ID, default 'minimax/minimax-m2.7')

### Implementation Files

| File | Change |
|------|--------|
| `src/main/query-engine.ts` | NEW -- router + RPC caller + LLM SQL fallback |
| `src/main/agent-loop.ts` | Refactor `queryResults()` to use query-engine instead of agent loop |
| `src/main/config-store.ts` | Add `queryModel`, `queryProvider` fields |
| `src/shared/types.ts` | Add settings fields |
| `src/renderer/components/SettingsTab.tsx` | Add query model dropdown |
| `supabase/migrations/002_query_endpoints.sql` | NEW -- RPC functions |

### Acceptance Criteria

- [ ] Common questions (event winners, meet summary, athlete search) answered in under 500ms
- [ ] Complex questions answered in under 2 seconds
- [ ] All queries hit Supabase, not local SQLite
- [ ] Separate model selector for query tab in Settings
- [ ] Default model: Gemini 2.5 Flash-Lite
- [ ] `exec_query` RPC only allows SELECT statements (no mutations)

---

## Part 2: Meet Name Normalization

### Problem

The centralized Supabase database keys on `meet_name`. If the agent produces inconsistent names for the same championship, the system creates duplicates. Only 1 of 6 published meets followed the canonical format.

### Canonical Format

Defined at `workflow-phases.ts:99-106`:
```
[Association] [Gender Initial] [Sport] - [Year] [State Abbrev] - [Date(s)]
```
Examples:
- `USAG W Gymnastics - 2026 KY - March 14-16`
- `AAU W Gymnastics - 2025 AL - May 2-3`
- `USAG M Gymnastics - 2026 TX - April 5-7`

### Solution: `normalizeMeetName()` Function

```typescript
// src/main/meet-naming.ts

const STATE_NAMES: Record<string, string> = {
  'alabama': 'AL', 'alaska': 'AK', /* ... all 50 states ... */
  'minnesota': 'MN', 'mississippi': 'MS', 'missouri': 'MO',
  'nebraska': 'NE', 'nevada': 'NV', /* ... */
};

interface MeetIdentity {
  association: string;   // 'USAG', 'AAU'
  gender: string;        // 'W' or 'M'
  sport: string;         // 'Gymnastics'
  year: string;          // '2026'
  state: string;         // 'MN' or 'Minnesota' (will be normalized)
  dates?: string;        // 'March 14-16' (optional)
}

export function normalizeMeetName(identity: MeetIdentity): string {
  const stateAbbrev = identity.state.length === 2
    ? identity.state.toUpperCase()
    : STATE_NAMES[identity.state.toLowerCase()] || identity.state.toUpperCase();

  const genderInitial = identity.gender.startsWith('W') ? 'W'
    : identity.gender.startsWith('M') ? 'M' : 'W';

  const base = `${identity.association} ${genderInitial} ${identity.sport} - ${identity.year} ${stateAbbrev}`;

  if (identity.dates) {
    // Strip trailing year from dates (e.g., "March 20, 2026" -> "March 20")
    const cleanDates = identity.dates.replace(/,?\s*\d{4}$/, '').trim();
    return `${base} - ${cleanDates}`;
  }
  return base;
}

export function normalizeState(input: string): string {
  if (input.length === 2) return input.toUpperCase();
  return STATE_NAMES[input.toLowerCase()] || input.toUpperCase();
}
```

### Enforcement Points

| Location | Action |
|---|---|
| `set_output_name` tool | Normalize before storing as `context.outputName` |
| `publishMeet()` in supabase-sync.ts | Normalize before RPC call (defense-in-depth) |
| `finalize_meet` | Validate meetName matches context.outputName |
| `import_pdf_backs` | Already auto-corrects to context.outputName (line 366-368) |

### Storage Blob Cleanup

Before uploading new files in `uploadMeetFiles()`:
```typescript
// List existing blobs, delete any not in the new upload set
const { data: existingFiles } = await supabase.storage
  .from('meet-documents').list(storagePath);
if (existingFiles?.length) {
  const newFilenames = new Set(filesToUpload);
  const orphaned = existingFiles
    .filter(f => !newFilenames.has(f.name))
    .map(f => `${storagePath}/${f.name}`);
  if (orphaned.length > 0) {
    await supabase.storage.from('meet-documents').remove(orphaned);
  }
}
```

### Implementation Files

| File | Change |
|------|--------|
| `src/main/meet-naming.ts` | NEW -- normalizeMeetName(), normalizeState(), STATE_NAMES |
| `src/main/supabase-sync.ts` | Import and use normalizeMeetName() before publish |
| `src/main/context-tools.ts` | Normalize in set_output_name |
| `src/main/supabase-sync.ts` | Add blob cleanup to uploadMeetFiles() |

### Acceptance Criteria

- [ ] `normalizeMeetName()` produces canonical format from structured fields
- [ ] Full state name "Minnesota" -> "MN" abbreviation lookup
- [ ] Date cleanup strips trailing year
- [ ] `set_output_name` normalizes before storing
- [ ] `publishMeet()` normalizes before RPC (defense-in-depth)
- [ ] Orphaned storage blobs cleaned up on re-publish
- [ ] Re-publishing same state+year overwrites, never duplicates

---

## Part 3: Athlete Name Cleanup

### Problem

5 different name cleaning functions scattered across 5 files. All assume a space before event codes, but real data has attached codes (`PrevendarVT,BB,FX`), double asterisks (`Sofia Autin ** BB, FX`), trailing commas (`Bella Estrada VT,`), and other variants. Each state/source does it differently.

### Solution: One Canonical Function

Replace all scattered cleanup with a single `clean_athlete_name()` in `db_builder.py` that handles every known variant:

```python
# All known event code tokens (case-insensitive matching)
_EVENT_CODES = {'V', 'VT', 'UB', 'BB', 'FX', 'BE', 'FL', 'AA'}

# Single unified pattern that handles ALL known formats:
# 1. ** or * prefix: "Name **V/BB/FX", "Name *(V,BB)"
# 2. Parenthetical: "Name *(V,BB,FX)", "Name (VT)"
# 3. Dash-prefixed: "Name - VT, FX", "Holder- BB, FX"
# 4. Space-separated: "Name VT BB FX", "Name VT,BB,FX"
# 5. Attached codes: "PrevendarVT,BB,FX" (no space)
# 6. IES prefix: "Name IES VT,BB"
# 7. Trailing separators: "Name VT,", "Name V/"

def clean_athlete_name(name: str) -> str:
    if not name:
        return name

    original = name

    # Step 1: Handle parenthetical patterns (with optional * prefix)
    # "Kelly*(V,BB,FX)" or "Name (VT)"
    name = re.sub(r'\s*\*{0,2}\s*\([^)]*\)\s*$', '', name)

    # Step 2: Handle ** or * followed by event codes with any separators
    # "Name **V/BB/FX", "Name *UB/", "Name ** BB, FX"
    name = re.sub(
        r'\s*\*{1,2}\s*(?:IES\s+)?'
        r'(?:V|VT|UB|BB|FX|Be|Fl|Fx|AA)'
        r'(?:[/,\s]+(?:V|VT|UB|BB|FX|Be|Fl|Fx|AA))*'
        r'[/,\s]*$', '', name, flags=re.IGNORECASE)

    # Step 3: Handle remaining lone ** or *
    name = re.sub(r'\s*\*{1,2}\s*$', '', name)

    # Step 4: Handle dash-prefixed event codes
    # "Holder- BB, FX", "Name - VT, FX"
    name = re.sub(
        r'\s*-\s*(?:V|VT|UB|BB|FX|Be|Fl|Fx|AA)'
        r'(?:[,\s]+(?:V|VT|UB|BB|FX|Be|Fl|Fx|AA))*'
        r'[,\s]*$', '', name, flags=re.IGNORECASE)

    # Step 5: Handle IES prefix + codes
    # "Name IES VT,BB"
    name = re.sub(
        r'\s+IES\s+'
        r'(?:V|VT|UB|BB|FX|Be|Fl|Fx|AA)'
        r'(?:[,\s]+(?:V|VT|UB|BB|FX|Be|Fl|Fx|AA))*'
        r'[,\s]*$', '', name, flags=re.IGNORECASE)

    # Step 6: Handle space-separated or comma-separated event codes at end
    # "Name VT,BB,FX", "Name VT BB FX", "Name VT,"
    name = re.sub(
        r'\s+(?:V|VT|UB|BB|FX|Be|Fl|Fx|AA)'
        r'(?:[,/\s]+(?:V|VT|UB|BB|FX|Be|Fl|Fx|AA))*'
        r'[,/\s]*$', '', name, flags=re.IGNORECASE)

    # Step 7: Handle ATTACHED codes (no space) - the hardest case
    # "PrevendarVT,BB,FX" -> detect where lowercase->uppercase boundary is
    # followed by a known event code
    name = re.sub(
        r'(?<=[a-z])(?=(?:VT|UB|BB|FX|AA)(?:[,/\s]|$))'
        r'(?:VT|UB|BB|FX|AA)'
        r'(?:[,/\s]+(?:V|VT|UB|BB|FX|Be|Fl|Fx|AA))*'
        r'[,/\s]*$', '', name, flags=re.IGNORECASE)

    return name.strip()
```

### Key Design Decisions

1. **One function, not five.** Applied at data entry time in `db_builder.py`. All other cleanup functions become pass-throughs or are removed.
2. **Ordered from most specific to least specific.** Parenthetical patterns first (unambiguous), attached codes last (most likely to have false positives).
3. **Case-insensitive.** States use different casing conventions.
4. **The attached-code detection** uses a lowercase→uppercase boundary heuristic: if a lowercase letter is immediately followed by an uppercase event code like `VT`, `BB`, etc., that's the boundary. This won't fire on names like "Victoria" because `V` alone at end-of-string isn't matched in this step (only in the space-separated step 6 where there IS a space).

### Post-Cleanup Validation

After cleanup, `flag_suspicious_name()` catches failures:
- Single word only (first or last name missing)
- Contains remaining uppercase 2-3 char tokens that look like event codes
- Unreasonably short (< 3 chars) or long (> 60 chars)

### Implementation Files

| File | Change |
|------|--------|
| `python/core/db_builder.py` | Rewrite `clean_athlete_name()` with unified function |
| `python/core/layout_engine.py` | Simplify `clean_name_for_shirt()` to rely on db_builder cleanup |
| `python/adapters/scorecat_adapter.py` | Remove `_clean_last_name()`, rely on db_builder |
| `python/adapters/generic_adapter.py` | Remove inline regex, rely on db_builder |

### Acceptance Criteria

- [ ] All known name formats cleaned correctly (see test cases below)
- [ ] `PrevendarVT,BB,FX` → `Prevendar` (attached codes)
- [ ] `Sofia Autin ** BB, FX` → `Sofia Autin` (double asterisk)
- [ ] `Kelly*(V,BB,FX)` → `Kelly` (asterisk + parens)
- [ ] `Holder- BB, FX` → `Holder` (dash prefix)
- [ ] `Bella Estrada VT,` → `Bella Estrada` (trailing comma)
- [ ] `Addie Wolff **V/BB/FX` → `Addie Wolff` (double asterisk + slashes)
- [ ] `Jane Smith` → `Jane Smith` (no event codes, unchanged)
- [ ] `Victoria Banks` → `Victoria Banks` (name contains "V" but no false positive)
- [ ] One canonical function in db_builder.py, all others simplified or removed

---

## Implementation Order

**Phase 1: Name Cleanup** (smallest scope, highest data quality impact)
- Rewrite `clean_athlete_name()` in db_builder.py
- Test against all known format variants
- Simplify downstream cleanup functions

**Phase 2: Meet Name Normalization** (prevents duplicate meets)
- Create `meet-naming.ts` with normalizeMeetName()
- Integrate at set_output_name and publishMeet()
- Add storage blob cleanup

**Phase 3: Query Architecture** (biggest scope, highest user impact)
- Create Supabase RPC query endpoints (migration SQL)
- Build query-engine.ts with router + RPC + LLM fallback
- Add query model selector to Settings
- Refactor queryResults() to use new engine

## Sources

- Canonical naming format: `src/main/workflow-phases.ts:99-106`
- Current name cleanup: `python/core/db_builder.py:34`, `python/core/layout_engine.py:359`
- Learning: `docs/solutions/logic-errors/output-name-meet-name-must-match.md`
- Model benchmarks: erincon01 Text-to-SQL (20 LLMs), Artificial Analysis latency data
- Supabase RPC docs: https://supabase.com/docs/guides/database/functions
