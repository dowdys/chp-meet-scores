---
title: "EasyPost Webhook HMAC: Never Roll Your Own Verification"
category: integration-issues
tags: [easypost, webhooks, hmac, signature-verification, node-sdk]
severity: P1
date: 2026-03-27
---

## Problem

Custom HMAC verification for EasyPost webhooks that looks correct (`crypto.createHmac` + `timingSafeEqual`) silently rejects ALL legitimate webhooks. Passed two code reviews before being caught.

## Root Cause

EasyPost's HMAC scheme has three undocumented divergences from the standard pattern:

1. **Signature prefix**: Header value is `hmac-sha256-hex=abc123...`, not raw hex. Comparing raw digest against prefixed value never matches.
2. **NFKD normalization**: Secret must be `.normalize('NFKD')` before HMAC creation.
3. **Weight float coercion**: `"weight": 8` in the body was signed as `"weight": 8.0`. Re-serialized JSON drops the `.0`, producing a different HMAC.

## Solution

Always use the SDK's built-in method:

```typescript
const event = client.Utils.validateWebhook(
  Buffer.from(rawBody),  // raw bytes, never re-serialized
  headers,               // full headers object
  webhookSecret          // SDK handles NFKD internally
);
```

## Prevention

- Default to SDK verification for any webhook provider — custom HMAC is a trap when the provider has undocumented normalization.
- Test with real webhook deliveries, not mocked payloads.
- Read the SDK source (`node_modules/@easypost/api/src/utils/util.js`), not just the docs.
