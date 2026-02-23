# Skill: Data Quality Checks

## Overview
Run this checklist after building the database and before generating outputs. Each check includes the SQL query to run and what to do if issues are found.

## Check 1: Duplicate Athletes
Same athlete appearing multiple times in the same session+level+division.
```sql
SELECT name, gym, session, level, division, COUNT(*) as cnt
FROM results
GROUP BY name, gym, session, level, division
HAVING cnt > 1;
```
**Fix**: Investigate whether these are true duplicates (delete extras) or different athletes with the same name (keep both, note in gym).

## Check 2: Case Normalization
Inconsistent capitalization of names or gyms across records.
```sql
SELECT name, COUNT(DISTINCT gym) as gym_count
FROM results GROUP BY LOWER(name) HAVING gym_count > 1;
```
**Fix**: Standardize to consistent title-case. Update both `results` and `winners` tables.

## Check 3: Split Name Detection (PDF sources only)
Gyms with only 1 athlete are likely PDF name-wrapping artifacts where the second line of a long name was mistakenly parsed as the gym.
```sql
SELECT gym, COUNT(*) as cnt FROM results GROUP BY gym HAVING cnt = 1;
```
**Fix**: For each suspicious entry, look up the actual PDF page to find the correct full name and real gym:
```sql
UPDATE results SET name = 'Full Name', gym = 'Real Gym'
WHERE name = 'Partial' AND gym = 'NameFragment';
```
Then rebuild the winners table.

## Check 4: Gym Name Variants
Similar gym names that should be merged (e.g., "ARK WinGS" vs "ARK WinGs").
```sql
SELECT DISTINCT gym FROM results ORDER BY gym;
```
**Fix**: Review the list visually. Standardize to one name:
```sql
UPDATE results SET gym = 'Standard Name' WHERE gym = 'Variant Name';
UPDATE winners SET gym = 'Standard Name' WHERE gym = 'Variant Name';
```

## Check 5: Score Range Validation
Individual event scores should be 0-10, AA should be 0-40.
```sql
SELECT name, gym, level, vault, bars, beam, floor, aa
FROM results
WHERE vault > 10 OR bars > 10 OR beam > 10 OR floor > 10
   OR aa > 40
   OR (vault < 0 OR bars < 0 OR beam < 0 OR floor < 0 OR aa < 0);
```
**Fix**: Investigate source data — likely a parsing error. Correct or remove the bad scores.

## Check 6: Session Consistency
Verify session+level+division groupings make sense. Same level+division in multiple sessions means separate competitions.
```sql
SELECT session, level, division, COUNT(*) as athletes
FROM results
GROUP BY session, level, division
ORDER BY level, division, session;
```
**Action**: Confirm with user if level+division appearing in multiple sessions is expected. Ensure winners are determined per-session.

## Check 7: Missing Scores
Athletes with some events scored and others null (may indicate partial competitor or parsing error).
```sql
SELECT name, gym, level, division,
  CASE WHEN vault IS NULL THEN 'X' ELSE '' END ||
  CASE WHEN bars IS NULL THEN 'X' ELSE '' END ||
  CASE WHEN beam IS NULL THEN 'X' ELSE '' END ||
  CASE WHEN floor IS NULL THEN 'X' ELSE '' END as missing
FROM results
WHERE (vault IS NULL OR bars IS NULL OR beam IS NULL OR floor IS NULL)
  AND NOT (vault IS NULL AND bars IS NULL AND beam IS NULL AND floor IS NULL);
```
**Action**: Partial competitors are legitimate in some meets (especially ScoreCat data where event notes indicate which events they competed in). Verify against source data.

## Check 8: Winner Sanity
Every session+level+division should have at least one winner per event (unless no one competed in that event).
```sql
SELECT r.session, r.level, r.division, 'vault' as event
FROM (SELECT DISTINCT session, level, division FROM results) r
LEFT JOIN winners w ON r.session = w.session AND r.level = w.level
  AND r.division = w.division AND w.event = 'vault'
WHERE w.id IS NULL
UNION ALL
-- Repeat for bars, beam, floor, aa
SELECT r.session, r.level, r.division, 'bars'
FROM (SELECT DISTINCT session, level, division FROM results) r
LEFT JOIN winners w ON r.session = w.session AND r.level = w.level
  AND r.division = w.division AND w.event = 'bars'
WHERE w.id IS NULL;
```
**Action**: Missing winners for an event means no one had a valid score > 0 for that event in that group. This is unusual — verify against source.

## Run Order
Run checks 1-5 first, fix any issues, rebuild winners, then run checks 6-8. After all checks pass, proceed to `output_generation` skill.
