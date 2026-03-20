---
title: "Runtime flags that gate destructive operations must be persisted"
category: logic-errors
date: 2026-03-19
tags: [idml-import, save-resume, data-safety, context-flags]
components: [context-tools, agent-loop]
severity: p1
---

# Runtime flags that gate destructive operations must be persisted

## Problem

Added an `idmlImported` flag to `AgentContext` that prevents `build_database` from running after an IDML import (which would overwrite designer edits). The flag was set at runtime but not serialized to `ProgressData` — the save/resume format.

This meant the protection was lost on resume, which is the *most likely* scenario for the flag to matter: IDML import sessions are long (import + layout tweaks + date adjustments), so they're the most likely to hit context limits and trigger auto-save.

## Root Cause

`AgentContext` (runtime state) and `ProgressData` (serialized state) are separate interfaces. Adding a field to one doesn't automatically add it to the other. There's no compile-time check that they stay in sync for safety-critical fields.

## Solution

Added `idml_imported?: boolean` to `ProgressData`, serialized it in both `toolSaveProgress` and `autoSaveProgress`, and restored it during progress loading in `agent-loop.ts`.

## Prevention

**Rule of thumb**: Any runtime flag that gates a destructive operation must be persisted if the system has save/resume capability. Before adding a guard flag to context, ask: "What happens if the agent saves and resumes right after this flag is set?" If the answer is "the guard is bypassed," the flag must be persisted.

The save/resume path isn't an edge case — it's triggered by the same long sessions where destructive guards matter most.
