# Skill: Database Building

## Overview
All extraction methods produce raw data (JSON from `mso_extract` or `scorecat_extract`) that gets normalized into a unified SQLite schema. This skill covers the schema, winner determination strategies, and key rules.

## Unified Schema
Three tables: `results`, `winners`, and `meets`. See system-prompt for full schema. The `rank` column (TEXT) stores whatever rank the source provided, but it is NOT used for winner determination — winners are always determined by max score.

## Winner Determination — Score-Based (All Sources)

All data sources use the same score-based strategy. Ranks from data sources are ignored because they may not handle ties correctly — e.g. ScoreCat often assigns sequential ranks (1, 2) to athletes who tied instead of giving both rank 1.

For each session+level+division+event:
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

This guarantees that any athletes who tied on score both become winners, regardless of how the original data source ranked them.

## Critical Rules

### Session Awareness
The same level+division can appear in multiple sessions (e.g., Level 7 Child in Session 6 AND Session 7). These are separate competitions. Always determine winners per session+level+division, never per level+division alone.

### Zero/Null Exclusion
A score of 0, 0.000, null, or empty means the athlete did not compete on that event. Never count these as valid scores, even if the source shows rank = 1.

### Tie Handling
When multiple athletes share the max score (or both have rank = 1), all are winners with is_tie = 1. Do not pick just one.

## Running the Build

Use the `build_database` tool with these parameters:

- **source**: `"generic"` for MSO data (from `mso_extract`), `"scorecat"` for ScoreCat data
- **data_path**: Path to the extracted JSON file (provided by the extraction tool output)
- **state**: Full state name (e.g., "Mississippi")
- **meet_name**: Standardized meet name
- **source_id**: The source meet ID (e.g., MSO meet ID "34508")
- **source_name**: Canonical name from the source (e.g., MSO's "2025 Mississippi State Championship")
- **meet_dates**: Meet dates (e.g., "Mar 14-16, 2025")
- **postmark_date, online_date, ship_date**: Deadline dates in "April 4, 2025" format (use meet year, NOT current year)

The `build_database` tool automatically:
- Creates the staging DB (not the central DB)
- Runs gym normalization (case merge + suffix merge + fuzzy detection)
- Determines winners (score-based, never rank-based)
- Populates the meets metadata table

**Do NOT use `run_script` to modify the database directly.** If you need to fix data, re-run `build_database` with corrected source data or a gym map.

## Normalize BEFORE Building

**Build the database exactly ONCE.** Before calling `build_database`:

1. **Divisions are consistent** — If combining data from multiple sources
2. **Gym names are normalized** — Use `--gym-map` with a JSON file mapping variants
3. **Encoding is clean** — Check for mojibake

## After Building

Proceed to `data_quality` skill for quality checks. Then advance to `output_finalize` phase for output generation.
