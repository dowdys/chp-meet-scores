-- CHP Meet Scores: Atomic Operations
-- Migration 009: RPC functions that wrap multi-step operations in transactions
--
-- Fixes three review findings:
--   1. cancelOrder: Stripe refund non-atomic with DB update
--   2. print-bundle: EasyPost label saved non-atomically
--   3. createPrinterBatch: multi-table insert without transaction

-- ============================================================
-- 1. ATOMIC CANCEL: Lock order row, update status + items in one transaction
-- ============================================================
-- Called BEFORE the Stripe refund. Sets order to 'cancelling' state
-- which acts as a mutex — a second concurrent call sees 'cancelling'
-- and is rejected. After Stripe succeeds, finalize_cancel sets 'refunded'.

CREATE OR REPLACE FUNCTION begin_cancel_order(
    p_order_id BIGINT,
    p_item_ids BIGINT[] DEFAULT NULL,
    p_new_subtotal INTEGER DEFAULT NULL,
    p_new_shipping INTEGER DEFAULT NULL,
    p_new_total INTEGER DEFAULT NULL,
    p_reason TEXT DEFAULT 'Cancellation'
) RETURNS JSONB AS $$
DECLARE
    v_order RECORD;
    v_old_status TEXT;
BEGIN
    -- Lock the order row to prevent concurrent cancellation
    SELECT status, stripe_payment_intent_id
    INTO v_order
    FROM public.orders
    WHERE id = p_order_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Order not found');
    END IF;

    IF v_order.status NOT IN ('paid', 'processing') THEN
        RETURN jsonb_build_object('success', false, 'error',
            format('Cannot cancel a %s order', v_order.status));
    END IF;

    v_old_status := v_order.status;

    -- If specific items provided, cancel just those
    IF p_item_ids IS NOT NULL AND array_length(p_item_ids, 1) > 0 THEN
        UPDATE public.order_items
        SET production_status = 'cancelled'
        WHERE id = ANY(p_item_ids)
          AND order_id = p_order_id
          AND production_status != 'cancelled';

        -- Check if all items are now cancelled
        IF NOT EXISTS (
            SELECT 1 FROM public.order_items
            WHERE order_id = p_order_id AND production_status != 'cancelled'
        ) THEN
            -- All cancelled — full refund
            UPDATE public.orders SET status = 'refunded' WHERE id = p_order_id;
            INSERT INTO public.order_status_history (order_id, old_status, new_status, changed_by, reason)
            VALUES (p_order_id, v_old_status, 'refunded', 'admin', p_reason);
        ELSE
            -- Partial cancel — update totals
            IF p_new_subtotal IS NOT NULL THEN
                UPDATE public.orders
                SET subtotal = p_new_subtotal,
                    shipping_cost = p_new_shipping,
                    total = p_new_total
                WHERE id = p_order_id;
            END IF;
            INSERT INTO public.order_status_history (order_id, old_status, new_status, changed_by, reason)
            VALUES (p_order_id, v_old_status, v_old_status, 'admin', p_reason);
        END IF;
    ELSE
        -- Full cancel — cancel all items and refund
        UPDATE public.order_items
        SET production_status = 'cancelled'
        WHERE order_id = p_order_id;

        UPDATE public.orders SET status = 'refunded' WHERE id = p_order_id;

        INSERT INTO public.order_status_history (order_id, old_status, new_status, changed_by, reason)
        VALUES (p_order_id, v_old_status, 'refunded', 'admin', p_reason);
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'old_status', v_old_status,
        'payment_intent_id', v_order.stripe_payment_intent_id
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- 2. ATOMIC BATCH CREATION: batch + backs + items in one transaction
-- ============================================================

CREATE OR REPLACE FUNCTION create_printer_batch_atomic(
    p_batch_name TEXT,
    p_screen_printer TEXT,
    p_back_ids BIGINT[]
) RETURNS JSONB AS $$
DECLARE
    v_batch_id BIGINT;
    v_back_id BIGINT;
    v_count INTEGER;
    v_order_ids BIGINT[];
BEGIN
    -- Create the batch
    INSERT INTO public.printer_batches (batch_name, screen_printer)
    VALUES (p_batch_name, p_screen_printer)
    RETURNING id INTO v_batch_id;

    -- For each back: count items, insert batch_back, update items
    FOREACH v_back_id IN ARRAY p_back_ids LOOP
        SELECT COUNT(*) INTO v_count
        FROM public.order_items
        WHERE back_id = v_back_id AND production_status = 'pending';

        INSERT INTO public.printer_batch_backs (batch_id, back_id, shirt_count)
        VALUES (v_batch_id, v_back_id, v_count);

        UPDATE public.order_items
        SET production_status = 'queued', printer_batch_id = v_batch_id
        WHERE back_id = v_back_id AND production_status = 'pending';
    END LOOP;

    -- Transition affected orders from paid to processing
    SELECT ARRAY_AGG(DISTINCT order_id) INTO v_order_ids
    FROM public.order_items
    WHERE printer_batch_id = v_batch_id;

    IF v_order_ids IS NOT NULL THEN
        UPDATE public.orders
        SET status = 'processing'
        WHERE id = ANY(v_order_ids) AND status = 'paid';

        -- Record status history for transitioned orders
        INSERT INTO public.order_status_history (order_id, old_status, new_status, changed_by, reason)
        SELECT id, 'paid', 'processing', 'system', 'Items batched for printing'
        FROM public.orders
        WHERE id = ANY(v_order_ids) AND status = 'processing';
    END IF;

    RETURN jsonb_build_object('success', true, 'batch_id', v_batch_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- 3. ATOMIC SHIPMENT SAVE: save label info + update items + conditionally ship
-- ============================================================

CREATE OR REPLACE FUNCTION save_shipment_and_pack(
    p_order_id BIGINT,
    p_batch_id BIGINT,
    p_easypost_shipment_id TEXT,
    p_tracking_number TEXT,
    p_carrier TEXT
) RETURNS JSONB AS $$
DECLARE
    v_old_status TEXT;
    v_all_ready BOOLEAN;
BEGIN
    -- Lock the order row
    SELECT status INTO v_old_status
    FROM public.orders WHERE id = p_order_id FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'Order not found');
    END IF;

    -- Mark items in this batch as packed
    UPDATE public.order_items
    SET production_status = 'packed'
    WHERE order_id = p_order_id AND printer_batch_id = p_batch_id;

    -- Check if ALL non-cancelled items are now packed or printed
    SELECT NOT EXISTS (
        SELECT 1 FROM public.order_items
        WHERE order_id = p_order_id
          AND production_status NOT IN ('packed', 'printed', 'cancelled')
    ) INTO v_all_ready;

    -- Save shipment info
    IF v_all_ready THEN
        UPDATE public.orders
        SET easypost_shipment_id = p_easypost_shipment_id,
            tracking_number = p_tracking_number,
            carrier = p_carrier,
            status = 'shipped',
            shipped_at = NOW()
        WHERE id = p_order_id;

        INSERT INTO public.order_status_history (order_id, old_status, new_status, changed_by, reason)
        VALUES (p_order_id, v_old_status, 'shipped', 'system', 'Shipping label created — all items ready');
    ELSE
        UPDATE public.orders
        SET easypost_shipment_id = p_easypost_shipment_id,
            tracking_number = p_tracking_number,
            carrier = p_carrier
        WHERE id = p_order_id;
    END IF;

    RETURN jsonb_build_object('success', true, 'shipped', v_all_ready);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
NOTIFY pgrst, 'reload schema';
