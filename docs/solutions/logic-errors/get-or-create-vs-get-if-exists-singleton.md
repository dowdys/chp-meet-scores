---
title: "Get-or-create and get-if-exists must be separate functions for stateful singletons"
category: logic-errors
tags:
  - singleton-state
  - side-effects
  - staging-db
  - function-splitting
module: python-tools
symptom: "After finalize_meet + pull_meet, regenerate_output calls getStagingDbPath(), receives a phantom timestamped path pointing to a non-existent file, and corrupts the module-level singleton for all subsequent callers in the session."
root_cause: "A single get-or-create function was used in contexts that only needed get-if-exists. The invisible side effect of setting the module-level variable was triggered by callers that had no intention of creating the resource."
date: 2026-03-31
---

# Get-or-create and get-if-exists must be separate functions for stateful singletons

## Problem

`getStagingDbPath()` in `src/main/tools/python-tools.ts` served dual purposes:

1. **Create** a new timestamped staging DB path on first call during `toolBuildDatabase`
2. **Retrieve** the existing path for `toolRegenerateOutput`, `toolImportPdfBacks`, and `run_script`

After `finalize_meet` deleted the staging DB and reset `currentStagingDbPath = null`, any call to `getStagingDbPath()` from category (2) would silently **create** a new phantom path — a timestamped path pointing to a non-existent file. That phantom path was then stored in the module-level singleton, corrupting state for all subsequent callers in the session.

## Symptom

After `finalize_meet` + `pull_meet`, `regenerate_output` called `getStagingDbPath()`, received a phantom path, and checked `fs.existsSync()` (returns false), falling through to the central DB. This happened to produce correct behavior **by accident**. The underlying module state was still corrupted: `currentStagingDbPath` now pointed to a non-existent file, making subsequent callers unpredictable.

## Root Cause

A single function with "get or create" semantics was used in contexts that only needed "get if exists." The function carried an invisible side effect — setting the module-level variable — that the lookup callers did not expect and did not want.

## Solution

Split into two functions with semantics that match their caller intent:

```typescript
// Used ONLY by toolBuildDatabase — creates the path on first use
function getOrCreateStagingDbPath(): string { ... }

// Used by all other callers — returns null if no staging DB exists on disk, no side effects
function getStagingDbPath(): string | null { ... }
```

The "get" variant must:
- Return `null` (not create) when `currentStagingDbPath` is null or the file no longer exists on disk
- Have **zero side effects** on module state
- Be safe to call at any point in the session lifecycle

## Key Insight

When a module-level singleton serves both "initialize" and "lookup" purposes, those must be separate functions. The lookup path must never carry creation side effects. The naming convention should make the distinction explicit: **`getOrCreate`** vs **`get`**.

## Prevention

When writing a singleton-accessor function, ask:

> "Does this caller want to **create** the resource if absent, or just **check** whether it exists?"

If different callers have different answers, the function must be split. A single accessor with creation semantics will eventually be called by a lookup caller at the wrong time — after cleanup, after reset, or in a retry — and silently resurrect state that was intentionally destroyed.

**Rule of thumb:** If a function name starts with `get` but can set a variable as a side effect, rename it or split it.

## File

`src/main/tools/python-tools.ts`
