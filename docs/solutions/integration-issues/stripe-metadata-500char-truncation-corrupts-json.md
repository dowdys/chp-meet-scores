---
title: "Stripe metadata 500-char limit silently corrupts serialized JSON"
category: integration-issues
tags: [stripe, metadata, json-truncation, data-loss, checkout, webhooks]
severity: P0
date: 2026-03-27
---

## Problem

Customers with 4+ items pay successfully but no order is created. The cart was serialized as JSON into Stripe metadata and truncated to 490 chars. Invalid JSON causes a parse error in the webhook handler, which catches and returns 200 — Stripe considers it delivered, idempotency marks it "completed", and the order is permanently lost.

## Root Cause

Three compounding mistakes:
1. `JSON.stringify(items).substring(0, 490)` produces invalid JSON when the string exceeds 490 chars.
2. The webhook `catch` block returns 200 (telling Stripe delivery succeeded).
3. The idempotency guard marks the event as "completed", preventing retry forever.

## Solution

Never store business-critical data in Stripe metadata. Store it server-side and pass only a reference:

```typescript
// Checkout: store cart in your DB
const cartToken = crypto.randomUUID();
await supabase.from("pending_carts").insert({
  cart_token: cartToken,
  items: cartItems, // JSONB column, no size limit
});

// Only put the reference in Stripe metadata
const session = await stripe.checkout.sessions.create({
  metadata: { cart_token: cartToken },
  // ...
});

// Webhook: retrieve cart from DB, not metadata
const { data: cart } = await supabase
  .from("pending_carts")
  .select("items")
  .eq("cart_token", session.metadata.cart_token)
  .single();
```

## Prevention

- Never serialize unbounded data into Stripe metadata (500 chars/value, 50 keys max).
- Never truncate serialized JSON — `substring()` on JSON is always wrong.
- Never return 200 from a webhook when processing failed — return 4xx/5xx so Stripe retries.
- Make idempotency status granular (succeeded/failed/partial) to allow recovery.
- Add a reconciliation job comparing paid Stripe sessions against created orders.
