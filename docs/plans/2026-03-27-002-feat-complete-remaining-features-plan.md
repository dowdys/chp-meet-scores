---
title: "feat: Complete All Remaining Features and Fixes"
type: feat
status: active
date: 2026-03-27
---

# Complete All Remaining Features and Fixes

Based on two review passes (10 agents) and plan completeness audit, this plan addresses everything needed to make the ordering system production-ready.

## Priority 1: Critical Functionality (Admin Can't Work Without These)

### 1.1 Admin Interactive Features (Server Actions)
- [ ] **Name correction Apply/Dismiss** — alerts page buttons need server actions that update `name_correction_reviewed` and optionally `corrected_name` on `order_items`
- [ ] **Create Printer Batch** — backs page needs "Select backs → Create Batch" flow. Server action creates `printer_batches` + `printer_batch_backs` rows, updates `order_items.printer_batch_id`
- [ ] **Batch status transitions** — batches page needs buttons: queued → at_printer → returned. On "returned", update all `order_items.production_status` to "printed"
- [ ] **Create Shipping Label** — shipping page button calls `/api/shipping` for selected orders
- [ ] **Send Email Blast** — emails page button calls `/api/admin/email-blast` for selected state

### 1.2 Admin Filter/Search UI
- [ ] **Orders page** — status dropdown filter, search box (name/email/order#), date range picker
- [ ] **Global search** — search bar in admin layout that searches across orders, customers, athletes

### 1.3 Wire Up Email Sending
- [ ] **Order confirmation email** — send from Stripe webhook after order creation (use React Email template + Postmark)
- [ ] **Shipping confirmation email** — send from shipping route after label creation
- [ ] **Delivery confirmation** — send from EasyPost webhook on "delivered" status

## Priority 2: Missing Features

### 2.1 CSV Export
- [ ] **Export orders** — CSV download button on orders page
- [ ] **Export by back** — CSV download on backs page (sizes/colors/jewels per back)
- [ ] **Export email captures** — CSV on emails page

### 2.2 Packing Slip PDF Generation
- [ ] **`lib/packing-slip.ts`** — Generate PDF with @react-pdf/renderer: athlete name(s), corrected name, size, color, jewel indicator, back description, order number

### 2.3 Celebration Animations (5 Events)
- [ ] **vault-animation.tsx** — SVG silhouette + Framer Motion keyframes
- [ ] **bars-animation.tsx**
- [ ] **beam-animation.tsx**
- [ ] **floor-animation.tsx**
- [ ] **all-around-animation.tsx**
- [ ] **Event router** — celebration page selects correct animation based on athlete's primary event

### 2.4 Privacy Policy Page
- [ ] `/privacy` page with COPPA-compliant privacy policy

### 2.5 Admin Meets Page Enhancements
- [ ] Show which meets are "ready for ordering" (have shirt_backs + athlete_tokens)

## Priority 3: Security Hardening

### 3.1 Input Validation (Zod)
- [ ] Zod schemas for: checkout, email-capture, shipping, email-blast, order-lookup
- [ ] `correctedName` character validation (alpha, hyphens, apostrophes, spaces, accents, max 100)

### 3.2 Rate Limiting
- [ ] Install `@upstash/ratelimit` + `@upstash/redis`
- [ ] Rate limit: email-capture (5/hr per IP), checkout (10/min per IP), order-lookup (10/min per IP), celebrate POST (30/min per IP), admin login (5/min per IP)

### 3.3 Security Headers
- [ ] CSP, X-Frame-Options, HSTS, X-Content-Type-Options in next.config.ts

### 3.4 Admin Session Security
- [ ] Add `correctedName` length validation in checkout route

## Priority 4: Performance Polish

### 4.1 Webhook Optimization
- [ ] Deduplicate meet/back lookups in Stripe webhook (batch by unique meet_name)

### 4.2 Middleware Optimization
- [ ] Skip `getUser()` for non-admin routes (only run full auth on `/admin/*`)

### 4.3 Admin Query Limits
- [ ] Add `.limit()` to: getOrdersByBack, getPrinterBatches, getEmailCaptures, analytics queries

### 4.4 Zustand Hydration Fix
- [ ] Add `skipHydration` + manual rehydrate to prevent SSR mismatch

## Priority 5: Code Quality

### 5.1 Generated Supabase Types
- [ ] Add database types file (`lib/supabase/types.ts`) for all tables
- [ ] Replace `any` casts across admin pages with proper types

### 5.2 Remove Dead Code
- [ ] Remove unused `EVENTS` export from utils
- [ ] Clean up easypost.ts proxy pattern (simplify to direct export)
