# Skill: Database Building

## Overview
All extraction methods produce raw data (JSON, TSV, or direct from PDF parsing) that gets normalized into a unified SQLite schema. This skill covers the schema, winner determination strategies, and key rules.

## Unified Schema
Both tables (`results` and `winners`) use the same column names regardless of source. See system-prompt for full schema. Additional columns may exist per source:
- ScoreCat sources add per-event rank columns: `vault_rank`, `bars_rank`, `beam_rank`, `floor_rank`, `aa_rank` (INTEGER)
- PDF/HTML sources store the overall rank as `rank` (TEXT, may contain "T" suffix)

## Winner Determination — Two Strategies

### Strategy 1: Score-based (MSO PDF and HTML sources)
Used when rank data is unreliable or absent. For each session+level+division+event:
1. Find MAX(score) where score IS NOT NULL and score > 0
2. Select ALL athletes with that max score
3. If count > 1, set is_tie = 1

```sql
-- Example: Find vault winners for one group
SELECT name, gym, vault FROM results
WHERE session = ? AND level = ? AND division = ?
  AND vault = (SELECT MAX(vault) FROM results
               WHERE session = ? AND level = ? AND division = ?
                 AND vault IS NOT NULL AND vault > 0)
```

### Strategy 2: Rank-based (ScoreCat sources)
Used when ScoreCat provides per-event ranks. For each session+level+division+event:
1. Select athletes where event_rank = 1 AND score > 0
2. If no rank data exists, fall back to Strategy 1 (max score)
3. Count athletes with rank 1 — if > 1, set is_tie = 1

```sql
-- Example: Find vault winners using rank
SELECT name, gym, vault FROM results
WHERE session = ? AND level = ? AND division = ?
  AND vault_rank = 1
  AND vault IS NOT NULL AND vault > 0
```

## Critical Rules

### Session Awareness
The same level+division can appear in multiple sessions (e.g., Level 7 Child in Session 6 AND Session 7). These are separate competitions. Always determine winners per session+level+division, never per level+division alone.

Verify session breakdown after building:
```sql
SELECT session, level, division, COUNT(*) FROM results
GROUP BY session, level, division ORDER BY level, division, session;
```

### Zero/Null Exclusion
A score of 0, 0.000, null, or empty means the athlete did not compete on that event. Never count these as valid scores, even if the source shows rank = 1.

### Tie Handling
When multiple athletes share the max score (or both have rank = 1), all are winners with is_tie = 1. Do not pick just one.

## CRITICAL: Single-File Data Pipeline

- `run_python` replaces data per meet. Always pass ALL athlete data in a single file.
- Use `chrome_save_to_file` to extract all data to one JSON file, then pass that file to `run_python`.
- The GenericAdapter handles single files, directories, and glob patterns.
- If data must be split across files (rare), `run_python` now supports multiple `--data` paths: `--data file1.json file2.json`.

## CRITICAL: Normalize ALL Data BEFORE Building

**Build the database exactly ONCE.** Every rebuild regenerates all output files and wastes iterations. Before the first `run_python` call, verify:

1. **Divisions are consistent across sources** — If combining data from multiple platforms (MSO, ScoreCat, ScoreKing), check that division names match. Common mismatches:
   - MSO uses `"CHA"`, `"JRA"`, `"SRA"` — ScoreKing uses `"Ch A"`, `"Jr A"`, `"Sr A"`
   - ScoreCat uses `"Child A"`, `"Junior A"`, `"Senior A"`
   - **Fix these in the JSON file BEFORE building**, not after.

2. **Gym names are normalized** — Use `--gym-map` with a JSON file mapping variants to canonical names. Check for duplicates proactively by inspecting unique gym names in the combined JSON.

3. **Encoding is clean** — Open the combined JSON in a `run_script` and check for mojibake (e.g. `\u009d`, `Ã©` instead of `é`). Fix encoding issues before building.

4. **Session/Level fields are populated** — If any source leaves session or level blank, fill them in before building.

Do all normalization via `run_script` on the combined JSON file. Only call `run_python` once everything is clean.

## Running the Build

Use the `run_python` tool. **Do NOT pass --db or --output** — they are always auto-injected. Example:
```
--source generic --data /home/goduk/chp-meet-scores/data/js_result_12345.json --state Iowa --meet "2025 Iowa State Championships"
```

**--data can be**: a single file, a directory of JSON files, or a glob pattern:
```
--data /home/goduk/chp-meet-scores/data/                           # all .json files in dir
--data "/home/goduk/chp-meet-scores/data/js_result_177190*.json"   # glob pattern
--data /home/goduk/chp-meet-scores/data/js_result_12345.json       # single file
```

Source types:
- `scorecat` — ScoreCat JSON with firstName/lastName/clubName and per-event ranks
- `mso_pdf` — PDF-parsed data from MSO (15 columns)
- `mso_html` — TSV from MSO with interleaved rank columns (15 columns)
- `generic` — **Use for any JSON or TSV data**. Auto-detects format. Handles double-encoded JSON (from `chrome_execute_js` auto-save). Maps common column names (firstName, lastName, clubName, vt, ub, bb, fx, etc.).

**Prefer `generic` when data comes from a non-standard source** (MyMeetScores, ScoreCat JS results, etc.). The `generic` adapter handles JSON arrays with any column names.

After building, always proceed to `data_quality` skill.
