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

## Running the Build
```bash
python process_meet.py --source [scorecat|mso_pdf|mso_html] --data-file [path] --db-path [path]
```
After building, always proceed to `data_quality` skill.
