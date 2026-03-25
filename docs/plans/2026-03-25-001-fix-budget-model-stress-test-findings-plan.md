---
title: "fix: Budget model stress test findings — 5 architectural improvements"
type: fix
status: active
date: 2026-03-25
deepened: 2026-03-25
---

## Enhancement Summary

**Deepened on:** 2026-03-25
**Agents used:** architecture-strategist, prompt-enforcement-detector, code-simplicity-reviewer, spec-flow-analyzer, learnings-researcher, repo-research-analyst

### Key Revisions from Deepening
1. **Fix 2 simplified:** Drop IPC contract change. Backfill `context.state` from tool args only (build_database, regenerate_output, import_pdf_backs). Also persist `state` in ProgressData.
2. **Fix 3B made structural:** Auto-override `meet_name` with `context.outputName` when they differ (not just warn). Makes divergence impossible.
3. **Fix 3C simplified:** Prevent name change when folder has files (error + suggest reset) instead of OneDrive-safe rename machinery. YAGNI — the name should be set once in discovery.
4. **Fix 4 downgraded:** `process-meet` already creates a new AgentLoop per call, so `lastContext` isolation is mostly handled. Add one-liner defensively + investigate stale `agent_progress.json` as the real ghost source.
5. **Fix 5 made architectural:** Instead of more prompting, add `search_meets` call counter (limit to 1-2 calls) and remove search/browse tools after a clear match via tool gating. Architecture over prompting.

### New Findings from Deepening
- **Finding 6:** `search_meets` should be limited to 1-2 calls per session via call counter
- **Finding 7:** Store deadline dates on context and auto-inject into `build_database` when agent omits them
- **Finding 9/10:** Remove stale prompt instructions (verify date via run_script, convert Algolia timestamps) — already handled in code
- **Finding 19:** `finalize_meet` should validate `meet_name` matches `context.outputName`

---

# Fix: Budget Model Stress Test Findings

## Overview

Stress testing with budget models (Gemini Flash Lite, DeepSeek V3.2, Qwen 3 Coder) exposed 5 architectural gaps that smart models paper over with reasoning. These fixes make the system more robust for all models by enforcing correct behavior structurally.

## Problem Statement

Budget models exposed these failure modes:
1. Agent keeps searching after a clear match — wastes iterations exploring instead of advancing
2. Agent doesn't know Xcel is part of USAG — asks user obvious domain questions
3. User-provided dates get lost across phase transitions — asked for dates multiple times
4. Ghost context from previous runs causes assumed custom backs and wrong state
5. Different output names across retries create duplicate folders for the same meet

## Proposed Solution

Five targeted fixes, ordered by dependency (later fixes build on earlier ones).

---

## Fix 1: Add USAG/Xcel Domain Knowledge to Base Prompt

**File:** `src/main/agent-loop.ts` — `loadBasePrompt()`

Add a domain knowledge section to the base prompt (not phase-specific, since this applies everywhere):

```
## Gymnastics Domain Knowledge
- USAG (USA Gymnastics) has two programs: Competitive (Levels 1-10) and Xcel (Bronze, Silver, Gold, Platinum, Diamond, Sapphire)
- "All levels" for a USAG meet means BOTH numbered levels AND Xcel divisions
- AAU meets do NOT have Xcel — they have their own level structure
- A state championship typically covers all competitive levels; most sources split these across multiple separate meets
- Men's gymnastics has different events (floor, pommel horse, rings, vault, parallel bars, high bar) and different level structures
```

**Why base prompt not phase prompt:** This knowledge is needed across all phases — discovery needs it for search, extraction for validation, database for quality checks. Domain knowledge is inherently declarative — you cannot structurally prevent the agent from asking "what is Xcel?" You can only tell it.

**Acceptance criteria:**
- [ ] Agent never asks "does all levels include Xcel?" for USAG meets
- [ ] Agent knows AAU is different from USAG

---

## Fix 2: Populate and Persist `context.state`

**Files:** `src/main/context-tools.ts`, `src/main/agent-loop.ts`

**Problem:** `context.state` is declared on `AgentContext` but **never assigned** anywhere in the codebase. The handoff message's `if (context.state)` line is always false. State information only survives pruning by accident (via tool arg snapshots or LLM summary).

**Fix — backfill from tool args (no IPC change needed):**

Every tool that accepts a `state` parameter should set `context.state` as a side effect:
- `toolBuildDatabase`: `context.state = state` after `requireString(args, 'state')` (line 166)
- `toolRegenerateOutput`: `context.state = state` after `requireString(args, 'state')` (line 241)
- `toolImportPdfBacks`: `context.state = state` after `requireString(args, 'state')` (line 325)

The state is always available from tool args before any phase transition where it matters. No IPC contract change needed — the UI's structured string already contains the state name.

**Also persist `state` in ProgressData** (per `persist-destructive-operation-guards.md` pattern):
- Add `state?: string` to `ProgressData` interface
- Save: `state: context.state` in `toolSaveProgress` and `autoSaveProgress`
- Load: `context.state = savedProgress.state` in resume path

**Acceptance criteria:**
- [ ] `context.state` populated from tool args (build_database, regenerate_output, import_pdf_backs)
- [ ] State survives context pruning in the handoff message
- [ ] State persists across save/resume via ProgressData

---

## Fix 3: Persist `outputName` and Enforce Name Consistency

**Files:** `src/main/context-tools.ts`, `src/main/agent-loop.ts`

**Problem:** `context.outputName` is NOT persisted by `save_progress` / `autoSaveProgress`. On resume, it starts as `undefined` and falls back to `context.meetName`. If the user's raw input ("2026 Nebraska all levels") differs from the standardized name ("USAG W Gymnastics - 2026 NE - March 20"), files split across two folders.

**Part A — Persist `outputName`:**

Add `output_name` to `ProgressData` interface and save/load it:
- `ProgressData.output_name?: string`
- Save: `output_name: context.outputName` in both `toolSaveProgress` and `autoSaveProgress`
- Load: `context.outputName = savedProgress.output_name` in `processMeet` resume path

**Part B — `build_database` auto-uses `context.outputName` as meet_name:**

Keep `meet_name` required in the tool schema (so the LLM always provides it). In `toolBuildDatabase`, after extracting `meet_name` via `requireString`, compare it to `context.outputName`. If they differ, **auto-override** `meet_name` with `context.outputName` and prepend a warning to the tool result. This makes name divergence structurally impossible while keeping the API stable.

```typescript
// In toolBuildDatabase, after requireString:
if (context.outputName && meetName !== context.outputName) {
  const warning = `Warning: meet_name "${meetName}" differs from output name "${context.outputName}". Using output name.\n`;
  meetName = context.outputName; // auto-correct
  // prepend warning to result
}
```

Also apply the same validation in `finalize_meet` — move it to a context-aware tool or validate in `executeTool` that the argument matches `context.outputName`.

**Part C — Prevent name change when folder has files:**

Instead of OneDrive-safe folder rename (YAGNI), prevent the rename entirely when the old folder exists and has files:

```typescript
// In set_output_name handler:
if (context.outputName && name !== context.outputName) {
  const oldDir = getOutputDir(context.outputName, false);
  if (fs.existsSync(oldDir) && fs.readdirSync(oldDir).length > 0) {
    return `Error: Cannot change output name — folder "${context.outputName}" already contains files. Use "Clear Session" to start fresh if you need a different name.`;
  }
}
context.outputName = name;
```

This is ~5 lines vs. the rename-with-OneDrive-fallback machinery. The name should be set once during discovery and never changed.

**Acceptance criteria:**
- [ ] `outputName` persists across save/resume
- [ ] `build_database` auto-corrects meet_name to match context.outputName
- [ ] `finalize_meet` validates meet_name matches context.outputName
- [ ] `set_output_name` errors when folder already has files and name differs
- [ ] No duplicate folders created when agent uses slightly different name strings

---

## Fix 4: Clear `lastContext` Between Runs (Defensive)

**Files:** `src/main/agent-loop.ts`

**Problem:** Ghost context from previous runs could theoretically cause `continueConversation` to pick up the wrong meet's context.

**Analysis from deepening:** The `process-meet` IPC handler at `main.ts` line 176 creates a **new AgentLoop** per call. The new instance has `lastContext = null` by construction. So `lastContext` from a previous run is already unreachable after a new `process-meet` call. The real ghost source may be stale `agent_progress.json` containing `idml_imported: true` from a prior run.

**Fix (defensive one-liner):**

Add `this.lastContext = null` at the start of `processMeet`. This is harmless and defensive:

```typescript
async processMeet(meetName: string): Promise<...> {
  this.lastContext = null; // Prevent ghost context from previous runs
  // ...existing code...
}
```

**Also:** When starting a fresh run (user chose "Start fresh" or meetName doesn't match progress), verify the progress file is fully cleared — specifically check that `idml_imported` from a previous meet isn't leaking.

**Acceptance criteria:**
- [ ] `this.lastContext = null` at start of `processMeet`
- [ ] Debug log emitted when clearing non-null lastContext with different meetName
- [ ] Stale `agent_progress.json` does not leak flags from previous meets

---

## Fix 5: Architectural Discovery Enforcement

**Files:** `src/main/tools/search-tools.ts`, `src/main/agent-loop.ts`, `src/main/workflow-phases.ts`

**Problem:** After `search_meets` returns a clear match, budget models waste iterations browsing websites to "confirm" or calling `search_meets` again. The discovery prompt says "Trust the results" but weak models ignore prompt instructions.

**Fix — architecture over prompting:**

**Part A — `search_meets` call counter:**

Track calls on the context. After the first call returns results, a second call returns cached results with a directive:

```typescript
// In search_meets executor or agent-loop executeTool:
if (context.searchMeetsCallCount > 0 && lastSearchResults) {
  return `Already searched. Here are the previous results:\n${lastSearchResults}\n\nUse these results to proceed. Do NOT search again.`;
}
context.searchMeetsCallCount = (context.searchMeetsCallCount || 0) + 1;
```

**Part B — Tool gating after clear match:**

When `search_meets` returns exactly one Women's-program result for the target state, remove discovery tools (`search_meets`, `lookup_meet`, `web_search`, `http_fetch`, `chrome_*`) from the available tools for the remainder of the discovery phase. Only `set_output_name`, `ask_user`, `set_phase`, and always-available tools remain. This makes further searching structurally impossible.

Implementation: add a `discoveryMatchFound` flag to context. In `filterToolsForPhase`, when in discovery phase and flag is set, exclude search/browse tools.

**Part C — Remove stale prompt instructions:**

- Remove "ALWAYS verify today's date with `run_script`" from discovery prompt (date already in base prompt)
- Remove Algolia timestamp conversion instructions from `meet_discovery.md` skill (already done in `search_meets` code)

**Acceptance criteria:**
- [ ] `search_meets` limited to 1-2 calls per session (cached results on repeat)
- [ ] Clear match → search/browse tools removed from discovery phase
- [ ] No stale instructions telling agent to do things code already handles
- [ ] Multiple matches → tools remain available for further investigation

---

## Fix 6 (New): Store Dates on Context

**Files:** `src/main/context-tools.ts`, `src/main/agent-loop.ts`

**Problem:** When the agent asks for deadline dates via `ask_user` in discovery, the dates survive the prune via `askUserExchanges`. But if the agent then forgets to pass them to `build_database`, the dates are lost. The prompt says "ALWAYS include deadline dates" but budget models forget.

**Fix:** Store dates on context when `build_database` is called with date args. Auto-inject them on subsequent calls when the agent omits them:

```typescript
// In toolBuildDatabase, after extracting dates:
if (postmarkDate) context.postmarkDate = postmarkDate;
if (onlineDate) context.onlineDate = onlineDate;
if (shipDate) context.shipDate = shipDate;

// On subsequent calls, auto-inject if missing:
if (!postmarkDate && context.postmarkDate) {
  argParts.push('--postmark-date', context.postmarkDate);
}
```

Add dates to `ProgressData` for persistence across save/resume.

Also apply to `regenerate_output` — auto-inject dates from context when agent omits them.

**Acceptance criteria:**
- [ ] Dates stored on context when build_database is called
- [ ] Missing dates auto-injected from context on subsequent tool calls
- [ ] Dates persist across save/resume via ProgressData

---

## Compound: Session Learnings

**File:** `docs/solutions/` — new solution documents

Compound the following learnings from this session:

1. **`switchPhase` helper pattern** — Never set `context.currentPhase` directly; always use `switchPhase()` to keep db-tools phase in sync. Structural enforcement of invariant.

2. **Budget model stress testing** — Use cheap models (Qwen 3 Coder, DeepSeek V3.2) as architecture quality tests. If a weak model fails, the architecture has a gap. Smart models hide bad engineering.

3. **Context pruning with LLM summary** — Parallel automated extraction + LLM summary on phase transitions. Captures tool args, tool results, ask_user Q&A, file paths. The LLM summary is best-effort with 15s timeout.

4. **Chrome tools removed from extraction** — Making wrong actions structurally impossible: dedicated extraction tools only, Chrome available via unlock_tool for unknown sources.

5. **`justPruned` flag for end_turn after pruning** — After context pruning, the agent's first response often contains completion words ("complete", "ready") that trigger premature loop exit. The flag forces a nudge on the first end_turn, consumed when the agent makes tool calls.

---

## Dependencies & Risks

- **Fix 3C (prevent rename):** Simple and safe. No OneDrive concerns since we error instead of rename.
- **Fix 4 (clear lastContext):** Defensive. Investigate stale `agent_progress.json` as the real ghost source per architecture review.
- **Fix 5B (tool gating after match):** Needs a `discoveryMatchFound` flag on context and integration with `filterToolsForPhase`. Medium complexity but high impact for budget models.
- **Fix 6 (date storage):** Adds 3 fields to AgentContext and ProgressData. Low risk, follows established patterns.

**Cross-cutting rule (from `persist-destructive-operation-guards.md`):** For every new `AgentContext` field added in Fixes 2-6, verify it is also added to `ProgressData` with matching save/load logic.

## Implementation Order

1. Fix 1 (domain knowledge) — zero risk, immediate impact
2. Fix 2 (populate + persist context.state) — enables better handoffs
3. Fix 3 (persist outputName + name enforcement) — highest impact fix
4. Fix 6 (store dates on context) — prevents date loss
5. Fix 5 (architectural discovery enforcement) — architecture over prompting
6. Fix 4 (clear lastContext) — defensive one-liner
7. Compound learnings — documentation only

## Sources

- **Known issue:** `docs/solutions/logic-errors/output-name-meet-name-must-match.md` — P1 name mismatch splits folders
- **Known issue:** `docs/solutions/logic-errors/persist-destructive-operation-guards.md` — runtime flags must be persisted
- **Known issue:** `docs/solutions/logic-errors/sticky-params-silently-exclude-athletes.md` — silent data inheritance is dangerous
- **Known issue:** `docs/solutions/logic-errors/warn-but-proceed-not-block-and-retry.md` — never block without state change
- **Existing plan:** `docs/plans/2026-03-20-011-auto-phase-switch-dates-persist-plan.md` — related auto-switch work
- **Architecture principle:** CLAUDE.md "Architecture Over Prompting" — make wrong actions structurally impossible
