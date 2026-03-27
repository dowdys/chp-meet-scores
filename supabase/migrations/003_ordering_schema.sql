-- CHP Meet Scores: Ordering System Schema
-- Migration 003: New tables for thestatechampion.com ordering system
--
-- IMPORTANT: This migration must run AFTER 001_initial_schema.sql and
-- 002_query_endpoints.sql. It adds ordering, shipping, and admin tables
-- alongside the existing meets/results/winners data.
--
-- Key design decisions (from deepened plan review):
--   - New tables reference meets(id) not meets(meet_name) to avoid FK fragility
--   - shirt_backs are append-only with versioning (superseded_at pattern)
--   - athlete_tokens use ON DELETE RESTRICT (not CASCADE) to survive meet re-processing
--   - orders/order_items deny all public access via RLS (service role bypasses)
--   - publish_meet_v2 replaces the destructive delete-and-reinsert pattern

-- ============================================================
-- PUBLISH_MEET_V2: Safe republish that preserves ordering data
-- ============================================================
-- The original publish_meet deletes the meets row and cascades to all
-- child tables. This is catastrophic when orders reference that data.
-- v2 upserts the meets row and only replaces results + winners.

CREATE OR REPLACE FUNCTION publish_meet_v2(
    p_meet JSONB,
    p_results JSONB,
    p_winners JSONB
) RETURNS JSONB AS $$
DECLARE
    v_meet_id BIGINT;
    v_version INTEGER;
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

    -- UPSERT the meets row (preserves id, no cascading deletes)
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
        1,
        p_meet->>'published_by',
        jsonb_array_length(p_results),
        jsonb_array_length(p_winners)
    )
    ON CONFLICT (meet_name) DO UPDATE SET
        source = EXCLUDED.source,
        source_id = EXCLUDED.source_id,
        source_name = EXCLUDED.source_name,
        state = EXCLUDED.state,
        association = EXCLUDED.association,
        year = EXCLUDED.year,
        dates = EXCLUDED.dates,
        version = public.meets.version + 1,
        published_by = EXCLUDED.published_by,
        athlete_count = EXCLUDED.athlete_count,
        winner_count = EXCLUDED.winner_count,
        published_at = NOW(),
        updated_at = NOW()
    RETURNING id, version INTO v_meet_id, v_version;

    -- Delete and reinsert ONLY results and winners (reproducible data)
    -- shirt_backs, athlete_tokens, orders, order_items are UNTOUCHED
    DELETE FROM public.results WHERE meet_name = (p_meet->>'meet_name');
    DELETE FROM public.winners WHERE meet_name = (p_meet->>'meet_name');

    -- Insert results
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
        'meet_id', v_meet_id,
        'meet_name', p_meet->>'meet_name',
        'version', v_version,
        'results_count', jsonb_array_length(p_results),
        'winners_count', jsonb_array_length(p_winners)
    );

    RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

-- Lock down RPC execution
REVOKE EXECUTE ON FUNCTION publish_meet_v2 FROM anon;
GRANT EXECUTE ON FUNCTION publish_meet_v2 TO authenticated;

-- ============================================================
-- SHIRT BACKS: Append-only with versioning
-- ============================================================
CREATE TABLE public.shirt_backs (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    meet_id BIGINT NOT NULL REFERENCES public.meets(id) ON DELETE RESTRICT,
    meet_name TEXT NOT NULL,
    level_group_label TEXT NOT NULL,
    levels TEXT[] NOT NULL,
    design_pdf_url TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    superseded_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_shirt_backs_meet ON public.shirt_backs(meet_id, level_group_label)
    WHERE superseded_at IS NULL;
CREATE INDEX idx_shirt_backs_levels ON public.shirt_backs USING GIN(levels);

ALTER TABLE public.shirt_backs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public can read active backs" ON public.shirt_backs
    FOR SELECT USING (true);
CREATE POLICY "Authenticated can insert backs" ON public.shirt_backs
    FOR INSERT WITH CHECK ((SELECT auth.role()) = 'authenticated');

-- ============================================================
-- ATHLETE TOKENS: Immutable once created (survive re-processing)
-- ============================================================
CREATE TABLE public.athlete_tokens (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    token TEXT UNIQUE NOT NULL,
    meet_id BIGINT NOT NULL REFERENCES public.meets(id) ON DELETE RESTRICT,
    meet_name TEXT NOT NULL,
    athlete_name TEXT NOT NULL,
    gym TEXT NOT NULL DEFAULT '',
    level TEXT NOT NULL,
    division TEXT NOT NULL,
    events JSONB NOT NULL DEFAULT '[]',
    qr_image_url TEXT,
    scan_count INTEGER NOT NULL DEFAULT 0,
    last_scanned_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_athlete_tokens_lookup ON public.athlete_tokens(meet_name, athlete_name, gym);

ALTER TABLE public.athlete_tokens ENABLE ROW LEVEL SECURITY;
-- No public SELECT policy — use server-side API route for token lookup
-- to prevent bulk enumeration of children's data
CREATE POLICY "Authenticated can insert tokens" ON public.athlete_tokens
    FOR INSERT WITH CHECK ((SELECT auth.role()) = 'authenticated');
CREATE POLICY "Authenticated can update tokens" ON public.athlete_tokens
    FOR UPDATE USING ((SELECT auth.role()) = 'authenticated');

-- Server-side RPC for safe single-token lookup (used by celebration page)
CREATE OR REPLACE FUNCTION public.lookup_athlete_token(p_token TEXT)
RETURNS JSONB AS $$
DECLARE
    v_result JSONB;
BEGIN
    -- Increment scan count atomically
    UPDATE public.athlete_tokens
    SET scan_count = scan_count + 1, last_scanned_at = NOW()
    WHERE token = p_token;

    -- Return token data
    SELECT jsonb_build_object(
        'token', t.token,
        'meet_name', t.meet_name,
        'athlete_name', t.athlete_name,
        'gym', t.gym,
        'level', t.level,
        'division', t.division,
        'events', t.events
    ) INTO v_result
    FROM public.athlete_tokens t
    WHERE t.token = p_token;

    RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

-- Allow anonymous access to the lookup function (celebration pages are public)
GRANT EXECUTE ON FUNCTION public.lookup_athlete_token TO anon;
GRANT EXECUTE ON FUNCTION public.lookup_athlete_token TO authenticated;

-- ============================================================
-- ORDER NUMBER SEQUENCE
-- ============================================================
CREATE SEQUENCE public.order_number_seq START 1;

-- Helper RPC for safe order number generation from application code
CREATE OR REPLACE FUNCTION public.nextval_order_number()
RETURNS BIGINT AS $$
  SELECT nextval('public.order_number_seq');
$$ LANGUAGE sql SECURITY DEFINER SET search_path = '';

GRANT EXECUTE ON FUNCTION public.nextval_order_number TO authenticated;

-- ============================================================
-- ORDERS
-- ============================================================
CREATE TABLE public.orders (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_number TEXT UNIQUE NOT NULL,
    stripe_session_id TEXT UNIQUE,
    stripe_payment_intent_id TEXT,

    customer_name TEXT NOT NULL,
    customer_email TEXT NOT NULL,
    customer_phone TEXT,

    shipping_name TEXT NOT NULL,
    shipping_address_line1 TEXT NOT NULL,
    shipping_address_line2 TEXT,
    shipping_city TEXT NOT NULL,
    shipping_state TEXT NOT NULL CHECK (length(shipping_state) = 2),
    shipping_zip TEXT NOT NULL CHECK (shipping_zip ~ '^\d{5}(-\d{4})?$'),

    subtotal INTEGER NOT NULL,
    shipping_cost INTEGER NOT NULL,
    tax INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL,
    CHECK (total = subtotal + shipping_cost + tax),

    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','paid','processing','shipped','delivered','refunded','cancelled')),

    easypost_shipment_id TEXT,
    tracking_number TEXT,
    carrier TEXT,

    paid_at TIMESTAMPTZ,
    shipped_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_orders_status ON public.orders(status);
CREATE INDEX idx_orders_email ON public.orders(customer_email);
CREATE INDEX idx_orders_status_created ON public.orders(status, created_at DESC);

ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
-- Deny all non-service access. Service role bypasses RLS entirely.
CREATE POLICY "Deny public access to orders" ON public.orders
    FOR ALL USING (false);

-- Auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER orders_updated_at BEFORE UPDATE ON public.orders
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ============================================================
-- ORDER ITEMS
-- ============================================================
CREATE TABLE public.order_items (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id BIGINT NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,

    athlete_name TEXT NOT NULL,
    corrected_name TEXT,
    name_correction_reviewed BOOLEAN DEFAULT FALSE,
    meet_id BIGINT NOT NULL REFERENCES public.meets(id) ON DELETE RESTRICT,
    meet_name TEXT NOT NULL,
    back_id BIGINT NOT NULL REFERENCES public.shirt_backs(id) ON DELETE RESTRICT,

    shirt_size TEXT NOT NULL
        CHECK (shirt_size IN ('YS','YM','YL','S','M','L','XL','XXL')),
    shirt_color TEXT NOT NULL DEFAULT 'white'
        CHECK (shirt_color IN ('white','grey')),
    has_jewel BOOLEAN NOT NULL DEFAULT FALSE,

    unit_price INTEGER NOT NULL,
    jewel_price INTEGER NOT NULL DEFAULT 0,

    production_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (production_status IN ('pending','queued','at_printer','printed','packed')),
    printer_batch_id BIGINT,

    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_order_items_back ON public.order_items(back_id, production_status);
CREATE INDEX idx_order_items_order ON public.order_items(order_id);
CREATE INDEX idx_order_items_back_agg ON public.order_items(production_status, back_id)
    INCLUDE (shirt_size, shirt_color, has_jewel, corrected_name);
CREATE INDEX idx_order_items_order_status ON public.order_items(order_id, production_status);
CREATE INDEX idx_order_items_meet ON public.order_items(meet_name);
CREATE INDEX idx_order_items_corrections ON public.order_items(id)
    WHERE corrected_name IS NOT NULL AND name_correction_reviewed = FALSE;

ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Deny public access to order items" ON public.order_items
    FOR ALL USING (false);

-- ============================================================
-- PRINTER BATCHES
-- ============================================================
CREATE TABLE public.printer_batches (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    batch_name TEXT NOT NULL,
    screen_printer TEXT NOT NULL DEFAULT 'printer_2'
        CHECK (screen_printer IN ('printer_1','printer_2')),
    status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued','at_printer','returned')),
    sent_at TIMESTAMPTZ,
    returned_at TIMESTAMPTZ,
    notes TEXT,
    created_by TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.printer_batches ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Deny public access to batches" ON public.printer_batches
    FOR ALL USING (false);

-- Join table: which backs are in which batch
CREATE TABLE public.printer_batch_backs (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    batch_id BIGINT NOT NULL REFERENCES public.printer_batches(id) ON DELETE CASCADE,
    back_id BIGINT NOT NULL REFERENCES public.shirt_backs(id) ON DELETE RESTRICT,
    shirt_count INTEGER NOT NULL DEFAULT 0,
    UNIQUE(batch_id, back_id)
);
CREATE INDEX idx_printer_batch_backs_batch ON public.printer_batch_backs(batch_id)
    INCLUDE (back_id);

ALTER TABLE public.printer_batch_backs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Deny public access to batch backs" ON public.printer_batch_backs
    FOR ALL USING (false);

-- Add FK from order_items to printer_batches
ALTER TABLE public.order_items
    ADD CONSTRAINT fk_order_items_batch
    FOREIGN KEY (printer_batch_id) REFERENCES public.printer_batches(id);

-- ============================================================
-- EMAIL CAPTURES
-- ============================================================
CREATE TABLE public.email_captures (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email TEXT NOT NULL,
    phone TEXT,
    athlete_name TEXT NOT NULL,
    state TEXT,
    association TEXT,
    year TEXT DEFAULT '2026',
    gym TEXT,
    level TEXT,
    meet_identifier TEXT,
    notified BOOLEAN DEFAULT FALSE,
    notified_at TIMESTAMPTZ,
    source TEXT DEFAULT 'website',
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_email_captures_state ON public.email_captures(state, notified);
CREATE UNIQUE INDEX idx_email_captures_unique
    ON public.email_captures(email, athlete_name, COALESCE(state, ''));

ALTER TABLE public.email_captures ENABLE ROW LEVEL SECURITY;
-- No public insert policy — use server-side API route with rate limiting
CREATE POLICY "Deny public access to captures" ON public.email_captures
    FOR ALL USING (false);

-- ============================================================
-- ADMIN USERS
-- ============================================================
CREATE TABLE public.admin_users (
    id UUID PRIMARY KEY REFERENCES auth.users(id),
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin'
        CHECK (role IN ('admin','shipping','viewer')),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.admin_users ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins can read admin users" ON public.admin_users
    FOR SELECT USING ((SELECT auth.uid()) IN (SELECT id FROM public.admin_users));

-- ============================================================
-- ORDER STATUS HISTORY (audit trail)
-- ============================================================
CREATE TABLE public.order_status_history (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id BIGINT NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
    old_status TEXT,
    new_status TEXT NOT NULL,
    changed_by TEXT,
    reason TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_order_status_history ON public.order_status_history(order_id);

ALTER TABLE public.order_status_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Deny public access to history" ON public.order_status_history
    FOR ALL USING (false);

-- ============================================================
-- WEBHOOK EVENTS (idempotency tracking)
-- ============================================================
CREATE TABLE public.webhook_events (
    event_id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    status TEXT DEFAULT 'completed',
    processed_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.webhook_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Deny public access to webhook events" ON public.webhook_events
    FOR ALL USING (false);

-- ============================================================
-- PERFORMANCE INDEXES on existing tables
-- ============================================================
-- Cascading dropdown: state -> gym -> name lookup
CREATE INDEX IF NOT EXISTS idx_winners_state_gym_name ON public.winners(state, gym, name);
-- Meets lookup: year + association -> state
CREATE INDEX IF NOT EXISTS idx_meets_year_assoc_state ON public.meets(year, association, state);

-- ============================================================
-- RLS POLICY UPDATES: Change winners/meets from authenticated-only to public read
-- ============================================================
-- Drop existing authenticated-only SELECT policies
DROP POLICY IF EXISTS "Authenticated read" ON public.meets;
DROP POLICY IF EXISTS "Authenticated read" ON public.winners;
DROP POLICY IF EXISTS "Authenticated read" ON public.results;

-- Create public read policies (competition results are public data)
CREATE POLICY "Public can read meets" ON public.meets
    FOR SELECT USING (true);
CREATE POLICY "Public can read winners" ON public.winners
    FOR SELECT USING (true);
CREATE POLICY "Public can read results" ON public.results
    FOR SELECT USING (true);

-- Keep existing insert/update policies for Electron app (authenticated role)

-- ============================================================
-- ADMIN RLS POLICIES for orders (browser-side admin dashboard)
-- ============================================================
CREATE POLICY "Admins can read orders" ON public.orders
    FOR SELECT USING ((SELECT auth.uid()) IN (SELECT id FROM public.admin_users));
CREATE POLICY "Admins can read order items" ON public.order_items
    FOR SELECT USING ((SELECT auth.uid()) IN (SELECT id FROM public.admin_users));
CREATE POLICY "Admins can read batches" ON public.printer_batches
    FOR SELECT USING ((SELECT auth.uid()) IN (SELECT id FROM public.admin_users));
CREATE POLICY "Admins can read batch backs" ON public.printer_batch_backs
    FOR SELECT USING ((SELECT auth.uid()) IN (SELECT id FROM public.admin_users));
CREATE POLICY "Admins can read status history" ON public.order_status_history
    FOR SELECT USING ((SELECT auth.uid()) IN (SELECT id FROM public.admin_users));
CREATE POLICY "Admins can read email captures" ON public.email_captures
    FOR SELECT USING ((SELECT auth.uid()) IN (SELECT id FROM public.admin_users));
CREATE POLICY "Admins can read webhook events" ON public.webhook_events
    FOR SELECT USING ((SELECT auth.uid()) IN (SELECT id FROM public.admin_users));

-- Admin write policies for batch management
CREATE POLICY "Admins can manage batches" ON public.printer_batches
    FOR ALL USING ((SELECT auth.uid()) IN (SELECT id FROM public.admin_users))
    WITH CHECK ((SELECT auth.uid()) IN (SELECT id FROM public.admin_users));
CREATE POLICY "Admins can manage batch backs" ON public.printer_batch_backs
    FOR ALL USING ((SELECT auth.uid()) IN (SELECT id FROM public.admin_users))
    WITH CHECK ((SELECT auth.uid()) IN (SELECT id FROM public.admin_users));

-- ============================================================
-- RELOAD SCHEMA CACHE
-- ============================================================
NOTIFY pgrst, 'reload schema';
