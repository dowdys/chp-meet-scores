---
title: PL/pgSQL ON CONFLICT with loop variables shadows column expressions
category: database-issues
date: 2026-03-27
component: supabase/migrations/004_gym_normalization.sql
severity: medium
tags: [postgresql, plpgsql, on-conflict, upsert, variable-shadowing]
---

## Problem

An `INSERT ... ON CONFLICT ... DO UPDATE` inside a PL/pgSQL `FOR` loop silently resolves column references in the `DO UPDATE SET` clause to the loop variable instead of the table column, producing incorrect upsert behavior.

## Root Cause

PL/pgSQL resolves unqualified identifiers by checking local variables first, then table columns. When a loop variable has the same name as a table column used in an `ON CONFLICT` expression, the column reference in `DO UPDATE SET` binds to the loop variable instead of the table's existing row.

Example of the trap:

```sql
CREATE OR REPLACE FUNCTION persist_aliases(p_state TEXT, p_aliases JSONB)
RETURNS JSONB AS $$
DECLARE
    alias JSONB;  -- loop variable named "alias"
BEGIN
    FOR alias IN SELECT * FROM jsonb_array_elements(p_aliases)
    LOOP
        INSERT INTO gym_aliases (state, alias, canonical)
        VALUES (p_state, alias->>'alias', alias->>'canonical')
        ON CONFLICT (state, lower(alias))  -- "alias" here resolves to the JSONB loop variable, NOT the table column
        DO UPDATE SET canonical = EXCLUDED.canonical;
    END LOOP;
END;
$$ LANGUAGE plpgsql;
```

The `lower(alias)` in the `ON CONFLICT` clause calls `lower()` on the JSONB loop variable (which fails or produces a wrong value), not on the `gym_aliases.alias` text column. PostgreSQL does not warn about this -- it either throws a type error at runtime or silently uses the wrong value.

## Solution

Prefix loop variables with `v_` to avoid any collision with column names:

```sql
DECLARE
    v_alias JSONB;  -- no collision with gym_aliases.alias column
BEGIN
    FOR v_alias IN SELECT * FROM jsonb_array_elements(p_aliases)
    LOOP
        INSERT INTO gym_aliases (state, alias, canonical)
        VALUES (p_state, v_alias->>'alias', v_alias->>'canonical')
        ON CONFLICT (state, lower(alias))  -- now unambiguously the table column
        DO UPDATE SET canonical = EXCLUDED.canonical;
    END LOOP;
END;
```

Alternatively, fully qualify the column reference as `gym_aliases.alias`, but the `v_` prefix convention is simpler and prevents the issue across all clauses.

## Prevention

1. **Always prefix PL/pgSQL local variables** with `v_` (or another prefix) to avoid shadowing table columns
2. **Be especially careful with `ON CONFLICT` index expressions** -- these reference table columns, but PL/pgSQL resolves unqualified names to local variables first
3. **Watch for silent type coercion** -- if the loop variable happens to be text-compatible, PostgreSQL may not throw an error; it just matches against the wrong value, causing the `ON CONFLICT` to miss and insert duplicates instead of upserting
4. **Test upserts with duplicate data** -- run the function twice with the same input and verify the row count stays the same (not doubling)
