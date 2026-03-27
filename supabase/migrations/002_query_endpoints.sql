-- CHP Meet Scores: Query Endpoints
-- Migration 002: RPC functions for the fast query path
--
-- These are called by the query-engine in the Electron app to answer
-- common questions without LLM involvement.

-- Winners by event for a specific state/year, with optional level/event filters
CREATE OR REPLACE FUNCTION get_event_winners(
    p_state TEXT,
    p_year TEXT,
    p_level TEXT DEFAULT NULL,
    p_event TEXT DEFAULT NULL
) RETURNS TABLE (
    name TEXT, gym TEXT, level TEXT, division TEXT,
    event TEXT, score NUMERIC, is_tie BOOLEAN, meet_name TEXT
) AS $$
BEGIN
    RETURN QUERY
    SELECT w.name, w.gym, w.level, w.division,
           w.event, w.score, w.is_tie, w.meet_name
    FROM public.winners w
    JOIN public.meets m ON m.meet_name = w.meet_name
    WHERE m.state = p_state
      AND m.year = p_year
      AND (p_level IS NULL OR w.level = p_level)
      AND (p_event IS NULL OR w.event = p_event)
    ORDER BY w.level, w.event, w.score DESC;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '';

-- Meet summary stats for a state/year
CREATE OR REPLACE FUNCTION get_meet_summary(
    p_state TEXT DEFAULT NULL,
    p_year TEXT DEFAULT NULL
) RETURNS TABLE (
    meet_name TEXT, state TEXT, year TEXT,
    athlete_count INTEGER, winner_count INTEGER,
    dates TEXT, association TEXT, version INTEGER
) AS $$
BEGIN
    RETURN QUERY
    SELECT m.meet_name, m.state, m.year,
           m.athlete_count, m.winner_count,
           m.dates, m.association, m.version
    FROM public.meets m
    WHERE (p_state IS NULL OR m.state = p_state)
      AND (p_year IS NULL OR m.year = p_year)
    ORDER BY m.state, m.year DESC;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '';

-- Search athletes by name (case-insensitive partial match)
CREATE OR REPLACE FUNCTION search_athletes(
    p_name TEXT,
    p_state TEXT DEFAULT NULL,
    p_year TEXT DEFAULT NULL
) RETURNS TABLE (
    name TEXT, gym TEXT, meet_name TEXT, state TEXT,
    level TEXT, division TEXT, session TEXT,
    vault NUMERIC, bars NUMERIC, beam NUMERIC, floor NUMERIC, aa NUMERIC
) AS $$
BEGIN
    RETURN QUERY
    SELECT r.name, r.gym, r.meet_name, m.state,
           r.level, r.division, r.session,
           r.vault, r.bars, r.beam, r.floor, r.aa
    FROM public.results r
    JOIN public.meets m ON m.meet_name = r.meet_name
    WHERE r.name ILIKE '%' || p_name || '%'
      AND (p_state IS NULL OR m.state = p_state)
      AND (p_year IS NULL OR m.year = p_year)
    ORDER BY r.name, r.level
    LIMIT 100;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '';

-- Gym/team results
CREATE OR REPLACE FUNCTION get_gym_results(
    p_gym TEXT,
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
    WHERE r.gym ILIKE '%' || p_gym || '%'
      AND (p_state IS NULL OR m.state = p_state)
      AND (p_year IS NULL OR m.year = p_year)
    ORDER BY r.gym, r.level, r.name
    LIMIT 200;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '';

-- Read-only SQL execution for complex LLM-generated queries
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
    EXECUTE 'SELECT jsonb_agg(row_to_json(t)) FROM (' || p_sql || ') t'
        INTO v_result;
    RETURN COALESCE(v_result, '[]'::jsonb);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

-- Lock down all functions to authenticated users only
REVOKE EXECUTE ON FUNCTION get_event_winners FROM anon;
GRANT EXECUTE ON FUNCTION get_event_winners TO authenticated;
REVOKE EXECUTE ON FUNCTION get_meet_summary FROM anon;
GRANT EXECUTE ON FUNCTION get_meet_summary TO authenticated;
REVOKE EXECUTE ON FUNCTION search_athletes FROM anon;
GRANT EXECUTE ON FUNCTION search_athletes TO authenticated;
REVOKE EXECUTE ON FUNCTION get_gym_results FROM anon;
GRANT EXECUTE ON FUNCTION get_gym_results TO authenticated;
REVOKE EXECUTE ON FUNCTION exec_query FROM anon;
GRANT EXECUTE ON FUNCTION exec_query TO authenticated;

NOTIFY pgrst, 'reload schema';
