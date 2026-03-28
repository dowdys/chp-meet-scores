-- CHP Meet Scores: Gym Normalization System
-- Migration 004: Persistent gym aliases, club numbers, and correction tools
--
-- Adds:
--   - gym_aliases table for persistent per-state gym name mappings
--   - club_num column on results and winners tables
--   - correct_gym_names RPC for atomic gym name corrections
--   - get_gym_aliases / persist_aliases RPCs for normalizer integration
--   - Updated publish_meet to handle club_num

-- ============================================================
-- GYM ALIASES TABLE
-- ============================================================

CREATE TABLE IF NOT EXISTS public.gym_aliases (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    state TEXT NOT NULL,
    alias TEXT NOT NULL,
    canonical TEXT NOT NULL,
    source TEXT DEFAULT 'manual',  -- 'manual', 'clubnum', 'perplexity', 'auto'
    club_num TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Case-insensitive unique constraint on (state, alias)
CREATE UNIQUE INDEX IF NOT EXISTS idx_gym_aliases_unique
    ON public.gym_aliases(state, lower(alias));

CREATE INDEX IF NOT EXISTS idx_gym_aliases_state
    ON public.gym_aliases(state);

-- RLS: public read (normalizer needs to load these), authenticated write
ALTER TABLE public.gym_aliases ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public can read aliases"
    ON public.gym_aliases FOR SELECT USING (true);
CREATE POLICY "Authenticated can insert aliases"
    ON public.gym_aliases FOR INSERT WITH CHECK ((SELECT auth.role()) = 'authenticated');
CREATE POLICY "Authenticated can update aliases"
    ON public.gym_aliases FOR UPDATE USING ((SELECT auth.role()) = 'authenticated')
    WITH CHECK ((SELECT auth.role()) = 'authenticated');
CREATE POLICY "Authenticated can delete aliases"
    ON public.gym_aliases FOR DELETE USING ((SELECT auth.role()) = 'authenticated');

-- ============================================================
-- CLUB NUMBER COLUMNS
-- ============================================================

ALTER TABLE public.results ADD COLUMN IF NOT EXISTS club_num TEXT;
ALTER TABLE public.winners ADD COLUMN IF NOT EXISTS club_num TEXT;

-- ============================================================
-- RPC: CORRECT GYM NAMES
-- ============================================================
-- Atomically corrects gym names in both results and winners for a given meet.
-- Uses SECURITY DEFINER to bypass missing UPDATE policies on results/winners.

CREATE OR REPLACE FUNCTION correct_gym_names(
    p_meet_name TEXT,
    p_corrections JSONB  -- array of {"old": "TCT", "new": "Twin City Twisters"}
) RETURNS JSONB AS $$
DECLARE
    v_correction JSONB;
    v_old_name TEXT;
    v_new_name TEXT;
    v_results_updated BIGINT := 0;
    v_winners_updated BIGINT := 0;
    v_count BIGINT;
BEGIN
    -- Validate inputs
    IF p_meet_name IS NULL OR length(p_meet_name) = 0 THEN
        RAISE EXCEPTION 'meet_name is required';
    END IF;
    IF p_corrections IS NULL OR jsonb_array_length(p_corrections) = 0 THEN
        RAISE EXCEPTION 'corrections array is required and must not be empty';
    END IF;

    -- Verify meet exists
    IF NOT EXISTS (SELECT 1 FROM public.meets WHERE meet_name = p_meet_name) THEN
        RAISE EXCEPTION 'Meet "%" not found', p_meet_name;
    END IF;

    -- Validate array size
    IF jsonb_array_length(p_corrections) > 500 THEN
        RAISE EXCEPTION 'corrections array exceeds maximum size of 500';
    END IF;

    -- Apply each correction
    FOR v_correction IN SELECT * FROM jsonb_array_elements(p_corrections)
    LOOP
        v_old_name := v_correction->>'old';
        v_new_name := v_correction->>'new';

        IF v_old_name IS NULL OR v_new_name IS NULL THEN
            RAISE EXCEPTION 'Each correction must have "old" and "new" fields';
        END IF;

        -- Update results
        UPDATE public.results
        SET gym = v_new_name
        WHERE meet_name = p_meet_name AND gym = v_old_name;
        GET DIAGNOSTICS v_count = ROW_COUNT;
        v_results_updated := v_results_updated + v_count;

        -- Update winners
        UPDATE public.winners
        SET gym = v_new_name
        WHERE meet_name = p_meet_name AND gym = v_old_name;
        GET DIAGNOSTICS v_count = ROW_COUNT;
        v_winners_updated := v_winners_updated + v_count;
    END LOOP;

    RETURN jsonb_build_object(
        'success', true,
        'meet_name', p_meet_name,
        'corrections_applied', jsonb_array_length(p_corrections),
        'results_updated', v_results_updated,
        'winners_updated', v_winners_updated
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

REVOKE EXECUTE ON FUNCTION correct_gym_names FROM anon;
GRANT EXECUTE ON FUNCTION correct_gym_names TO authenticated;

-- ============================================================
-- RPC: GET GYM ALIASES
-- ============================================================
-- Returns all aliases for a given state. Called by the Python normalizer
-- at the start of gym normalization (Phase 0).

CREATE OR REPLACE FUNCTION get_gym_aliases(
    p_state TEXT
) RETURNS TABLE (alias TEXT, canonical TEXT, club_num TEXT, source TEXT) AS $$
BEGIN
    RETURN QUERY
    SELECT ga.alias, ga.canonical, ga.club_num, ga.source
    FROM public.gym_aliases ga
    WHERE ga.state = p_state
    ORDER BY ga.alias;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '';

-- Public access — the normalizer runs in Python without auth context
GRANT EXECUTE ON FUNCTION get_gym_aliases TO anon;
GRANT EXECUTE ON FUNCTION get_gym_aliases TO authenticated;

-- ============================================================
-- RPC: PERSIST ALIASES
-- ============================================================
-- Upserts gym aliases after corrections are confirmed.
-- Called after build_database when the user approves gym merges.
--
-- IMPORTANT: The ON CONFLICT clause uses (state, lower(alias)) to match
-- the unique index. The EXCLUDED pseudo-row references the VALUES being
-- inserted. See docs/solutions/database-issues/plpgsql-on-conflict-variable-trap.md
-- for the gotcha with loop variable names shadowing column references.

CREATE OR REPLACE FUNCTION persist_aliases(
    p_state TEXT,
    p_aliases JSONB  -- array of {"alias": "TCT", "canonical": "Twin City Twisters", "source": "manual", "club_num": null}
) RETURNS JSONB AS $$
DECLARE
    v_alias JSONB;
    v_processed BIGINT := 0;
BEGIN
    IF p_state IS NULL OR length(p_state) < 2 THEN
        RAISE EXCEPTION 'valid state is required';
    END IF;
    IF jsonb_array_length(p_aliases) > 500 THEN
        RAISE EXCEPTION 'aliases array exceeds maximum size of 500';
    END IF;

    FOR v_alias IN SELECT * FROM jsonb_array_elements(p_aliases)
    LOOP
        INSERT INTO public.gym_aliases (state, alias, canonical, source, club_num)
        VALUES (
            p_state,
            v_alias->>'alias',
            v_alias->>'canonical',
            COALESCE(v_alias->>'source', 'manual'),
            v_alias->>'club_num'
        )
        ON CONFLICT (state, lower(alias))
        DO UPDATE SET
            canonical = EXCLUDED.canonical,
            source = EXCLUDED.source,
            club_num = COALESCE(EXCLUDED.club_num, public.gym_aliases.club_num);

        v_processed := v_processed + 1;
    END LOOP;

    RETURN jsonb_build_object(
        'success', true,
        'state', p_state,
        'aliases_processed', v_processed
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

REVOKE EXECUTE ON FUNCTION persist_aliases FROM anon;
GRANT EXECUTE ON FUNCTION persist_aliases TO authenticated;

-- ============================================================
-- UPDATE publish_meet TO INCLUDE club_num
-- ============================================================

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
        session, level, division, vault, bars, beam, floor, aa, rank, num,
        club_num
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
        r->>'num',
        r->>'club_num'
    FROM jsonb_array_elements(p_results) AS r;

    -- Insert winners
    INSERT INTO public.winners (
        state, meet_name, association, name, gym,
        session, level, division, event, score, is_tie,
        club_num
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
        COALESCE((w->>'is_tie')::BOOLEAN, FALSE),
        w->>'club_num'
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

-- Permissions unchanged (already granted to authenticated)

-- ============================================================
-- APPLY MN CORRECTIONS
-- ============================================================
-- These run once to fix the existing MN data in Supabase.
-- After running, the gym_aliases entries ensure future MN runs
-- automatically apply these corrections.

SELECT correct_gym_names(
    'USAG W Gymnastics - 2026 MN - March 20',
    '[
        {"old": "TCT", "new": "Twin City Twisters"},
        {"old": "EGA", "new": "Elite"},
        {"old": "Jam Hops AR", "new": "Jam Hops Anoka"},
        {"old": "MHG", "new": "Mini Hops"},
        {"old": "Midwest Gym", "new": "Midwest Gymnastics"},
        {"old": "Perpetual Motion", "new": "Perpetual Motion Gymnastics"},
        {"old": "Pmg", "new": "Perpetual Motion Gymnastics"}
    ]'::JSONB
);

-- Persist MN aliases for future runs
SELECT persist_aliases(
    'MN',
    '[
        {"alias": "TCT", "canonical": "Twin City Twisters", "source": "manual"},
        {"alias": "EGA", "canonical": "Elite", "source": "manual"},
        {"alias": "Jam Hops AR", "canonical": "Jam Hops Anoka", "source": "manual"},
        {"alias": "MHG", "canonical": "Mini Hops", "source": "manual"},
        {"alias": "Midwest Gym", "canonical": "Midwest Gymnastics", "source": "manual"},
        {"alias": "Perpetual Motion", "canonical": "Perpetual Motion Gymnastics", "source": "manual"},
        {"alias": "Pmg", "canonical": "Perpetual Motion Gymnastics", "source": "manual"},
        {"alias": "PMG", "canonical": "Perpetual Motion Gymnastics", "source": "manual"}
    ]'::JSONB
);

-- ============================================================
-- RELOAD SCHEMA CACHE
-- ============================================================
NOTIFY pgrst, 'reload schema';
