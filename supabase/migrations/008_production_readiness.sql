-- CHP Meet Scores: Production Readiness Schema Updates
-- Migration 008: Extends the ordering schema for full fulfillment pipeline
--
-- Changes:
--   1. Add 'cancelled' to order_items.production_status CHECK constraint
--   2. Add returned_count to printer_batch_backs for inventory reconciliation
--   3. Add address update tracking to order_status_history
--
-- These changes are prerequisites for: cancel/refund flow, inventory
-- reconciliation, reprint workflow, and assembly line print bundles.

-- ============================================================
-- 1. Add 'cancelled' to order_items production_status
-- ============================================================
-- Needed for partial cancellation (cancel 1 of 3 shirts in an order).
-- Cancelled items are excluded from batch counts, shipping queue, and print bundles.

ALTER TABLE public.order_items
    DROP CONSTRAINT IF EXISTS order_items_production_status_check;

ALTER TABLE public.order_items
    ADD CONSTRAINT order_items_production_status_check
    CHECK (production_status IN ('pending','queued','at_printer','printed','packed','cancelled'));

-- ============================================================
-- 2. Add returned_count to printer_batch_backs
-- ============================================================
-- When a batch returns from the printer, the admin enters how many shirts
-- they actually received per back. If returned_count < shirt_count,
-- the system surfaces a discrepancy alert and allows re-batching.

ALTER TABLE public.printer_batch_backs
    ADD COLUMN IF NOT EXISTS returned_count INTEGER;

-- ============================================================
-- 3. Notify PostgREST to reload schema
-- ============================================================
NOTIFY pgrst, 'reload schema';
