---
title: "Stripe shipping_details moved to collected_information in newer API versions"
category: integration-issues
tags: [stripe, checkout-session, shipping, api-versioning, breaking-change]
severity: P0
date: 2026-03-27
---

## Problem

Webhook handler accessing `session.shipping_details` silently returns `undefined` for all orders. No errors thrown — TypeScript was silenced with `as any`. Orders created with empty shipping addresses.

## Root Cause

Stripe moved shipping data from `session.shipping_details` to `session.collected_information.shipping_details` in newer API versions. The TypeScript types correctly DON'T include the old property. Casting via `as any` hid a runtime bug that produced `undefined`.

## Solution

```typescript
// WRONG — property doesn't exist, as any hides the bug
const shipping = (session as any).shipping_details;

// CORRECT — typed path that actually exists
const shipping = session.collected_information?.shipping_details;
```

## Prevention

- **Never use `as any` to silence Stripe type errors.** If types say a property doesn't exist, it doesn't exist at runtime either.
- Pin your Stripe API version explicitly in the client constructor.
- Validate critical fields (shipping address) before persisting — fail loudly on missing data.
