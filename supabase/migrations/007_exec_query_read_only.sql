-- CHP Meet Scores: exec_query read-only enforcement
-- Migration 007: Wrap exec_query EXECUTE in a read-only transaction
--
-- The existing regex guards in exec_query can be bypassed by clever SQL.
-- This migration adds SET TRANSACTION READ ONLY before the EXECUTE call so
-- Postgres enforces read-only access at the engine level, not just via pattern
-- matching.

CREATE OR REPLACE FUNCTION exec_query(p_sql TEXT)
RETURNS JSONB AS $$
DECLARE
    v_result JSONB;
BEGIN
    -- Safety: only allow SELECT statements
    IF NOT (lower(trim(p_sql)) LIKE 'select%') THEN
        RAISE EXCEPTION 'Only SELECT queries are allowed';
    END IF;
    -- Block dangerous keywords
    IF p_sql ~* '\b(insert|update|delete|drop|alter|create|truncate|grant|revoke)\b' THEN
        RAISE EXCEPTION 'Mutation queries are not allowed';
    END IF;
    -- Enforce read-only at the transaction level — Postgres will reject any
    -- write attempt regardless of how the query was crafted.
    SET TRANSACTION READ ONLY;
    EXECUTE 'SELECT jsonb_agg(row_to_json(t)) FROM (' || p_sql || ') t'
        INTO v_result;
    RETURN COALESCE(v_result, '[]'::jsonb);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

-- Permissions unchanged — authenticated only
REVOKE EXECUTE ON FUNCTION exec_query FROM anon;
GRANT EXECUTE ON FUNCTION exec_query TO authenticated;

NOTIFY pgrst, 'reload schema';
