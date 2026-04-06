-- ============================================================
-- CLEANUP: Remove all test seed data
-- Safe to run repeatedly. Only deletes TEST-prefixed data.
-- Covers both TEST-SEED-* (small seed) and TEST-REAL-* (realistic volume).
-- ============================================================

BEGIN;

-- Order items are CASCADE deleted with orders
-- Status history is CASCADE deleted with orders
DELETE FROM orders WHERE order_number LIKE 'TEST-%';

-- Printer batch backs are CASCADE deleted with batches
DELETE FROM printer_batches WHERE batch_name LIKE 'TEST-%';

-- Email captures
DELETE FROM email_captures WHERE email LIKE '%@test.example.com';

COMMIT;

-- Verify cleanup
SELECT 'Remaining test orders:' AS check, COUNT(*) FROM orders WHERE order_number LIKE 'TEST-%'
UNION ALL
SELECT 'Remaining test batches:', COUNT(*) FROM printer_batches WHERE batch_name LIKE 'TEST-%'
UNION ALL
SELECT 'Remaining test emails:', COUNT(*) FROM email_captures WHERE email LIKE '%@test.example.com';
