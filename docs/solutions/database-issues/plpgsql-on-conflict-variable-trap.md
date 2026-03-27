---
title: "PL/pgSQL ON CONFLICT must reference column expressions, not loop variables"
category: database-issues
date: 2026-03-27
tags: [postgresql, plpgsql, supabase, upsert, on-conflict]
modules: [supabase/migrations]
---

## Problem

When writing an upsert inside a PL/pgSQL function that loops over a JSONB array, the `ON CONFLICT` clause silently fails to match the unique index if it references the JSONB loop variable instead of the table column.

## Symptom

Duplicate rows inserted instead of upserted. No error raised — the `ON CONFLICT` clause compiles and executes, but never triggers because PostgreSQL can't match the expression to the unique index.

## Root Cause

Given a unique index:
```sql
CREATE UNIQUE INDEX idx_gym_aliases_unique ON gym_aliases(state, lower(alias));
```

And a PL/pgSQL loop inserting from a JSONB variable:
```sql
FOR v_alias IN SELECT * FROM jsonb_array_elements(p_aliases)
LOOP
    INSERT INTO gym_aliases (state, alias, canonical)
    VALUES (p_state, v_alias->>'alias', v_alias->>'canonical')
    -- WRONG: references the JSONB variable, not the table column
    ON CONFLICT (state, lower((v_alias->>'alias')))
    DO UPDATE SET canonical = EXCLUDED.canonical;
END LOOP;
```

PostgreSQL matches `ON CONFLICT` targets against index definitions using the **table column expressions**. `lower((v_alias->>'alias'))` is a JSONB extraction — it's not the same expression as `lower(alias)` even though they produce the same value. PostgreSQL sees no matching index and skips the conflict check entirely.

## Solution

Reference the **table column** in `ON CONFLICT`, not the loop variable:

```sql
ON CONFLICT (state, lower(alias))  -- matches the unique index expression
DO UPDATE SET canonical = EXCLUDED.canonical;
```

The `INSERT ... VALUES` clause already sets `alias = v_alias->>'alias'`, so `lower(alias)` evaluates correctly for conflict detection.

## Prevention

When writing `ON CONFLICT` in PL/pgSQL:
1. Copy the exact expression from the unique index definition
2. Never use PL/pgSQL variables or function parameters in the `ON CONFLICT` target
3. Test upserts by inserting the same data twice and verifying only one row exists
