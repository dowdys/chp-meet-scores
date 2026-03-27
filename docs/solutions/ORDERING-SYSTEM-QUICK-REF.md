---
title: "Ordering System: Quick Reference Card"
date: 2026-03-27
type: cheat-sheet
---

# Ordering System: Quick Reference Card

## The Seven Learnings at a Glance

| # | Learning | Rule of Thumb | Prevention |
|---|----------|---------------|-----------|
| 1 | **Foreign Key Integrity** | meet_name must match Electron app output exactly | Validate before order_items INSERT; add trigger |
| 2 | **Persist Destructive Flags** | State lives in DB, not browser memory | Immediate DB update; idempotency keys for Stripe/EasyPost |
| 3 | **Admin Filters** | View prefs sticky, operational filters cleared | Separate; clear on navigation; show badge |
| 4 | **Stale Cleanup** | Temp files must have TTL | Delete old versions; scheduled cleanup; content-addressed finalized files |
| 5 | **State Sync** | Database is source of truth | Fetch state before action; database constraints enforce invariants |
| 6 | **Customizations** | User work persists across regenerate | Store customizations separately; --force flag to reset |
| 7 | **Webhook Idempotency** | Same event ID = no duplicate processing | Check event ID table; mark as processed immediately |

---

## Code Patterns Quick Copy

### Pattern 1: Validate meet_name
```typescript
const exists = await db.query(
  'SELECT 1 FROM shirt_backs WHERE meet_name = $1 LIMIT 1',
  [meetName]
);
if (!exists.rows.length) throw new Error(`Unknown meet: ${meetName}`);
```

### Pattern 2: State Machine with Optimistic Locking
```typescript
const result = await db.query(
  `UPDATE orders SET status = $1 WHERE id = $2 AND status = $3 RETURNING *`,
  [newStatus, id, currentStatus]
);
if (!result.rows.length) {
  return res.status(409).json({ error: 'Status changed concurrently' });
}
```

### Pattern 3: Sticky vs. Non-Sticky Filters
```typescript
// STICKY: view preferences (restored on mount)
const [viewPrefs, setViewPrefs] = useState(() =>
  loadFromStorage('view_prefs', DEFAULT)
);

// NOT STICKY: operational filters (fresh on mount)
const [operationalFilters, setOperationalFilters] = useState(DEFAULT);
```

### Pattern 4: Clean Up on Action
```typescript
async function generateTemporaryFile(id: number) {
  // Delete old versions first
  const old = await listObjects(`temp/${id}/*`);
  for (const file of old.slice(0, -2)) {  // Keep last 2
    await deleteObject(file.Key);
  }
  // Generate new version
  return uploadWithTTL(`temp/${id}/v${Date.now()}`, buffer, 7);
}
```

### Pattern 5: Fetch State Before Action
```typescript
const handleAction = async () => {
  // Refresh current state
  const current = await fetch(`/api/resource/${id}`);
  // Check if action is still valid
  if (!isActionValid(current)) return;
  // Perform action
  const result = await performAction(id);
};
```

### Pattern 6: Separate Customizations
```sql
ALTER TABLE shirt_backs ADD COLUMN customizations JSONB;
-- On regenerate:
-- if (!force) apply customizations;
-- then apply transient changes (dates, typos)
```

### Pattern 7: Idempotency Check
```typescript
const existing = await db.query(
  'SELECT * FROM webhook_events WHERE event_id = $1',
  [event.id]
);
if (existing.rows.length > 0) {
  return res.status(200).json({ received: true });  // Already processed
}
// Process...
await db.query(
  'INSERT INTO webhook_events (event_id, ...) VALUES ($1, ...)',
  [event.id, ...]
);
```

---

## Database Constraints Checklist

Add these to schema:

```sql
-- Pattern 1: Meet name validation
CREATE FUNCTION validate_order_item_meet_name() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.meet_name IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM shirt_backs WHERE meet_name = NEW.meet_name
  ) THEN
    RAISE EXCEPTION 'Unknown meet_name: %', NEW.meet_name;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER check_order_item_meet_name BEFORE INSERT ON order_items
FOR EACH ROW EXECUTE FUNCTION validate_order_item_meet_name();

-- Pattern 5: Batch locking
CREATE FUNCTION validate_batch_not_locked() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.printer_batch_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM printer_batches
    WHERE id = NEW.printer_batch_id AND status IN ('at_printer', 'returned')
  ) THEN
    RAISE EXCEPTION 'Cannot add items to locked batch';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER check_batch_not_locked BEFORE INSERT ON order_items
FOR EACH ROW EXECUTE FUNCTION validate_batch_not_locked();
```

---

## Test Cases to Add

- [ ] Order creation with non-existent meet_name → 400 error
- [ ] Concurrent status updates → 409 on second attempt
- [ ] Webhook retry with same event ID → only processes once
- [ ] Admin filter persists across page reload → view prefs restored
- [ ] Admin filter clears on navigation → operational filters cleared
- [ ] Regenerate without --force → customizations preserved
- [ ] Regenerate with --force → customizations cleared
- [ ] Add item to locked batch → 409 error
- [ ] Issue refund twice with idempotency → single charge reversal

---

## Debugging Guide

### "Orders won't create"
1. Check: does `meet_name` exist in `shirt_backs`?
2. Check: is DB trigger `check_order_item_meet_name` firing?
3. Check: logs for FK violation

### "Duplicate refunds"
1. Check: `webhook_events` table — is event ID tracked?
2. Check: idempotency key in `orders.refund_idempotency_key`
3. Trace: did webhook handler mark event as processed?

### "Filter silently applied to wrong page"
1. Check: is operational filter being saved to localStorage?
2. Check: useEffect cleanup clearing filters?
3. Check: filter badge visible to show active filters?

### "Printer batch missing backs"
1. Check: was batch locked (status='at_printer')?
2. Check: did admin refresh and re-enable button?
3. Check: database trigger preventing inserts?

### "PDF lost customizations"
1. Check: `shirt_backs.customizations` column has data?
2. Check: was --force flag passed?
3. Check: regeneration endpoint applying customizations?

### "Storage bloated with old files"
1. Check: S3 TTL rules configured?
2. Check: scheduled cleanup job running (CloudWatch logs)?
3. Check: old versions being deleted?

---

## Production Checklist

**Before launching:**

- [ ] All 7 patterns implemented in code
- [ ] All 7 corresponding database constraints added
- [ ] All test cases passing (state machine, idempotency, filters, etc.)
- [ ] Webhook retry tested (send same event twice, verify idempotency)
- [ ] Meet name validation tested with various formats
- [ ] S3 cleanup job tested and scheduled
- [ ] Admin filter behavior tested (sticky vs non-sticky)
- [ ] Customization persistence tested (regenerate, --force)
- [ ] RLS policies enforced on sensitive operations
- [ ] Audit log populated for all destructive operations
- [ ] Status machine diagram documented for admins
- [ ] Error messages clear and actionable
- [ ] No raw SQL that bypasses constraints

---

## Common Mistakes to Avoid

❌ "Admin can turn off the refund guard in localStorage" → Keep in database only
❌ "Operational filters auto-restore on page load" → Clear on mount
❌ "Temp PDFs have no TTL" → Add S3 lifecycle rule
❌ "meet_name typed manually by agent" → Validate against shirt_backs
❌ "Webhook handler doesn't check for duplicates" → Check event_id table first
❌ "Customizations stored in serialized JSON in code" → Store in DB column
❌ "Frontend fetches state once and reuses it" → Fetch before critical actions

---

## File References

- Full analysis: `ORDERING-SYSTEM-LEARNINGS-ANALYSIS.md`
- Architecture patterns: `ORDERING-SYSTEM-ARCHITECTURE.md`
- Implementation checklist: `ORDERING-SYSTEM-CHECKLIST.md`
- Original solution files: `docs/solutions/logic-errors/` and `docs/solutions/architecture-patterns/`

