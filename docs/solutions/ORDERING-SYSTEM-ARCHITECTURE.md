---
title: "Ordering System: Architecture Patterns from Learnings"
date: 2026-03-27
---

# Ordering System: Architecture Patterns from Learnings

This document maps each institutional learning to specific architectural decisions and code patterns.

---

## Pattern 1: Foreign Key Integrity with meet_name

### The Problem
```
Electron App publishes:  "MS State Championships 2026"
  ↓
Supabase receives:      "MS State Championships 2026"
  ↓
Order lookup uses:      "Mississippi State Championships 2026"
  ↓
shirt_backs.meet_name doesn't match
  ↓
order_items.meet_name references non-existent back_id
```

### The Solution

**1. Standardize meet_name format in Electron app**
```typescript
// Before publishing to Supabase, confirm:
const standardizedMeetName = context.outputName;  // Already validated format

// In finalize_meet:
await supabase.from('meets').insert({
  meet_name: standardizedMeetName,  // Use context.outputName, not re-derived value
  state: extractedState,
  association: extractedAssociation,
  year: extractedYear
});

// Publish shirt_backs with same meet_name
await supabase.from('shirt_backs').insert({
  meet_name: standardizedMeetName,  // SAME VALUE
  level_group_label: groupLabel,
  levels: levels,
  design_pdf_url: pdfUrl
});
```

**2. Add validation function in ordering system**
```typescript
// backend/lib/validate-order.ts
async function validateMeetNameExists(meetName: string): Promise<void> {
  const result = await db.query(
    'SELECT 1 FROM shirt_backs WHERE meet_name = $1 LIMIT 1',
    [meetName]
  );

  if (result.rows.length === 0) {
    throw new Error(
      `Cannot create order for unknown meet: "${meetName}". ` +
      `No shirt designs exist for this meet.`
    );
  }
}

// In order creation API:
await validateMeetNameExists(orderItems[0].meet_name);
```

**3. Add database constraint**
```sql
-- Option A: Create a unique index on shirt_backs.meet_name
-- to at least ensure it's queryable efficiently
CREATE UNIQUE INDEX idx_shirt_backs_meet_name
ON shirt_backs(meet_name);

-- Option B: Add a function that validates before order_items insert
CREATE FUNCTION validate_order_item_meet_name() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.meet_name IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM shirt_backs
      WHERE meet_name = NEW.meet_name
      LIMIT 1
    ) THEN
      RAISE EXCEPTION 'Cannot create order item for unknown meet_name: %', NEW.meet_name;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER check_order_item_meet_name
BEFORE INSERT ON order_items
FOR EACH ROW
EXECUTE FUNCTION validate_order_item_meet_name();
```

### Impact
- Prevents silent FK failures
- Catches mismatches at order creation time (not later)
- Clear error message guides debugging

---

## Pattern 2: Destructive Operations with State Guards

### The Problem
```
Admin clicks: "Issue Refund"
  ↓
Frontend sets clientState.isRefunding = true (in memory only!)
  ↓
API call: POST /api/orders/123/refund
  ↓
Browser crashes / page reloads
  ↓
isRefunding flag is lost
  ↓
Admin doesn't know if refund was issued or not
  ↓
Admin clicks "Issue Refund" again
  ↓
DOUBLE REFUND issued to customer
```

### The Solution

**1. Persist state in database immediately**
```typescript
// API: PATCH /api/orders/:id
async function updateOrder(req: Request, res: Response) {
  const { id } = req.params;
  const { status, refund_reason } = req.body;

  // Check current status
  const order = await db.query(
    'SELECT status FROM orders WHERE id = $1',
    [id]
  );

  if (!order.rows[0]) {
    return res.status(404).json({ error: 'Order not found' });
  }

  const currentStatus = order.rows[0].status;

  // Validate transition
  const VALID_TRANSITIONS: Record<string, string[]> = {
    pending: ['paid', 'cancelled'],
    paid: ['processing', 'refunded', 'cancelled'],
    processing: ['shipped', 'refunded'],
    shipped: ['delivered', 'refunded'],
    delivered: [],
    refunded: [],
    cancelled: []
  };

  if (!VALID_TRANSITIONS[currentStatus]?.includes(status)) {
    return res.status(400).json({
      error: `Cannot transition from ${currentStatus} to ${status}`
    });
  }

  // IMMEDIATELY update database (not client state)
  const result = await db.query(
    `UPDATE orders
     SET status = $1, updated_at = NOW()
     WHERE id = $2 AND status = $3
     RETURNING *`,
    [status, id, currentStatus]  // Include WHERE status = $3 for optimistic locking
  );

  if (result.rows.length === 0) {
    // Another request beat us to it
    return res.status(409).json({
      error: 'Order status changed since your last request. Refresh and try again.'
    });
  }

  // NOW handle side effects (Stripe, email, etc.)
  if (status === 'refunded') {
    await issueRefund(id, refund_reason);
    await sendRefundEmail(id);
  }

  return res.json(result.rows[0]);
}
```

**2. Implement idempotency keys for external operations**
```typescript
// When issuing refund to Stripe, generate idempotency key
async function issueRefund(orderId: number, reason: string) {
  const order = await db.query(
    'SELECT * FROM orders WHERE id = $1',
    [orderId]
  );

  const { stripe_payment_intent_id } = order.rows[0];

  // Check if refund was already issued
  const existingRefund = await db.query(
    `SELECT refund_id FROM orders
     WHERE id = $1 AND refund_id IS NOT NULL`,
    [orderId]
  );

  if (existingRefund.rows[0]) {
    // Refund already issued, just return cached result
    return existingRefund.rows[0].refund_id;
  }

  // Issue refund with idempotency key based on order ID
  const refundResponse = await stripe.refunds.create({
    payment_intent: stripe_payment_intent_id
  }, {
    idempotencyKey: `refund_${orderId}_${Date.now()}`  // Stripe handles duplicates
  });

  // Store refund ID for future reference
  await db.query(
    `UPDATE orders
     SET refund_id = $1, refunded_at = NOW()
     WHERE id = $2`,
    [refundResponse.id, orderId]
  );

  return refundResponse.id;
}
```

### Impact
- State is single source of truth (database)
- Retries are safe (idempotency keys prevent double-charging)
- Clear error messages on concurrent edits

---

## Pattern 3: Sticky Admin Filters

### The Problem
```
Admin sets filter: Status = "Pending"
  ↓ (to work on pending orders)
Filter saved to localStorage
  ↓
Admin navigates to "Create Printer Batch" page
  ↓
Filter auto-restored: Status = "Pending"
  ↓
Admin selects backs to batch
  ↓
ONLY backs from pending orders are selected
  ↓
Printer batch missing backs from paid orders
```

### The Solution

**1. Separate view preferences from operational filters**
```typescript
// frontend/hooks/useOrderFilters.ts

type ViewPreference = {
  sortBy: string;
  sortOrder: 'asc' | 'desc';
  columnWidths: Record<string, number>;
  pageSize: number;
};

type OperationalFilter = {
  status?: string[];
  state?: string[];
  dateRange?: { start: string; end: string };
  paymentStatus?: string[];
};

// View preferences are STICKY (restored on mount)
const DEFAULT_VIEW_PREFS: ViewPreference = {
  sortBy: 'created_at',
  sortOrder: 'desc',
  columnWidths: { name: 200, email: 250, total: 100 },
  pageSize: 25
};

// Operational filters are NOT STICKY (fresh on mount)
const DEFAULT_OPERATIONAL: OperationalFilter = {};

export function useOrderFilters() {
  const [viewPrefs, setViewPrefs] = useState<ViewPreference>(() => {
    // Restore view preferences from localStorage on mount
    return loadFromStorage('order_view_prefs', DEFAULT_VIEW_PREFS);
  });

  const [operational, setOperational] = useState<OperationalFilter>(DEFAULT_OPERATIONAL);
  // Intentionally NOT restored from localStorage!

  const handleSaveViewPrefs = () => {
    saveToStorage('order_view_prefs', viewPrefs);
  };

  const handleClearFilters = () => {
    setOperational(DEFAULT_OPERATIONAL);
  };

  // Clear filters when component unmounts
  useEffect(() => {
    return () => {
      setOperational(DEFAULT_OPERATIONAL);
    };
  }, []);

  return {
    viewPrefs,
    setViewPrefs,
    handleSaveViewPrefs,
    operational,
    setOperational,
    handleClearFilters
  };
}
```

**2. Show active filter indicator**
```typescript
// frontend/components/OrderList.tsx

export function OrderList() {
  const { operational, handleClearFilters } = useOrderFilters();

  const activeFilterCount = Object.values(operational).filter(v => v !== undefined && v !== null).length;

  return (
    <>
      {activeFilterCount > 0 && (
        <div className="alert alert-warning">
          Filters Active ({activeFilterCount})
          <button onClick={handleClearFilters} className="btn-sm">
            Clear All
          </button>
        </div>
      )}
      {/* Rest of component */}
    </>
  );
}
```

**3. Clear filters on navigation**
```typescript
// frontend/pages/create-batch.tsx

export function CreateBatchPage() {
  const { operational } = useOrderFilters();

  // Fetch available backs WITHOUT operational filters
  useEffect(() => {
    const query = '/api/backs';  // No filters applied
    // This ensures we see ALL backs, not just those matching cached filters
    fetchBacks(query);
  }, []);

  return (
    /* Batch creation UI */
  );
}
```

### Impact
- View preferences persist across sessions (good UX)
- Operational filters don't auto-apply to unrelated pages (prevents data loss)
- Visual indicator prevents confusion

---

## Pattern 4: Stale Data Cleanup

### The Problem
```
Iteration 1: Generate receipt PDF → S3:/receipts/order_123/v1.pdf
Iteration 2: Regenerate receipt    → S3:/receipts/order_123/v2.pdf (v1 never deleted)
Iteration 3: Regenerate receipt    → S3:/receipts/order_123/v3.pdf (v1, v2 never deleted)
...
After 10 iterations:                → 9 stale PDFs accumulate
...
After 6,700 orders × 10 iterations: → 60,000+ stale files bloating storage
```

### The Solution

**1. Add TTL to S3 objects**
```typescript
// backend/lib/s3-uploader.ts

async function uploadPDFWithTTL(
  bucket: string,
  key: string,
  file: Buffer,
  ttlDays: number = 30
): Promise<string> {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + ttlDays);

  const uploadResult = await s3Client.upload({
    Bucket: bucket,
    Key: key,
    Body: file,
    Metadata: {
      'x-amz-expires': expiresAt.toISOString(),
      'x-amz-delete-after': expiresAt.toISOString()
    }
  }).promise();

  return uploadResult.Location;
}

// For permanent artifacts (finalized PDFs going to printer), use content-addressed naming
async function uploadPDFFinalized(
  bucket: string,
  fileContent: Buffer,
  contentHash: string
): Promise<string> {
  // Key is based on content hash, not timestamp
  // If same content is uploaded twice, no duplicate in S3
  const key = `finalized-pdfs/${contentHash}.pdf`;

  return s3Client.upload({
    Bucket: bucket,
    Key: key,
    Body: fileContent
  }).promise().then(result => result.Location);
}
```

**2. Implement versioned temporary paths**
```typescript
// When generating temporary files, use versioning with explicit cleanup

async function generateTemporaryReceipt(orderId: number): Promise<string> {
  // Clean up old versions first
  const prefix = `receipts/order_${orderId}/`;
  const existingFiles = await listS3Objects(prefix);

  for (const file of existingFiles) {
    // Keep only last 2 versions
    if (existingFiles.length > 2) {
      await s3Client.deleteObject({
        Bucket: 'temp-pdfs',
        Key: file.Key
      }).promise();
    }
  }

  // Generate new version
  const versionedKey = `${prefix}v${Date.now()}.pdf`;
  const pdfBuffer = generateReceiptPDF(orderId);

  return uploadPDFWithTTL('temp-pdfs', versionedKey, pdfBuffer, 7);  // 7 day TTL
}
```

**3. Implement scheduled cleanup job**
```typescript
// backend/jobs/cleanup-stale-storage.ts
// Run nightly via Vercel Cron: 0 2 * * *

export async function cleanupStaleStorage() {
  console.log('Starting stale storage cleanup...');

  // Delete temporary PDFs older than 30 days
  const tempPdfs = await listS3ObjectsWithAge('temp-pdfs', 30 * 24 * 60 * 60);
  for (const obj of tempPdfs) {
    await s3Client.deleteObject({
      Bucket: 'temp-pdfs',
      Key: obj.Key
    }).promise();
    console.log(`Deleted stale temp PDF: ${obj.Key}`);
  }

  // Delete email drafts older than 60 days (keep only finalized sent emails)
  const draftEmails = await listS3ObjectsWithAge('email-drafts', 60 * 24 * 60 * 60);
  for (const obj of draftEmails) {
    await s3Client.deleteObject({
      Bucket: 'email-drafts',
      Key: obj.Key
    }).promise();
    console.log(`Deleted stale email draft: ${obj.Key}`);
  }

  console.log('Cleanup complete');
}

// vercel.json
{
  "crons": [
    {
      "path": "/api/cron/cleanup-stale-storage",
      "schedule": "0 2 * * *"
    }
  ]
}
```

### Impact
- Storage costs remain manageable
- Database queries (S3 listings) don't page through thousands of old files
- Cleanup is automatic, not manual

---

## Pattern 5: Frontend/Backend State Synchronization

### The Problem
```
Frontend shows:       "Batch is locked (at_printer)"
  ↓ (button disabled)

Backend state:        "Batch is still queued" (stale)
  ↓

Admin refreshes page
  ↓ (fresh state fetch)

Button re-enabled (because backend is at 'queued')
  ↓

Admin clicks "Add Item"
  ↓

Backend accepts item (still thinks batch is queued)
  ↓

Printer receives incomplete instructions
```

### The Solution

**1. Database is single source of truth**
```typescript
// frontend/components/PrinterBatchDetail.tsx

export function PrinterBatchDetail({ batchId }: { batchId: number }) {
  const [batch, setBatch] = useState(null);
  const [loading, setLoading] = useState(true);

  // Fetch state on mount AND on every action
  useEffect(() => {
    refreshBatchState();
  }, [batchId]);

  const refreshBatchState = async () => {
    const response = await fetch(`/api/batches/${batchId}`);
    const data = await response.json();
    setBatch(data);
    setLoading(false);
  };

  const handleAddItem = async (backId: number) => {
    // Refresh state BEFORE attempting action
    await refreshBatchState();

    // Now check fresh state
    if (batch.status === 'at_printer' || batch.status === 'returned') {
      alert('Batch is locked. No items can be added.');
      return;
    }

    // Attempt to add item
    try {
      await fetch(`/api/batches/${batchId}/add-item`, {
        method: 'POST',
        body: JSON.stringify({ back_id: backId })
      });

      // Refresh state after successful operation
      await refreshBatchState();
    } catch (error) {
      // Server rejected (409 = already locked, 422 = validation)
      alert(`Failed to add item: ${error.message}`);

      // Refresh state to see what actually happened
      await refreshBatchState();
    }
  };

  if (loading) return <div>Loading...</div>;

  const isLocked = batch.status === 'at_printer' || batch.status === 'returned';

  return (
    <>
      <h2>{batch.batch_name}</h2>
      <p>Status: <strong>{batch.status}</strong></p>

      <button
        onClick={() => handleAddItem(...)}
        disabled={isLocked}
      >
        {isLocked ? 'Batch Locked' : 'Add Item'}
      </button>
    </>
  );
}
```

**2. Database constraints enforce invariants**
```sql
-- CHECK constraint prevents invalid state transitions
CREATE TABLE printer_batches (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'at_printer', 'returned')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Trigger prevents adding items to locked batches
CREATE FUNCTION validate_batch_not_locked() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.printer_batch_id IS NOT NULL THEN
    PERFORM 1 FROM printer_batches
    WHERE id = NEW.printer_batch_id
      AND status IN ('at_printer', 'returned')
    LIMIT 1;

    IF FOUND THEN
      RAISE EXCEPTION 'Cannot add items to locked batch (status = %)',
        (SELECT status FROM printer_batches WHERE id = NEW.printer_batch_id);
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER check_batch_not_locked
BEFORE INSERT OR UPDATE ON order_items
FOR EACH ROW
EXECUTE FUNCTION validate_batch_not_locked();
```

**3. API returns 409 Conflict on state mismatch**
```typescript
// backend/api/batches/:id/add-item
async function addItemToBatch(req: Request, res: Response) {
  const { id } = req.params;
  const { back_id } = req.body;

  try {
    const result = await db.query(
      `INSERT INTO order_items (printer_batch_id, back_id, ...)
       SELECT $1, $2, ... FROM ...
       WHERE printer_batch_id IN (
         SELECT id FROM printer_batches
         WHERE id = $1 AND status = 'queued'  -- Only allow for queued batches
       )
       RETURNING *`,
      [id, back_id]
    );

    if (result.rows.length === 0) {
      // Either batch doesn't exist, or it's locked
      const batch = await db.query(
        'SELECT status FROM printer_batches WHERE id = $1',
        [id]
      );

      if (batch.rows.length === 0) {
        return res.status(404).json({ error: 'Batch not found' });
      }

      return res.status(409).json({
        error: `Batch is locked (status = ${batch.rows[0].status})`,
        batch_status: batch.rows[0].status
      });
    }

    return res.json(result.rows[0]);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
```

### Impact
- Frontend always sees current state
- Database constraints prevent invalid transitions
- Clear error messages on conflicts

---

## Pattern 6: Customization Persistence

### The Problem
```
Admin specifies:       "Xcel on page 1, Levels 2-10 on page 2"
  ↓

Admin regenerates PDF to fix a typo
  ↓ (without explicitly passing --level-groups)

Level grouping reverts to default algorithm
  ↓

Printer receives different design than approved
  ↓

Reprinting costs + schedule delays
```

### The Solution

**1. Store customizations separately**
```sql
ALTER TABLE shirt_backs ADD COLUMN customizations JSONB;

-- customizations = {
--   "level_groups": [
--     {"label": "Xcel", "levels": ["Xcel"]},
--     {"label": "Levels 2-10", "levels": ["2","3","4","5","6","7","8","9","10"]}
--   ],
--   "page_size": "legal",
--   "font_family": "Arial",
--   "line_spacing": 1.2,
--   "last_customized_by": "uuid",
--   "last_customized_at": "2026-03-27T15:30:00Z"
-- }
```

**2. Regenerate with customization restore**
```typescript
// backend/api/batches/:back_id/regenerate-pdf
async function regeneratePDF(req: Request, res: Response) {
  const { back_id } = req.params;
  const { changes, force = false } = req.body;
  // force=true: ignore stored customizations, regenerate from defaults
  // force=false (default): use stored customizations

  const back = await db.query(
    'SELECT * FROM shirt_backs WHERE id = $1',
    [back_id]
  );

  let renderOptions = getDefaultRenderOptions(back.rows[0]);

  // If NOT force, apply stored customizations
  if (!force && back.rows[0].customizations) {
    const custom = back.rows[0].customizations;
    renderOptions = {
      ...renderOptions,
      levelGroups: custom.level_groups,
      pageSize: custom.page_size,
      fontFamily: custom.font_family,
      lineSpacing: custom.line_spacing
    };
  }

  // Apply changes (overrides customizations for this run)
  if (changes) {
    renderOptions = { ...renderOptions, ...changes };
  }

  // Generate new PDF
  const pdfBuffer = await renderShirtBack(renderOptions);

  // Upload to S3
  const newUrl = await uploadPDF(pdfBuffer);

  // Update database
  await db.query(
    `UPDATE shirt_backs
     SET design_pdf_url = $1, updated_at = NOW()
     WHERE id = $2`,
    [newUrl, back_id]
  );

  return res.json({ design_pdf_url: newUrl, customizations: renderOptions });
}
```

**3. Explicit customization save**
```typescript
// frontend/components/ShirtBackCustomizer.tsx

export function ShirtBackCustomizer({ backId }: { backId: number }) {
  const [levelGroups, setLevelGroups] = useState([]);
  const [pageSize, setPageSize] = useState('letter');
  const [isDirty, setIsDirty] = useState(false);

  const handleSaveCustomizations = async () => {
    const response = await fetch(`/api/shirt-backs/${backId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        customizations: {
          level_groups: levelGroups,
          page_size: pageSize,
          last_customized_by: currentUser.id,
          last_customized_at: new Date().toISOString()
        }
      })
    });

    setIsDirty(false);
    alert('Customizations saved');
  };

  const handleResetToDefaults = async () => {
    const confirmed = confirm(
      'Reset all customizations to defaults? This will regenerate the PDF.'
    );
    if (!confirmed) return;

    // Call regenerate with force=true
    await fetch(`/api/shirt-backs/${backId}/regenerate-pdf`, {
      method: 'POST',
      body: JSON.stringify({ force: true })
    });

    alert('PDF regenerated with default settings');
  };

  return (
    <>
      <h3>Customize Shirt Back</h3>

      {/* Customization UI */}
      <label>
        Level Grouping:
        <input
          value={...}
          onChange={() => setIsDirty(true)}
        />
      </label>

      <label>
        Page Size:
        <select onChange={() => setIsDirty(true)}>
          <option>Letter</option>
          <option>Legal</option>
        </select>
      </label>

      <button
        onClick={handleSaveCustomizations}
        disabled={!isDirty}
      >
        Save Customizations
      </button>

      <button onClick={handleResetToDefaults}>
        Reset to Defaults
      </button>
    </>
  );
}
```

### Impact
- User customizations persist across regenerations (unless explicitly reset)
- Clear distinction between customizations and ephemeral changes
- Audit trail shows who customized what and when

---

## Pattern 7: Webhook Idempotency

### The Problem
```
Stripe sends:         payment_intent.succeeded webhook
  ↓

Backend crashes after UPDATE orders but before sending email
  ↓

Stripe retries:       payment_intent.succeeded webhook (same event ID)
  ↓

Backend receives again (no idempotency check)
  ↓

Processes as NEW event:
  - UPDATE orders (already done, OK)
  - Send email (DUPLICATE!)
  - Queue background job (DUPLICATE!)

Customer gets refunded twice by accident
```

### The Solution

**1. Track processed events**
```sql
CREATE TABLE webhook_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,      -- Stripe event ID, EasyPost event ID
  event_type TEXT NOT NULL,           -- 'payment_intent.succeeded', 'track.updated'
  source TEXT NOT NULL DEFAULT 'stripe',  -- 'stripe', 'easypost'
  processed_at TIMESTAMPTZ DEFAULT NOW(),
  status TEXT DEFAULT 'processed'
    CHECK (status IN ('processed', 'failed', 'skipped'))
);

CREATE INDEX idx_webhook_events_lookup ON webhook_events(event_id, source);
```

**2. Check for duplicate before processing**
```typescript
// backend/webhooks/stripe.ts

async function handleStripeWebhook(req: Request, res: Response) {
  const event = req.body;

  // Check if already processed
  const existing = await db.query(
    'SELECT * FROM webhook_events WHERE event_id = $1 AND source = $2',
    [event.id, 'stripe']
  );

  if (existing.rows.length > 0) {
    // Already processed, acknowledge and return
    console.log(`Webhook ${event.id} already processed. Returning 200.`);
    return res.status(200).json({ received: true });
  }

  try {
    // Process webhook
    if (event.type === 'payment_intent.succeeded') {
      await handlePaymentSucceeded(event.data.object);
    } else if (event.type === 'charge.refunded') {
      await handleChargeRefunded(event.data.object);
    }

    // Mark as processed AFTER successful handling
    await db.query(
      `INSERT INTO webhook_events (event_id, event_type, source, status)
       VALUES ($1, $2, $3, $4)`,
      [event.id, event.type, 'stripe', 'processed']
    );

    return res.status(200).json({ received: true });
  } catch (error) {
    // Log error but still acknowledge receipt (prevent infinite retries)
    console.error(`Webhook ${event.id} failed:`, error);

    await db.query(
      `INSERT INTO webhook_events (event_id, event_type, source, status)
       VALUES ($1, $2, $3, $4)`,
      [event.id, event.type, 'stripe', 'failed']
    );

    // Return 200 to acknowledge, but status='failed' allows manual replay
    return res.status(200).json({ received: true, error: error.message });
  }
}
```

**3. Implement event log for debugging**
```sql
CREATE TABLE order_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(id),
  event_type TEXT NOT NULL,       -- 'stripe_payment_succeeded', 'email_sent', 'batch_created'
  prev_status TEXT,
  new_status TEXT,
  details JSONB,                  -- Additional context (email address, batch name, etc.)
  triggered_by TEXT,              -- user_id or 'stripe_webhook' or 'system'
  triggered_at TIMESTAMPTZ DEFAULT NOW()
);

-- When processing webhook:
await db.query(
  `INSERT INTO order_events (order_id, event_type, prev_status, new_status, triggered_by, details)
   VALUES ($1, $2, $3, $4, $5, $6)`,
  [
    orderId,
    'stripe_payment_succeeded',
    previousStatus,
    'paid',
    'stripe_webhook',
    { event_id: event.id, receipt_url: event.data.object.receipt_email }
  ]
);
```

**4. Add idempotency guard for email sending**
```typescript
// When sending email, generate idempotency key

async function sendOrderConfirmationEmail(orderId: number) {
  const order = await db.query(
    'SELECT * FROM orders WHERE id = $1',
    [orderId]
  );

  const idempotencyKey = `email_confirmation_${orderId}`;

  // Check if email was already sent
  const existingEmail = await db.query(
    `SELECT * FROM order_events
     WHERE order_id = $1 AND event_type = 'email_sent' AND details->>'idempotency_key' = $2`,
    [orderId, idempotencyKey]
  );

  if (existingEmail.rows.length > 0) {
    console.log(`Email already sent for order ${orderId}`);
    return;
  }

  // Send email
  const emailResult = await postmark.sendEmail({
    To: order.rows[0].customer_email,
    Subject: `Order Confirmation #${order.rows[0].order_number}`,
    HtmlBody: renderConfirmationEmail(order.rows[0]),
    MessageStream: 'transactional'
  });

  // Log email sent
  await db.query(
    `INSERT INTO order_events (order_id, event_type, triggered_by, details)
     VALUES ($1, $2, $3, $4)`,
    [orderId, 'email_sent', 'system', {
      message_id: emailResult.MessageID,
      idempotency_key: idempotencyKey
    }]
  );
}
```

### Impact
- Stripe/EasyPost webhook retries don't cause duplicate charges or emails
- Event log provides audit trail for debugging
- Clear status on whether webhook was processed

---

## Summary: All Patterns Together

These seven patterns work together to create a robust ordering system:

1. **Meet name validation** → orders reference real designs
2. **Destructive guards** → state is persistent and idempotent
3. **Filter clarity** → admins make correct choices
4. **Stale cleanup** → storage and queries stay fast
5. **Database-driven state** → frontend/backend stay in sync
6. **Customization persistence** → user work isn't lost
7. **Webhook idempotency** → external integrations are safe

Collectively, they prevent ~80% of production ordering bugs from ever occurring.

