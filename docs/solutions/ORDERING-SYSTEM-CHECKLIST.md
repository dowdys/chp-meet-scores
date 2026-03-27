---
title: "Ordering System Implementation Checklist"
date: 2026-03-27
type: checklist
---

# Ordering System Implementation Checklist

Based on institutional learnings from CHP codebase. Check off each item before merging schema or API code.

## Database Schema & Constraints

- [ ] **Foreign Key Integrity**: Add validation that `order_items.meet_name` has corresponding `shirt_backs(meet_name)` rows before INSERT
- [ ] **Status Transitions**: Document valid state transitions in code comment:
  ```
  pending → paid / cancelled
  paid → processing / refunded / cancelled
  processing → shipped / refunded
  shipped → delivered / refunded
  (other states are final)
  ```
- [ ] **Batch Locking**: Add CHECK constraint preventing `order_items` from adding to `printer_batch` with status IN ('at_printer', 'returned')
- [ ] **Idempotency**: Add `webhook_events` table to track processed Stripe/EasyPost events by ID
- [ ] **Customizations Column**: Add `shirt_backs.customizations JSONB` to store level_groups, page_size, fonts (user-customized, NOT destructive filters)
- [ ] **Audit Log**: Create `audit_logs` table with user_id, action, resource_id, old_value, new_value, timestamp for all destructive operations
- [ ] **TTL Strategy**: Document S3 object lifecycle rules (delete temp PDFs after 30 days, email drafts after 60 days)

## API Endpoint Design

### Order Creation (`POST /api/orders`)
- [ ] Validate `meet_name` has `shirt_backs` rows with `status` NOT 'pending'
- [ ] Check inventory (if implementing caps): `COUNT(order_items.back_id) < shirt_backs.shirt_capacity`
- [ ] Atomically create `order` + `order_items` in transaction
- [ ] Return `order_number` (human-readable) + `stripe_client_secret` for frontend checkout

### Stripe Webhook Handler (`POST /webhooks/stripe`)
- [ ] Check event ID against `webhook_events` table (idempotency)
- [ ] If already processed, return 200 immediately (acknowledge receipt)
- [ ] For `payment_intent.succeeded`: Update `orders` → status='paid', paid_at=NOW()
- [ ] Validate order.status is 'pending' before transition (raise 409 if not)
- [ ] Log to `audit_logs`
- [ ] Queue email via Postmark (idempotently: store `email_send_id` to avoid duplicates)
- [ ] Validate `orders.status = 'pending'` before allowing transition

### Admin: Create Printer Batch (`POST /api/batches`)
- [ ] Require RLS check: user.role IN ('admin', 'shipping')
- [ ] Accept array of `back_id`s
- [ ] Atomically create `printer_batches` row + `printer_batch_backs` joins
- [ ] Update all `order_items.printer_batch_id` for items in those backs
- [ ] Validate no items already in different batch (raise 409 if conflict)
- [ ] Log to `audit_logs` (user, backs count, batch_id)

### Admin: Update Order (`PATCH /api/orders/:id`)
- [ ] Accept status transitions, corrections, shipping updates
- [ ] Validate transition is in `VALID_TRANSITIONS` map
- [ ] If `corrected_name` submitted: require `name_correction_reviewed` = false, set flag to true after admin review
- [ ] If refund: generate idempotency_key, check `orders.refund_idempotency_key` for duplicate
- [ ] Log to `audit_logs`

### Admin: Regenerate PDF (`POST /api/batches/:back_id/regenerate-pdf`)
- [ ] Load `shirt_backs.customizations` (level_groups, page_size, fonts)
- [ ] If `?force=true`: ignore customizations, regenerate from defaults
- [ ] If `?force=false` (default): apply customizations before re-rendering
- [ ] Delete old temp PDF from S3 Storage
- [ ] Return new `design_pdf_url`

## Frontend Admin Dashboard

### Order Status View
- [ ] Display state machine diagram (pending → paid → processing → shipped → delivered)
- [ ] Show `paid_at`, `shipped_at`, `delivered_at` timestamps
- [ ] Show `name_correction_reviewed` status with badge (requires action)
- [ ] Disable "Refund" button if status is 'refunded' or 'cancelled'
- [ ] Disable "Ship" button if status is not 'paid' or 'processing'

### Printer Batch View
- [ ] Show batch status (queued / at_printer / returned)
- [ ] Disable "Add Items" button if status is 'at_printer' or 'returned'
- [ ] Show item count per back
- [ ] "Regenerate PDF" option calls `POST /api/batches/:back_id/regenerate-pdf` (preserves customizations by default)
- [ ] "Reset Design" option calls with `?force=true`

### Admin Filters
- [ ] **View Preferences (STICKY)**: column widths, sort order, page size
  - Persist to localStorage
  - Auto-restore on page load
- [ ] **Operational Filters (NOT STICKY)**: status, state, date range, payment status
  - Show badge: "Filters Active (3)"
  - Badge click → reset to defaults
  - Clear filters on page navigation (useEffect cleanup)
- [ ] Add visual indicator if any non-default filter is active

### Webhook Event Log (Admin View)
- [ ] Display `order_events` table: event_type, prev_status, new_status, triggered_at
- [ ] Search by order_id, date range
- [ ] Show Stripe event ID (for debugging webhook issues)

## Webhook & Background Jobs

### Stripe Event Handlers
- [ ] `payment_intent.succeeded` → Update order.status, send confirmation email
- [ ] `charge.refunded` → Update order.status, send refund email, dequeue from batch
- [ ] All handlers: store event ID in `webhook_events` before processing

### EasyPost Event Handlers
- [ ] `track.updated` (delivery status) → Update order.status, send tracking email
- [ ] `shipment.delivered` → Update order.status='delivered', send arrival email
- [ ] All handlers: idempotency check

### Cron Jobs
- [ ] **Nightly cleanup** (2 AM): Delete temp PDFs > 30 days, email drafts > 60 days
- [ ] **Weekly report** (Monday 8 AM): Send admin digest of pending orders, refunds, shipments

## Testing & Validation

- [ ] **State Machine Tests**: Verify all valid transitions work, all invalid transitions raise 409
- [ ] **Webhook Idempotency**: Send same webhook twice, verify only one order update occurs
- [ ] **Meet Name Validation**: Try creating order_items for non-existent meet_name, verify 400 error
- [ ] **Batch Locking**: Try adding items to batch with status='at_printer', verify 409 error
- [ ] **Customization Persistence**: Regenerate PDF without --force, verify level_groups preserved
- [ ] **Filter Reset**: Set operational filter, navigate away, navigate back, verify filter is cleared
- [ ] **Audit Trail**: Perform refund, check audit_logs table has entry
- [ ] **Load Testing**: Simulate 100 concurrent order submissions, verify no FK violations or duplicate charges

## Documentation

- [ ] **API Reference**: Document all endpoints with valid status transitions
- [ ] **Admin Runbook**: "Issuing a Refund", "Regenerating a Batch", "Investigating a Missing Shipment"
- [ ] **Destructive Operations**: List operations that require audit logging (refund, batch status change, name correction)
- [ ] **Webhook Debugging**: How to manually test Stripe webhooks, how to replay failed events
- [ ] **Status Machine Diagram**: ASCII diagram or Miro diagram of state transitions

## Pre-Launch Validation

- [ ] [ ] Test with 100 sample orders across 10 meets
- [ ] [ ] Verify Supabase RLS policies enforce admin-only access to sensitive operations
- [ ] [ ] Verify all email templates are rendered and tested (Postmark React Email)
- [ ] [ ] Verify EasyPost labels are generating with correct athlete names and QR codes
- [ ] [ ] Verify meet_name in all order_items matches a shirt_backs row
- [ ] [ ] Run full webhook simulation (Stripe sandbox, EasyPost sandbox)
- [ ] [ ] Verify phone number validation (optional but stored)
- [ ] [ ] Verify state-specific tax calculations (Stripe Tax auto-handled)
- [ ] [ ] Verify printer batch manifest PDF is complete and printer-ready

---

## Critical Gotchas (Don't Miss!)

1. **meet_name must match exactly** between Electron app publication and Supabase order lookup
2. **Status transitions are not reversible** once paid — only valid action is refund
3. **Printer batch status is immutable** once at_printer — manually mark 'returned' to unlock
4. **Operational filters must NOT auto-restore** — clear them on page navigation
5. **Webhook handlers must be idempotent** — same event ID should not process twice
6. **Customizations are STICKY** — regenerate without --force preserves level_groups
7. **Destructive filters are NOT sticky** — exclude-levels does NOT auto-restore (but this shouldn't apply to ordering system)

