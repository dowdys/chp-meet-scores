---
title: "switchPhase helper enforces db-tools phase sync"
category: architecture-patterns
date: 2026-03-25
tags: [phase-management, db-tools, invariant, structural-enforcement]
components: [agent-loop, db-tools]
severity: p1
---

# switchPhase helper enforces db-tools phase sync

## Problem

`context.currentPhase` and the module-level `currentPhase` in db-tools.ts must stay synchronized. When they diverge, `openDb()` routes to the wrong database (staging vs central), causing "Staging database not found" errors or silent data corruption.

There were 5 locations setting `context.currentPhase` directly, and only some called `setDbToolsPhase()`. The desync was "safe by coincidence" because the out-of-sync phases happened to produce identical `openDb()` behavior — but this would break silently if `PROCESSING_PHASES` or `openDb()` logic ever changed.

## Root Cause

Two independent state variables that must always agree, updated through separate function calls. No structural enforcement that they stay in sync.

## Solution

Extract a `switchPhase()` helper function that atomically updates both:

```typescript
function switchPhase(context: AgentContext, phase: WorkflowPhase): void {
  context.currentPhase = phase;
  setDbToolsPhase(phase);
}
```

Replace ALL direct `context.currentPhase =` assignments (except inside `switchPhase` itself and `toolSetPhase`) with calls to `switchPhase()`.

## Prevention Rule

Never set `context.currentPhase` directly. Always use `switchPhase()`. The only exception is `toolSetPhase()` in context-tools.ts, which is the tool-facing equivalent and already calls `setDbToolsPhase()` internally.

## Where Applied

- `src/main/agent-loop.ts` — 5 locations replaced with `switchPhase()`
- Verified via `grep 'context\.currentPhase ='` returns only the helper itself
