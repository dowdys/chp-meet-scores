---
title: "Supabase RLS USING(true) does NOT mean service role only"
category: database-issues
tags: [supabase, rls, security, postgresql]
severity: critical
date: 2026-03-27
---

## Problem

We wrote `CREATE POLICY "Service role manages orders" ON orders FOR ALL USING (true)` with a comment saying "only accessible via service role key." This is completely wrong — it grants access to ALL roles including `anon`.

## Root Cause

The service role **bypasses RLS entirely** — it never evaluates policies. Policies only apply to other roles (`anon`, `authenticated`). `USING(true)` is a universal grant to every role that DOES go through RLS, meaning any anonymous user with the public anon key (embedded in client JS) could read/write/delete all orders.

## Solution

```sql
-- WRONG: grants access to everyone
CREATE POLICY "Service role manages orders" ON orders
  FOR ALL USING (true);

-- CORRECT: denies all non-service access (service role bypasses RLS anyway)
CREATE POLICY "No direct access" ON orders
  FOR ALL USING (false);

-- OR: scope to admin users specifically
CREATE POLICY "Admin manages orders" ON orders
  FOR ALL USING ((SELECT auth.uid()) IN (SELECT id FROM admin_users))
  WITH CHECK ((SELECT auth.uid()) IN (SELECT id FROM admin_users));
```

## Prevention

- **Mental model**: The service role BYPASSES RLS. If you're writing a policy "for" the service role, you're confused.
- **Default-deny**: Use `USING(false)` for tables that should only be accessed server-side. It costs nothing.
- **Test with anon key**: After writing policies, make requests with the anon key. If you can read protected data, the policy is wrong.
