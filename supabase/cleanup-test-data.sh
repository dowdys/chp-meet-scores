#!/bin/bash
# ============================================================
# CLEANUP: Remove all test seed data
# Deletes TEST-prefixed orders, batches, and test emails.
# Covers both TEST-SEED-* (small seed) and TEST-REAL-* (realistic volume).
# ============================================================
set -euo pipefail

source "$(dirname "$0")/../website/.env.local"
SB_URL="$NEXT_PUBLIC_SUPABASE_URL"
SB_KEY="$SUPABASE_SERVICE_ROLE_KEY"

del() {
  local table=$1 filter=$2
  curl -sf "$SB_URL/rest/v1/$table?$filter" \
    -X DELETE \
    -H "apikey: $SB_KEY" \
    -H "Authorization: Bearer $SB_KEY" \
    -H "Prefer: return=representation" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'  Deleted {len(d)} rows from $table')" 2>/dev/null || echo "  $table: 0 rows (or table empty)"
}

echo "=== Cleaning up test data ==="

# Order items and status history are CASCADE deleted with orders
# But we also need to unlink batch references first
echo "Unlinking batch references from test order items..."
curl -sf "$SB_URL/rest/v1/order_items?order_id=in.(select id from orders where order_number like 'TEST-%')" \
  -X PATCH \
  -H "apikey: $SB_KEY" \
  -H "Authorization: Bearer $SB_KEY" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=minimal" \
  -d '{"printer_batch_id": null}' 2>/dev/null || true

# Delete printer_batch_backs for test batches
echo "Deleting test printer batch backs..."
del printer_batch_backs "batch_id=in.(select id from printer_batches where batch_name like 'TEST-%')" 2>/dev/null || true

# Delete test batches
del printer_batches "batch_name=like.TEST-*"

# Delete test orders (cascades to order_items + order_status_history)
del orders "order_number=like.TEST-*"

# Delete test email captures
del email_captures "email=like.*@test.example.com"

echo ""
echo "=== Cleanup complete ==="
