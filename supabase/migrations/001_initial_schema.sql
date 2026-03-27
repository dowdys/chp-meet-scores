-- CHP Meet Scores: Centralized Supabase Database
-- Migration 001: Initial schema
--
-- Schema mirrors local SQLite with PostgreSQL improvements:
--   - NUMERIC(5,3) for exact score precision (not REAL/float)
--   - gym NOT NULL DEFAULT '' to prevent NULL uniqueness issues
--   - athlete_count/winner_count on meets for efficient listing
--   - TIMESTAMPTZ for timestamps
--   - ON DELETE CASCADE + ON UPDATE CASCADE on all FKs
--   - SECURITY DEFINER RPC with SET search_path for safety
--
-- Run this in the Supabase SQL Editor after creating your project.
-- IMPORTANT: Also create the 'meet-documents' storage bucket via Dashboard.

-- ============================================================
-- TABLES
-- ============================================================

CREATE TABLE meets (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    meet_name TEXT UNIQUE NOT NULL,
    source TEXT,
    source_id TEXT,
    source_name TEXT,
    state TEXT NOT NULL,
    association TEXT,
    year TEXT NOT NULL,
    dates TEXT,
    version INTEGER DEFAULT 1,
    athlete_count INTEGER DEFAULT 0,
    winner_count INTEGER DEFAULT 0,
    published_at TIMESTAMPTZ DEFAULT NOW(),
    published_by TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE results (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    state TEXT NOT NULL,
    meet_name TEXT NOT NULL REFERENCES meets(meet_name) ON DELETE CASCADE ON UPDATE CASCADE,
    association TEXT,
    name TEXT NOT NULL,
    gym TEXT NOT NULL DEFAULT '',
    session TEXT NOT NULL,
    level TEXT NOT NULL,
    division TEXT NOT NULL,
    vault NUMERIC(5,3),
    bars NUMERIC(5,3),
    beam NUMERIC(5,3),
    floor NUMERIC(5,3),
    aa NUMERIC(6,3),
    rank TEXT,
    num TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_results_unique
    ON results(meet_name, name, gym, session, level, division);

CREATE INDEX idx_results_meet_sld
    ON results(meet_name, session, level, division);

CREATE TABLE winners (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    state TEXT NOT NULL,
    meet_name TEXT NOT NULL REFERENCES meets(meet_name) ON DELETE CASCADE ON UPDATE CASCADE,
    association TEXT,
    name TEXT NOT NULL,
    gym TEXT NOT NULL DEFAULT '',
    session TEXT NOT NULL,
    level TEXT NOT NULL,
    division TEXT NOT NULL,
    event TEXT NOT NULL,
    score NUMERIC(6,3) NOT NULL,
    is_tie BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_winners_unique
    ON winners(meet_name, name, gym, session, level, division, event);

CREATE INDEX idx_winners_meet_event_level
    ON winners(meet_name, event, level);

CREATE TABLE meet_files (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    meet_name TEXT NOT NULL REFERENCES meets(meet_name) ON DELETE CASCADE ON UPDATE CASCADE,
    filename TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    file_size BIGINT,
    uploaded_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_meet_files_unique
    ON meet_files(meet_name, filename);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE meets ENABLE ROW LEVEL SECURITY;
ALTER TABLE results ENABLE ROW LEVEL SECURITY;
ALTER TABLE winners ENABLE ROW LEVEL SECURITY;
ALTER TABLE meet_files ENABLE ROW LEVEL SECURITY;

-- Use (SELECT auth.role()) subselect for per-query caching (not per-row evaluation)
CREATE POLICY "Authenticated read" ON meets
    FOR SELECT USING ((SELECT auth.role()) = 'authenticated');
CREATE POLICY "Authenticated insert" ON meets
    FOR INSERT WITH CHECK ((SELECT auth.role()) = 'authenticated');
CREATE POLICY "Authenticated update" ON meets
    FOR UPDATE USING ((SELECT auth.role()) = 'authenticated')
    WITH CHECK ((SELECT auth.role()) = 'authenticated');

CREATE POLICY "Authenticated read" ON results
    FOR SELECT USING ((SELECT auth.role()) = 'authenticated');
CREATE POLICY "Authenticated insert" ON results
    FOR INSERT WITH CHECK ((SELECT auth.role()) = 'authenticated');

CREATE POLICY "Authenticated read" ON winners
    FOR SELECT USING ((SELECT auth.role()) = 'authenticated');
CREATE POLICY "Authenticated insert" ON winners
    FOR INSERT WITH CHECK ((SELECT auth.role()) = 'authenticated');

CREATE POLICY "Authenticated read" ON meet_files
    FOR SELECT USING ((SELECT auth.role()) = 'authenticated');
CREATE POLICY "Authenticated insert" ON meet_files
    FOR INSERT WITH CHECK ((SELECT auth.role()) = 'authenticated');
CREATE POLICY "Authenticated update" ON meet_files
    FOR UPDATE USING ((SELECT auth.role()) = 'authenticated')
    WITH CHECK ((SELECT auth.role()) = 'authenticated');

-- Storage bucket policies (REQUIRED or upsert fails silently after first upload)
-- NOTE: Create the 'meet-documents' bucket as PRIVATE in the Storage dashboard first.
CREATE POLICY "Authenticated can upload" ON storage.objects
    FOR INSERT WITH CHECK (bucket_id = 'meet-documents' AND (SELECT auth.role()) = 'authenticated');
CREATE POLICY "Authenticated can read" ON storage.objects
    FOR SELECT USING (bucket_id = 'meet-documents' AND (SELECT auth.role()) = 'authenticated');
CREATE POLICY "Authenticated can update" ON storage.objects
    FOR UPDATE USING (bucket_id = 'meet-documents' AND (SELECT auth.role()) = 'authenticated');

-- ============================================================
-- RPC: ATOMIC PUBLISH
-- ============================================================
-- Publishes a complete meet (data + metadata) in a single transaction.
-- Uses SECURITY DEFINER to bypass RLS for the delete-then-insert pattern.
-- SET search_path = '' prevents search path injection attacks.
-- All table references are fully qualified with public. schema prefix.

CREATE OR REPLACE FUNCTION publish_meet(
    p_meet JSONB,
    p_results JSONB,
    p_winners JSONB
) RETURNS JSONB AS $$
DECLARE
    v_existing_version INTEGER;
    v_result JSONB;
BEGIN
    -- Validate inputs
    IF p_meet->>'meet_name' IS NULL OR length(p_meet->>'meet_name') = 0 THEN
        RAISE EXCEPTION 'meet_name is required';
    END IF;
    IF p_meet->>'state' IS NULL OR length(p_meet->>'state') < 2 THEN
        RAISE EXCEPTION 'valid state is required';
    END IF;
    IF jsonb_array_length(p_results) > 5000 THEN
        RAISE EXCEPTION 'results array exceeds maximum size of 5000';
    END IF;
    IF jsonb_array_length(p_winners) > 2000 THEN
        RAISE EXCEPTION 'winners array exceeds maximum size of 2000';
    END IF;

    -- Lock existing row to serialize concurrent publishes of the same meet
    SELECT version INTO v_existing_version
    FROM public.meets WHERE meet_name = (p_meet->>'meet_name')
    FOR UPDATE;

    -- Delete existing data (CASCADE handles results, winners, files)
    DELETE FROM public.meets WHERE meet_name = (p_meet->>'meet_name');

    -- Insert meet metadata with bumped version
    INSERT INTO public.meets (
        meet_name, source, source_id, source_name, state,
        association, year, dates, version, published_by,
        athlete_count, winner_count
    )
    VALUES (
        p_meet->>'meet_name',
        p_meet->>'source',
        p_meet->>'source_id',
        p_meet->>'source_name',
        p_meet->>'state',
        p_meet->>'association',
        p_meet->>'year',
        p_meet->>'dates',
        COALESCE(v_existing_version, 0) + 1,
        p_meet->>'published_by',
        jsonb_array_length(p_results),
        jsonb_array_length(p_winners)
    );

    -- Insert results (COALESCE gym to '' for NOT NULL constraint)
    INSERT INTO public.results (
        state, meet_name, association, name, gym,
        session, level, division, vault, bars, beam, floor, aa, rank, num
    )
    SELECT
        r->>'state',
        r->>'meet_name',
        r->>'association',
        r->>'name',
        COALESCE(r->>'gym', ''),
        r->>'session',
        r->>'level',
        r->>'division',
        CASE WHEN r->>'vault' IS NOT NULL THEN (r->>'vault')::NUMERIC(5,3) END,
        CASE WHEN r->>'bars' IS NOT NULL THEN (r->>'bars')::NUMERIC(5,3) END,
        CASE WHEN r->>'beam' IS NOT NULL THEN (r->>'beam')::NUMERIC(5,3) END,
        CASE WHEN r->>'floor' IS NOT NULL THEN (r->>'floor')::NUMERIC(5,3) END,
        CASE WHEN r->>'aa' IS NOT NULL THEN (r->>'aa')::NUMERIC(6,3) END,
        r->>'rank',
        r->>'num'
    FROM jsonb_array_elements(p_results) AS r;

    -- Insert winners
    INSERT INTO public.winners (
        state, meet_name, association, name, gym,
        session, level, division, event, score, is_tie
    )
    SELECT
        w->>'state',
        w->>'meet_name',
        w->>'association',
        w->>'name',
        COALESCE(w->>'gym', ''),
        w->>'session',
        w->>'level',
        w->>'division',
        w->>'event',
        (w->>'score')::NUMERIC(6,3),
        COALESCE((w->>'is_tie')::BOOLEAN, FALSE)
    FROM jsonb_array_elements(p_winners) AS w;

    v_result := jsonb_build_object(
        'meet_name', p_meet->>'meet_name',
        'version', COALESCE(v_existing_version, 0) + 1,
        'results_count', jsonb_array_length(p_results),
        'winners_count', jsonb_array_length(p_winners)
    );

    RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

-- Lock down RPC execution to authenticated users only
REVOKE EXECUTE ON FUNCTION publish_meet FROM anon;
GRANT EXECUTE ON FUNCTION publish_meet TO authenticated;

-- ============================================================
-- ENABLE ANONYMOUS SIGN-INS
-- ============================================================
-- NOTE: You must also enable "Allow anonymous sign-ins" in the
-- Supabase Dashboard under Authentication > Settings > User Signups.
-- This cannot be done via SQL.

-- ============================================================
-- RELOAD SCHEMA CACHE
-- ============================================================
-- PostgREST caches the schema. Without this, new tables/functions
-- may not be visible via the REST API.
NOTIFY pgrst, 'reload schema';
