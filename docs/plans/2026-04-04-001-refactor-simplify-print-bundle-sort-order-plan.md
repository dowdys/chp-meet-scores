---
title: "refactor: Simplify print bundle to 2 sheets and add jewel-optimized sorting"
type: refactor
status: completed
date: 2026-04-04
---

# Simplify Print Bundle & Add Jewel-Optimized Sorting

## Overview

Simplify the print bundle from variable-length per-order (2-5+ sheets) to exactly 2 sheets per order (shipping label + order sheet). Remove per-shirt slips and JEWEL flag pages. Add smart sorting: non-jewel orders first, then jewel orders sorted by athlete name position on the shirt back PDF (across then down). The order sheet must clearly indicate which shirts need jewels.

## Problem Frame

The current print bundle generates per-shirt slips and JEWEL flag pages that add complexity without proven value. The physical assembly line needs a simpler starting point. Additionally, sorting by order number doesn't optimize for the jeweling station — grouping jewel orders together and sorting them by name position on the shirt will speed up the bottleneck station.

## Requirements Trace

- R1. Each order produces exactly 2 printed sheets: shipping label + presentable order sheet
- R2. Per-shirt slips and JEWEL flag pages are removed (may return as separate feature later)
- R3. The order sheet clearly indicates which shirts need jewels (prominent visual marker)
- R4. Orders sorted: non-jewel orders first, then jewel orders
- R5. Within the jewel group, orders sorted by athlete name position on the shirt back PDF — across (x) then down (y) — so the jeweler can work through names in physical order on the shirt
- R6. Within the non-jewel group, maintain order number sorting

## Scope Boundaries

- **In scope:** Print bundle sort logic, order sheet jewel indicators, removal of slip/flag pages
- **Not in scope:** Per-shirt slips (deferred to future feature), changes to print manifest, changes to the assembly line workflow documentation
- **Not in scope:** Handling multi-shirt orders where some items have jewels and some don't — for sorting purposes, if ANY item in the order has a jewel, the order goes in the jewel group

## Context & Research

### Relevant Code

- `website/src/app/api/admin/print-bundle/route.ts` — the file being modified. Currently generates label + order sheet + per-shirt slips + jewel flags. Sort is by `order_number`.
- `website/src/app/api/shirt-preview/route.ts` — contains text position extraction from PDFs using `pdfjs-dist`. The pattern at lines 43-86 shows how to find an athlete's name position: load PDF → `getTextContent()` → search items for name match → extract `transform[4]` (x) and `transform[5]` (y).
- `drawOrderSheet()` — already renders all items in the order. Just needs jewel indicators made more prominent.
- `drawShirtSlip()` and `drawJewelFlagPage()` — will be removed (dead code).

### Key Pattern: Name Position Extraction

From shirt-preview/route.ts, the pattern for locating a name on a shirt back PDF:
1. Fetch the shirt back PDF from `design_pdf_url` on the `shirt_backs` table
2. Load with `pdfjs-dist` (`getDocument({ data: bytes })`)
3. Get text content for each page (`page.getTextContent()`)
4. Search items for the athlete name (case-insensitive)
5. Extract position: `transform[4]` = x, `transform[5]` = y

For sorting across-then-down: sort by y descending (top of shirt first) then x ascending (left to right). This matches the physical reading order of names on the shirt.

## Key Technical Decisions

- **Sort within jewel group by name position, not by order number:** This optimizes the physical jeweling workflow. The jeweler works through names on the shirt in reading order — having the orders pre-sorted this way means they don't have to hunt for each name.

- **If name position lookup fails, fall back to order number sort:** PDF parsing can fail. Orders where we can't determine position go to the end of the jewel group, sorted by order number.

- **Fetch back PDFs once per unique back, not per order:** Multiple orders share the same shirt back. Cache the text positions per back_id to avoid redundant PDF fetches.

- **"Has jewel" is order-level, not item-level, for sorting:** If any item in the order has `has_jewel=true`, the entire order goes in the jewel group. This keeps multi-shirt orders together.

## Open Questions

### Resolved During Planning

- **What if an order has 3 shirts across 2 backs with different name positions?** Use the position of the first jeweled item's name. The jeweler processes one shirt at a time anyway.
- **What about multi-shirt orders where only some items have jewels?** The order goes in the jewel group (any jewel = jewel order). Non-jewel items in that order are simply skipped by the jeweler.

### Deferred to Implementation

- **Exact text matching strategy for names on PDFs:** The shirt-preview route uses `toUpperCase().includes()` which works. May need adjustment if names on the back are formatted differently than in the database.
- **Performance of fetching/parsing back PDFs for large batches:** Should be fast since we cache per back_id (typically 2-3 unique backs per batch, not per order).

## Implementation Units

- [ ] **Unit 1: Remove per-shirt slips and JEWEL flag pages**

**Goal:** Simplify the PDF loop to exactly 2 pages per order.

**Requirements:** R1, R2

**Dependencies:** None

**Files:**
- Modify: `website/src/app/api/admin/print-bundle/route.ts`

**Approach:**
- Remove the `drawShirtSlip()` and `drawJewelFlagPage()` function calls from the main loop
- Remove the `drawShirtSlip()` and `drawJewelFlagPage()` function definitions entirely (dead code)
- The loop becomes: for each order → `drawLabelPage()` → `drawOrderSheet()` → done

**Patterns to follow:**
- The existing loop structure in `buildPrintBundlePdf()`

**Test scenarios:**
- Happy path: batch with 5 orders → PDF has exactly 10 pages (2 per order)
- Happy path: multi-shirt jewel order → still only 2 pages (no slips, no flag)
- Edge case: single-shirt jewel order → 2 pages (no extra flag page)

**Verification:**
- PDF page count = 2 × number of orders in the batch

- [ ] **Unit 2: Enhance order sheet jewel indicators**

**Goal:** Make jewel status unmistakably clear on the order sheet since we're removing the separate JEWEL flag page.

**Requirements:** R3

**Dependencies:** Unit 1

**Files:**
- Modify: `website/src/app/api/admin/print-bundle/route.ts` (specifically `drawOrderSheet()`)

**Approach:**
- For each item listed on the order sheet, add a prominent visual jewel marker next to items that need jewels
- Add a large bold "JEWEL ORDER" header at the top of the order sheet if any item has a jewel
- Use a thick border or highlight box around jeweled items to make them visually distinct
- Non-jewel orders should have no jewel markings at all (clean separation)

**Patterns to follow:**
- The existing `drawOrderSheet()` item list rendering

**Test scenarios:**
- Happy path: order with 2 jewel items and 1 non-jewel → items marked individually, "JEWEL ORDER" header present
- Happy path: order with no jewel items → no jewel markings anywhere on the sheet
- Edge case: order where all items have jewels → "JEWEL ORDER" header, all items marked

**Verification:**
- Visually inspect a generated PDF: jewel orders are immediately distinguishable from non-jewel orders

- [ ] **Unit 3: Sort orders by jewel status and name position**

**Goal:** Sort the order list so non-jewel orders come first (by order number), then jewel orders sorted by name position on the shirt back.

**Requirements:** R4, R5, R6

**Dependencies:** Unit 1

**Files:**
- Modify: `website/src/app/api/admin/print-bundle/route.ts`

**Approach:**
- After building the orders list (currently sorted by order_number), re-sort:
  1. Partition into non-jewel and jewel groups
  2. Non-jewel group: sort by order_number (as before)
  3. Jewel group: for each order, determine the name position of the first jeweled item on its shirt back PDF
     - Group jewel orders by `back_id` (since name positions are relative to a specific back design)
     - For each unique back_id, fetch the back PDF once using `pdfjs-dist`
     - Extract all text positions from the PDF
     - For each order, find the position of the athlete name → store (x, y)
     - Sort by y descending (top of shirt = higher y in PDF coords), then x ascending (left to right)
  4. Concatenate: non-jewel group + jewel group (by back, sorted by position within each back)
- Handle fallback: if name not found in PDF, append to end of that back's group sorted by order_number
- Cache: load each back PDF only once, extract all text positions, then match against all orders for that back

**Patterns to follow:**
- `shirt-preview/route.ts` lines 43-86 for PDF text extraction with pdfjs-dist
- Current sort logic at line 148 of print-bundle

**Test scenarios:**
- Happy path: 3 non-jewel + 2 jewel orders → non-jewel come first (by order#), then jewel
- Happy path: 2 jewel orders on same back, names at different positions → sorted by position
- Edge case: jewel order where name not found in PDF → sorted to end of jewel group by order number
- Edge case: batch with only non-jewel orders → all sorted by order number (no position logic needed)
- Edge case: batch with only jewel orders → all sorted by position
- Integration: verify pdfjs-dist text extraction returns positions for athlete names in a real back PDF

**Verification:**
- Print bundle PDF has non-jewel orders first, jewel orders second
- Within jewel orders, the athlete name sequence matches the physical reading order on the shirt

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| pdfjs-dist may not find all athlete names in the back PDF (font encoding, text splitting) | Fall back to order_number sort for unfound names — the bundle still works, just not optimally sorted |
| Fetching back PDFs adds latency to bundle generation | Cache per back_id — typically only 2-3 unique backs per batch |
| Name position y-coordinate direction may be inverted (PDF coords have y=0 at bottom) | Test with real back PDFs; may need to sort y ascending if y=0 is top |

## Sources & References

- Print bundle: `website/src/app/api/admin/print-bundle/route.ts`
- Text position extraction pattern: `website/src/app/api/shirt-preview/route.ts:43-86`
- Parent plan: `docs/plans/2026-04-03-003-feat-admin-dashboard-fulfillment-system-plan.md`
