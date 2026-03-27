---
title: "Institutional Learnings Applied to Ordering System Plan"
date: 2026-03-27
status: analysis
---

# Ordering System Plan: Institutional Learnings Analysis

## Plan Context

The State Champion Ordering System (`2026-03-27-001-feat-thestatechampion-ordering-system-plan.md`) builds a complete Stripe-powered, digital ordering and fulfillment system on Supabase PostgreSQL. Key tables include:

- **shirt_backs**: level group designs per meet (keyed by `meet_name`)
- **orders**: checkout transactions (with status lifecycle: pending → paid → processing → shipped → delivered)
- **order_items**: individual shirts per order (with `corrected_name`, `production_status`)
- **printer_batches**: batched backs sent to screen printers (with status: queued → at_printer → returned)
- **admin_users**: team members with RLS-controlled access

Scale: ~6,700 orders/season, multiple admin roles, state-wide distribution.

---

## Critical Learnings Application

### 1. **CRITICAL: Foreign Key Integrity — meet_name as Coupling Point**

**Source:** `docs/solutions/logic-errors/output-name-meet-name-must-match.md`

**How It Applies:**

The ordering system uses `meet_name` as a foreign key in multiple critical tables:
- `shirt_backs(meet_name)` — defines which backs exist for a meet
- `order_items(meet_name)` — denormalizes to ensure athlete's meet is available for order lookup
- `athlete_tokens(meet_name)` — required for QR code generation and celebration page routing

In the Electron app, `meet_name` comes from extracted meet data and flows through `set_output_name` → `build_database` → `finalize_meet` → Supabase publication.

**The Danger:**

If `meet_name` values are inconsistent across the publishing pipeline (e.g., "MS State Gymnastics 2026" published to Supabase, but order lookup uses "Mississippi State Gymnastics 2026"), the FK relationships break silently:
- `order_items` insert references a `meet_name` that doesn't exist in `shirt_backs`
- Queries `JOIN order_items oi ON oi.back_id = sb.id WHERE oi.meet_name = $1` return no results
- Athletes can place orders for non-existent shirt designs, or order forms fail to render

**Plan Requirement:**

Add to the ordering system architecture:
1. **Validation gate** before any order can reference a `meet_name`: verify that `shirt_backs` rows exist for that meet with the exact same meet_name string
2. **Normalization step** in the Electron app: before publishing to Supabase, confirm that `context.outputName` == the value being written as `meet_name` in the central DB publish step
3. **Runtime check** in order creation: `backend/lib/validate-meet-reference.ts` should raise an error if attempting to create `order_items` for a `meet_name` with no corresponding `shirt_backs` rows
4. **Database constraint** (optional but recommended): consider adding a `FOREIGN KEY (meet_name) REFERENCES shirt_backs(meet_name)` or, more pragmatically, add an index `idx_shirt_backs_meet_name` and a pre-insert trigger that validates the meet exists

**Code Pattern to Follow:**
```sql
-- In order_items creation, validate before insert:
-- SELECT 1 FROM shirt_backs WHERE meet_name = $1 LIMIT 1
-- If not found, raise error: "Cannot order for meet_name that has no shirt designs"
```

**Why This Matters:**
In the current Electron app, a mismatch silently splits output across folders. In the ordering system, a mismatch silently breaks the entire order-to-printer pipeline. Orders get created, charges succeed, but order_items can't join to shirt_backs to fetch designs, and the admin dashboard shows incomplete batches.

---

### 2. **CRITICAL: Order Status Flags Must Be Persisted & Guarded**

**Source:** `docs/solutions/logic-errors/persist-destructive-operation-guards.md`

**How It Applies:**

The ordering system has destructive state transitions that must be irreversible once triggered:
- **paid_at / paid status**: Once an order is marked paid, `refund` is the only valid reverse action
- **easypost_shipment_id**: Once assigned, changing it corrupts EasyPost tracking
- **shipped_at**: Once set, the order moves to "shipped" and cannot be re-queued to printer batches
- **printer_batch_id**: Once an order_item is assigned to a batch, it cannot be moved to a different batch (batches are atomic units sent to printers)

**The Danger:**

If admin dashboard session state holds "allow_refund" or "batch_locked" flags but doesn't persist them:
1. Admin clicks "Issue Refund" on an order (sets flag in client state, triggers refund)
2. Session expires or page reloads
3. Flag is lost
4. Another admin (or the same one, reloading) sees the order as "paid" and tries to issue a refund again (now a duplicate refund)
5. EasyPost shipment is already issued; canceling corrupts the delivery

**Plan Requirements:**

1. **Persist status transitions in database immediately**, not in session:
   ```sql
   -- Don't do this:
   -- [admin clicks refund] → sets client flag → eventually calls refund API

   -- Do this:
   -- [admin clicks refund] → immediately UPDATE orders SET status = 'refunded',
   --   refunded_at = NOW(), reason = '...' → then call Stripe + EasyPost
   ```

2. **Add idempotency keys** to destructive operations:
   ```sql
   -- If refund_idempotency_key is NOT NULL and matches incoming request,
   -- return cached response instead of attempting another refund
   ALTER TABLE orders ADD COLUMN refund_idempotency_key TEXT;
   ```

3. **Block status transitions with database constraints**:
   ```sql
   -- Shipping can only be initiated from 'paid' status
   -- UPDATE orders SET status = 'processing' WHERE status = 'paid' AND ...

   -- Refund can only be issued from 'paid', 'processing', or 'shipped' status
   -- (not from 'refunded', 'cancelled', 'pending')
   ```

4. **Server-side state machine** in API handlers:
   ```typescript
   // Valid transitions:
   const VALID_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
     pending: ['paid', 'cancelled'],
     paid: ['processing', 'refunded', 'cancelled'],
     processing: ['shipped', 'refunded'],
     shipped: ['delivered', 'refunded'],
     delivered: [],
     refunded: [],
     cancelled: []
   };
   ```

**Why This Matters:**
With 6,700+ orders/season and multiple admins, race conditions on destructive operations are certain, not possible. Status flags must flow through the database, not browser memory.

---

### 3. **HIGH: Sticky Admin Filters Can Silently Corrupt Orders**

**Source:** `docs/solutions/logic-errors/sticky-params-silently-exclude-athletes.md`

**How It Applies:**

The admin dashboard has filters that persist across sessions:
- **State filter** (e.g., "show only MS orders")
- **Status filter** (e.g., "show only pending orders")
- **Screen printer filter** (e.g., "show only Printer 2 batches")

These are valuable for admin workflow — when someone logs out and back in, they want their view restored.

**BUT**, the Electron app learned the hard way: if a filter is saved for a destructive purpose (e.g., "exclude all Xcel levels from shirt"), and it's automatically restored, subsequent operations silently apply the filter even when unintended.

**The Danger:**

1. Admin sets filter: "Status = pending" (to work on new orders)
2. Filter is saved to browser localStorage or session
3. Admin logs out
4. Next day, admin logs back in
5. Filter silently restored: "show only pending"
6. Admin goes to "Printer Batches" page
7. Admin sees only pending batches (correct)
8. Admin creates a new batch, selects backs → **only selects backs from pending orders**, missing paid orders
9. Batch is sent to printer with incomplete backs

**Plan Requirements:**

1. **Distinguish "view preferences" from "operational filters"**:
   - **View preferences** (STICKY): column widths, sort order, page size
   - **Operational filters** (NOT STICKY): status, state, date range, payment status
   - Rationale: View preferences affect appearance. Operational filters affect data selection in critical operations.

2. **Add explicit "Save Filter" button** for view preferences:
   ```typescript
   // Instead of auto-saving every filter change, require explicit save:
   const [filters, setFilters] = useState(DEFAULT_FILTERS);
   const [savedFilters, setSavedFilters] = useState(loadFromStorage('admin_filters'));

   const handleSaveFilter = () => {
     // Explicitly save current filters to storage + DB
     saveToStorage('admin_filters', filters);
     showToast('Filters saved');
   };
   ```

3. **Reset operational filters on page navigation**:
   ```typescript
   // When admin navigates away from Orders view, clear operational filters
   useEffect(() => {
     return () => {
       setOperationalFilters(DEFAULT_OPERATIONAL_FILTERS);
     };
   }, []);
   ```

4. **Add visual indicator of active filters**:
   - If any non-default operational filter is active, show a badge: "Filters Active (3)"
   - Clicking badge resets to defaults
   - This prevents admin from forgetting that a filter is applied

5. **Audit log** for critical operations:
   ```typescript
   // Log every printer batch creation with the filters that were active
   INSERT INTO audit_logs (action, user_id, filters, timestamp, result)
   VALUES ('create_printer_batch', $1, json($2), NOW(), ...);
   ```

**Why This Matters:**
Silent data loss in the ordering pipeline means screen printer receives incomplete batches, customers don't get shirts, refunds get issued. The sticky params lesson is directly transferable: destructive filters must NEVER auto-restore.

---

### 4. **HIGH: Stale Data Cleanup Must Happen Proactively**

**Source:** `docs/solutions/logic-errors/stale-extract-files-cause-data-bloat.md`

**How It Applies:**

The ordering system will accumulate various transient artifacts:
- **Temporary order PDFs** (receipt, packing slip) — many versions as admin regenerates
- **QR code images** for athlete_tokens — generated once, but temp versions accumulate
- **Printer batch manifests** — regenerated when batch status changes
- **Email drafts** — rendered and stored before sending, old versions kept as history

**The Danger:**

After 1 season (6,700+ orders), the Supabase Storage bucket contains:
- 20,100 temporary PDFs (3 per order × history)
- 6,700 QR code variants (multiple resizes/regenerations)
- 2,000+ batch manifests
- 50,000+ email drafts

Storage costs escalate ($0.15/GB/month), queries slow down (listing Storage files paginates), and duplicate detection breaks (can't tell which PDF is the "real" one).

**Plan Requirements:**

1. **Cleanup trigger on status transitions**:
   ```sql
   -- When order transitions from 'processing' → 'shipped', delete old temp PDFs
   CREATE TRIGGER order_shipped_cleanup
   AFTER UPDATE ON orders
   FOR EACH ROW
   WHEN (NEW.status = 'shipped' AND OLD.status = 'processing')
   BEGIN
     DELETE FROM storage.objects
     WHERE bucket_id = 'temp-pdfs'
       AND object_name LIKE 'receipts/order_' || NEW.id || '_%'
       AND created_at < NEW.updated_at - INTERVAL '1 day';
   END;
   ```

2. **Implement versioning with TTL** (time-to-live):
   ```typescript
   // When generating receipt PDF, don't keep old versions indefinitely
   const receiptPath = `receipts/order_${orderId}/v${version}.pdf`;
   // Set S3 object lifecycle rule: delete objects older than 30 days
   ```

3. **Unique naming for finalized artifacts**:
   ```typescript
   // QR codes that go to print should have a stable, content-addressed name
   // NOT versioned by timestamp
   const qrPath = `qr-codes/${athleteTokenId}/qrcode-${hashOfContent}.png`;
   ```

4. **Scheduled cleanup job** (runs nightly):
   ```typescript
   // In a background job (Vercel Cron):
   cron.schedule('0 2 * * *', async () => {
     // Delete incomplete order PDFs older than 1 week
     // Delete temp printer batch manifests older than 1 month
     // Delete email drafts that were sent (keep only final sent version)
   });
   ```

**Why This Matters:**
The Electron app's extraction files ballooned from 971 to 17,479 records after 12 runs. In the ordering system, with 6,700 orders/season and multiple regenerations per order, the bloat will be exponential. Cleanup must happen at schema design time, not as an afterthought.

---

### 5. **CRITICAL: Phase/State Synchronization Between Frontend & Backend**

**Source:** `docs/solutions/architecture-patterns/switch-phase-helper-invariant.md`

**How It Applies:**

The ordering system spans two disconnected systems:
- **Vercel Next.js frontend**: manages UI, shows orders, exposes admin dashboard
- **Electron app**: processes meets, publishes to Supabase

Admin actions trigger state changes that must be atomic and mutually agreed:
- Admin clicks "Create Printer Batch" → frontend sends API request → backend creates `printer_batch` row and updates `order_items.printer_batch_id`
- Simultaneously, Electron app publishes new meet results → adds `shirt_backs` rows that printer batch might need to include

**The Danger:**

If frontend state (e.g., "printer batch is locked, no more items can be added") and backend state (`printer_batch.status = 'at_printer'`) diverge:

1. Frontend shows printer batch as "locked" (UI disables button to add items)
2. Backend still allows item additions (no database constraint)
3. Admin refreshes page, frontend re-fetches state, sees backend is still accepting items
4. Admin clicks "Add Item" (button is now enabled because fresh fetch)
5. Item is added to batch that's already at printer
6. Printer receives incomplete instructions (batch status changed mid-assembly)

**Plan Requirements:**

1. **State must flow through database, not frontend session**:
   ```typescript
   // DON'T do this:
   // const [batchLocked, setBatchLocked] = useState(false);
   // [on mount] setBatchLocked(true);
   // [later] if (batchLocked) { disable button }

   // DO this:
   // const batch = await db.query(
   //   'SELECT status FROM printer_batches WHERE id = $1', [batchId]
   // );
   // const isLocked = batch.status === 'at_printer' || batch.status === 'returned';
   // if (isLocked) { disable button }
   ```

2. **Use database-side constraints, not logic gates**:
   ```sql
   -- Foreign key prevents orphaned order_items
   ALTER TABLE order_items ADD CONSTRAINT fk_batch_valid
   FOREIGN KEY (printer_batch_id) REFERENCES printer_batches(id);

   -- Check constraint prevents adding to locked batches
   CREATE FUNCTION validate_batch_not_locked() RETURNS TRIGGER AS $$
   BEGIN
     IF NEW.printer_batch_id IS NOT NULL THEN
       IF EXISTS (
         SELECT 1 FROM printer_batches
         WHERE id = NEW.printer_batch_id
           AND status IN ('at_printer', 'returned')
       ) THEN
         RAISE EXCEPTION 'Cannot add items to locked batch';
       END IF;
     END IF;
     RETURN NEW;
   END;
   $$ LANGUAGE plpgsql;
   ```

3. **Implement atomic transitions with stored procedures**:
   ```sql
   CREATE FUNCTION create_printer_batch_with_items(
     batch_name TEXT,
     back_ids BIGINT[],
     screen_printer TEXT
   ) RETURNS printer_batches AS $$
   DECLARE
     new_batch printer_batches;
   BEGIN
     INSERT INTO printer_batches (batch_name, screen_printer, status)
     VALUES (batch_name, screen_printer, 'queued')
     RETURNING * INTO new_batch;

     -- Add all items atomically
     INSERT INTO printer_batch_backs (batch_id, back_id, shirt_count)
     SELECT new_batch.id, unnest(back_ids), 0;

     RETURN new_batch;
   END;
   $$ LANGUAGE plpgsql;
   ```

4. **Optimize for Optimistic UI** but validate on server:
   ```typescript
   // Frontend can show optimistic update immediately:
   // [Admin clicks "Add Item" → UI shows item in batch]
   // But server must still validate:
   // [POST /api/batch/${id}/add-item]
   //   → Check batch.status is NOT 'at_printer' or 'returned'
   //   → If locked, reject with 409 Conflict
   //   → Frontend reverts optimistic update, shows error
   ```

**Why This Matters:**
With multiple admins and automated processes (Electron app publishing meets), state can diverge in seconds. Unlike the Electron app (single-user), the ordering system is multi-user and multi-process. Invariants must be enforced at the database layer.

---

### 6. **HIGH: Regeneration Must Not Silently Lose User Customizations**

**Source:** `docs/solutions/logic-errors/level-groups-must-be-sticky.md`

**How It Applies:**

The ordering system allows admin customization of shirt design groupings:
- Admin can specify: "Xcel on page 1, Levels 2-10 on page 2" (custom `level_groups`)
- Admin can specify: "Use 8.5x11 legal size" (custom `page_size_legal`)
- Admin can adjust: fonts, spacing, colors for back designs

Any regeneration of the PDF (to fix a typo, adjust dates, add missing athlete) must preserve these customizations unless explicitly told to reset.

**The Danger:**

Current Electron app problem: `level_groups` was excluded from sticky params with the reasoning "destructive filters must never auto-apply." But in practice:

1. Admin sets custom grouping: "Xcel only" (2 pages)
2. Admin regenerates to fix a typo in a level name
3. Grouping reverts to default algorithm (4 pages)
4. Admin doesn't notice until shirt is sent to printer
5. Printer receives different design than what was approved

**Plan Requirements:**

1. **Distinguish between "destructive" and "user-customized"**:
   - **Destructive** (never auto-apply): exclude-levels (filters athletes out entirely)
   - **User-customized** (always sticky): level_groups, page_size (affects layout, not data)
   - Rationale: If regenerating for an unrelated reason (fixing typos), user customizations should persist. Destructive filters should require explicit re-confirmation.

2. **Implement `--regenerate` flag that preserves customizations**:
   ```typescript
   // When admin regenerates to fix a typo:
   // [API POST] /api/batch/${id}/regenerate-pdf
   // {
   //   "changes": { "dates": "...", "athlete_name_correction": "..." },
   //   "preserveCustomizations": true  // DEFAULT = TRUE
   // }
   ```

3. **Implement `--force` flag that clears all customizations**:
   ```typescript
   // When admin wants to start fresh:
   // [API POST] /api/batch/${id}/regenerate-pdf?force=true
   // This clears level_groups, page_size, custom fonts, colors, etc.
   ```

4. **Store customizations separately from transient data**:
   ```sql
   ALTER TABLE shirt_backs ADD COLUMN customizations JSONB DEFAULT NULL;
   -- customizations = {
   --   "level_groups": ["Xcel", "Levels 2-10"],
   --   "page_size": "legal",
   --   "font_family": "Arial",
   --   "line_spacing": 1.2
   // }

   -- When regenerating PDF:
   SELECT customizations FROM shirt_backs WHERE id = $1
   -- If customizations exists and NOT force=true, apply them
   ```

5. **Audit trail for customization changes**:
   ```sql
   ALTER TABLE shirt_backs ADD COLUMN last_customized_by UUID REFERENCES admin_users(id);
   ALTER TABLE shirt_backs ADD COLUMN last_customized_at TIMESTAMPTZ;

   -- Log every customization change for admin review
   INSERT INTO audit_logs (action, user_id, resource_id, old_value, new_value)
   VALUES ('customize_shirt_back', $1, $2, $3, $4);
   ```

**Why This Matters:**
In the current Electron app, reverting customizations is annoying. In the ordering system, it's a production issue: screen printer receives different designs than what was approved, leading to reprinting costs and schedule delays.

---

### 7. **MEDIUM: Budget Model Stress Testing for Webhook Handlers**

**Source:** `docs/solutions/architecture-patterns/budget-model-stress-testing.md`

**How It Applies:**

The ordering system has critical webhook handlers (from Stripe and EasyPost) that must be bulletproof. If Claude Sonnet can reason around an architectural gap, a webhook misfiring or retry could exploit that gap.

**Key Webhook Scenarios:**

1. **Stripe Payment Intent Succeeded**
   - Update `orders.status = 'paid'`, `orders.paid_at = NOW()`
   - Trigger email: "Payment received"
   - Queue background job: "prepare for printer"

2. **Stripe Charge Refunded**
   - Update `orders.status = 'refunded'`, `orders.refunded_at = NOW()`
   - Trigger email: "Refund processed"
   - Dequeue from printer batch if not yet at printer

3. **EasyPost Shipment Delivered**
   - Update `orders.status = 'delivered'`, `orders.delivered_at = NOW()`
   - Trigger email: "Your order arrived"

**The Danger:**

If webhook handler logic relies on smart inference:
- "If order.paid_at is NULL, it must be pending" → fails on race condition (status set to paid, but API handler hasn't called webhook yet)
- "If printer_batch.status is 'queued', I can add items" → fails if batch status changed between UI fetch and POST
- "Email the customer when status changes" → sends duplicate email on webhook retry

**Plan Requirements:**

1. **Implement idempotency for all webhook handlers**:
   ```typescript
   // Stripe includes idempotency_key in webhook headers
   // Store processed keys to deduplicate retries
   const webhook_events = await db.query(
     'SELECT * FROM webhook_events WHERE event_id = $1',
     [event.id]
   );

   if (webhook_events.rows.length > 0) {
     // Already processed, return 200 (acknowledge receipt)
     return res.status(200).json({ received: true });
   }

   // Process webhook
   // ...

   // Record that we processed it
   await db.query(
     'INSERT INTO webhook_events (event_id, event_type, processed_at) VALUES ($1, $2, NOW())',
     [event.id, event.type]
   );
   ```

2. **Use database constraints to prevent invalid transitions**:
   ```sql
   -- Stripe can only emit "paid" webhook if order.status is 'pending'
   CREATE FUNCTION handle_stripe_payment_succeeded() RETURNS TRIGGER AS $$
   BEGIN
     IF NEW.status != 'pending' THEN
       RAISE EXCEPTION 'Cannot mark order as paid unless status is pending';
     END IF;
     RETURN NEW;
   END;
   $$;
   ```

3. **Add event log for all state changes**:
   ```sql
   CREATE TABLE order_events (
     id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     order_id BIGINT NOT NULL REFERENCES orders(id),
     event_type TEXT NOT NULL,  -- 'stripe_payment_succeeded', 'refund_issued', etc.
     prev_status TEXT,
     new_status TEXT,
     triggered_at TIMESTAMPTZ DEFAULT NOW(),
     UNIQUE(order_id, event_type, triggered_at)
   );
   ```

4. **Test with budget models after changes**:
   - After modifying webhook handlers, simulate behavior with `deepseek/deepseek-v3.2` or `qwen/qwen3-coder`
   - If budget model fails to understand idempotency or state constraints, architecture has a gap
   - Fix the gap, don't add more prompting

**Why This Matters:**
Stripe webhooks retry on 4xx/5xx responses. If handler logic assumes "this is the first time this event is being processed," retries can double-charge, send duplicate emails, or leave orders in inconsistent states. The architecture must be intrinsically idempotent.

---

## Summary: What the Plan Should Address

| Learning | Requirement | Status |
|----------|-----------|--------|
| **Foreign Key Integrity** | Validate meet_name before order_items creation; sync Electron app naming | CRITICAL ADD |
| **Persist Destructive Flags** | Order status transitions via DB; idempotency keys; state machine constraints | CRITICAL ADD |
| **Sticky Admin Filters** | Distinguish view prefs from operational filters; explicit save; clear on navigation | HIGH ADD |
| **Stale Data Cleanup** | TTL on Storage objects; scheduled cleanup; versioning strategy | HIGH ADD |
| **Phase Sync (Frontend/Backend)** | State flows through DB, not session; database constraints enforce invariants | CRITICAL ADD |
| **Preserve Customizations** | Separate customizations from transient data; --force flag for reset | HIGH ADD |
| **Webhook Idempotency** | Store processed event IDs; guard state transitions; event log | MEDIUM ADD |

---

## Immediate Actions

1. **Before schema finalization**: Add `meet_name` validation function and document the exact naming convention inherited from Electron app
2. **In API design**: Document status machine as a diagram (state graph), list valid transitions
3. **In RLS policies**: Ensure `admin_users.role` gates access to sensitive operations (refunds, batch status changes)
4. **In documentation**: Create a "Destructive Operations Checklist" for admin UX design (idempotency, confirmation dialogs, audit logs)
5. **In testing**: Add integration tests that verify state transitions are atomic and backwards-compatible with webhook retries

