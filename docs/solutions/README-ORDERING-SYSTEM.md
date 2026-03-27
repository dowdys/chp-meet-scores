---
title: "Ordering System: Institutional Learnings Summary"
date: 2026-03-27
---

# Ordering System: Institutional Learnings Summary

This directory contains analysis of how seven documented learnings from the CHP codebase apply to the State Champion Ordering System.

## Quick Start

**Before implementing the ordering system, read in this order:**

1. **ORDERING-SYSTEM-LEARNINGS-ANALYSIS.md** — Deep dive into each learning, why it matters, and specific code patterns
2. **ORDERING-SYSTEM-CHECKLIST.md** — Implementation checklist to verify nothing is missed
3. Individual solution files (referenced below) for full context

## Seven Critical Learnings

### 1. Foreign Key Integrity: meet_name Coupling
**File:** `logic-errors/output-name-meet-name-must-match.md`

The ordering system uses `meet_name` as a FK in `shirt_backs`, `order_items`, `athlete_tokens`. If the Electron app publishes `meet_name` inconsistently, order creation will silently fail or reference non-existent designs.

**Action:** Add meet_name validation before order_items creation.

### 2. Destructive Operation Guards Must Persist
**File:** `logic-errors/persist-destructive-operation-guards.md`

Order status transitions (pending → paid → shipped → delivered) are irreversible. If admin dashboard keeps "allow_refund" flags in session state, a page reload will lose the guard, allowing duplicate refunds.

**Action:** Keep all status state in database; implement idempotency keys for Stripe/EasyPost operations.

### 3. Sticky Admin Filters Can Silently Corrupt Data
**File:** `logic-errors/sticky-params-silently-exclude-athletes.md`

The Electron app learned that auto-restoring "destructive filters" breaks workflows. When admin creates printer batches, they don't want an old "Status=pending" filter silently auto-applied, limiting backs included.

**Action:** Distinguish view preferences (STICKY) from operational filters (NOT STICKY); clear filters on page navigation.

### 4. Stale Data Cleanup Must Happen Proactively
**File:** `logic-errors/stale-extract-files-cause-data-bloat.md`

After 12 runs, the Electron app had 17,479 athletes instead of 971 due to stale extraction files. Similarly, the ordering system will accumulate temp PDFs, old QR codes, email drafts unless cleanup is baked into the schema.

**Action:** Add TTL to S3 objects; implement scheduled cleanup jobs; use content-addressed naming for finalized artifacts.

### 5. Frontend/Backend State Sync via Database
**File:** `architecture-patterns/switch-phase-helper-invariant.md`

The Electron app has internal phase state. The ordering system has frontend + backend. If they diverge (frontend shows "batch locked" but backend still accepts items), concurrent operations corrupt state.

**Action:** All state flows through database; database constraints enforce invariants (CHECK, FK, triggers); frontend reads state on every action.

### 6. Regeneration Must Preserve User Customizations
**File:** `logic-errors/level-groups-must-be-sticky.md`

When admin regenerates a PDF to fix a typo, custom level groupings should persist (STICKY). But the old Electron app excluded them, forcing re-entry every time.

**Action:** Store `shirt_backs.customizations` (level_groups, page_size, fonts); regenerate without --force preserves them.

### 7. Webhook Handlers Must Be Idempotent
**File:** `architecture-patterns/budget-model-stress-testing.md`

Stripe webhooks retry on errors. If handler logic assumes "this is the first time," retries can double-charge, send duplicate emails, or leave orders in inconsistent states.

**Action:** Store processed event IDs; implement database constraints for valid state transitions; add event log.

---

## Implementation Scope

These learnings affect:

| Component | Changes |
|-----------|---------|
| **Schema** | Add idempotency tables, customizations column, audit log, event log, webhook tracking |
| **API Design** | Implement state machine validation; add idempotent webhook handlers |
| **Frontend** | Separate view prefs from operational filters; clear filters on navigation |
| **Background Jobs** | Implement cleanup and scheduled tasks |
| **Testing** | State transition tests, webhook retry tests, concurrent operation tests |
| **Documentation** | Admin runbook, destructive operations checklist, status machine diagram |

## Key Metrics to Track

After launch:

- **Webhook retry rate**: Idempotency check prevents duplicate processing
- **Order completion rate**: High completion indicates good UX (filters not confusing admins)
- **Database size**: Cleanup jobs keeping size manageable
- **Refund request rate**: Audit trail available for dispute resolution
- **Printer batch accuracy**: No missing backs indicates meet_name validation working

---

## Avoiding Repeated Mistakes

The ordering system is the "rebrand launch" — first impression of new CHP. These learnings prevent:

- ❌ Orders for non-existent meets (FK integrity)
- ❌ Duplicate refunds (destructive guards)
- ❌ Silent data loss in batch creation (sticky filters)
- ❌ Database bloat from temp files (stale cleanup)
- ❌ Conflicting frontend/backend state (database-driven)
- ❌ Losing custom designs on regenerate (customization persistence)
- ❌ Duplicate emails or charges (webhook idempotency)

---

## Files in This Analysis

- **ORDERING-SYSTEM-LEARNINGS-ANALYSIS.md** — Full technical analysis with code examples
- **ORDERING-SYSTEM-CHECKLIST.md** — Item-by-item verification checklist
- **README-ORDERING-SYSTEM.md** (this file) — Quick reference and overview

## Related Solution Files

These files are referenced extensively and should be reviewed in context:

1. `docs/solutions/logic-errors/output-name-meet-name-must-match.md`
2. `docs/solutions/logic-errors/persist-destructive-operation-guards.md`
3. `docs/solutions/logic-errors/sticky-params-silently-exclude-athletes.md`
4. `docs/solutions/logic-errors/stale-extract-files-cause-data-bloat.md`
5. `docs/solutions/architecture-patterns/switch-phase-helper-invariant.md`
6. `docs/solutions/architecture-patterns/budget-model-stress-testing.md`
7. `docs/solutions/logic-errors/level-groups-must-be-sticky.md`

---

## Questions?

These learnings are not theoretical — each one is backed by a bug that broke production workflows in the existing CHP system. Before dismissing any checklist item as "unlikely" or "we'll handle it in QA," review the original solution file to see the actual failure mode.

