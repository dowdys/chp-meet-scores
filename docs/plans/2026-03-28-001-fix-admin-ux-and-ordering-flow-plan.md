---
title: "fix: Admin UX issues and ordering flow improvements"
type: fix
status: active
date: 2026-03-28
---

# Admin UX Issues and Ordering Flow Improvements

Based on hands-on testing with a real order (CHP-2026-4D355B001).

## Issues Found

### 1. Name Correction Dedup
**Problem:** 3 shirts for same athlete → 3 name correction alerts. Should show 1 correction per unique (athlete_name, corrected_name) pair, with "3 shirts affected" count.
**Fix:** Group corrections by (athlete_name, corrected_name, meet_name) in the alerts query, show count per group.

### 2. "By Back" Shows "Unknown"
**Problem:** Back shows "Unknown" because `back_id` is NULL (no shirt_backs published yet) and the join returns nothing. Should fall back to showing the meet name from `order_items.meet_name`.
**Fix:** When shirt_backs join returns null, display the meet_name instead. Also extract state from meet_name.

### 3. Show Celebration Animation During Ordering
**Problem:** Customer only sees the animation if they scan a QR code. When finding athlete via /find, they go straight to the order form without any celebration.
**Fix:** After selecting athlete in /find, redirect to a celebration-style page (or show the animation inline) before the order form.

### 4. Show Shirt Preview During Ordering
**Problem:** Customers can't see what their shirt will look like before ordering.
**Fix:** Show a shirt mockup on the order page with the back design image overlaid. Front images from the folder of state-specific front designs. This is a larger design task — start with showing the back PDF image from Supabase Storage if available.

### 5. Batches Page — How It Works
**Problem:** User confused about how batch creation works.
**Fix:** The "By Back" page has a BatchCreator component that lets you select backs and create a batch. This should be more discoverable — add instruction text and make the flow clearer. The Batches page shows existing batches with status transition buttons.

### 6. Emails Page Shows No Captures
**Problem:** Order emails are NOT captured in email_captures table — that table is for pre-order signups from the /email-capture page. The customer email from orders goes into the orders table.
**Fix:** The Emails page should show BOTH: email captures (pre-order signups) AND customer emails from orders (for marketing). Or clarify that this page is only for pre-order signups.

### 7. Analytics State — Uses Shipping Address Instead of Meet
**Problem:** Revenue by state shows "NC" (shipping address) instead of "Minnesota" (the meet state).
**Fix:** Use `order_items.meet_name` to extract the meet state instead of `orders.shipping_state`. Parse the state from the meet name or add a `meet_state` column to order_items.

### 8. Meets Page — "\u2014" Characters
**Problem:** Backs and Tokens columns show "\u2014" (em dash) instead of checkmarks or numbers.
**Fix:** The query joins to shirt_backs and athlete_tokens, but those tables are empty (no data published from Electron yet). The display should show "0" or "Not published" instead of Unicode escape characters.
