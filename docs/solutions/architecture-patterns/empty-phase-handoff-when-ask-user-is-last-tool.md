---
title: "Phase handoff produces empty context when ask_user is the last tool"
category: architecture-patterns
tags:
  - context-pruning
  - phase-transition
  - ask-user
  - agent-loop
module: AgentLoop
symptom: >
  Incoming phase agent receives a handoff message with no useful information.
  agentTexts, askUserExchanges, and keyToolResults are all empty after
  pruneContextForPhaseTransition runs, causing the new phase to start blind.
root_cause: >
  The phase switch fires inside executeToolCalls before the current tool
  batch's results are pushed to context.messages. pruneContextForPhaseTransition
  reads from context.messages, so the ask_user response that triggered the
  switch is present in toolResults but invisible to the prune logic.
date: 2026-03-31
---

# Phase handoff produces empty context when ask_user is the last tool

## Problem

When the agent's last action before a phase transition is an `ask_user` tool call with no accompanying text content, `pruneContextForPhaseTransition` extracts zero content. All three extraction paths come up empty:

- **`agentTexts`** — populated from assistant text blocks, but the assistant only emitted a `tool_use` block with no text
- **`askUserExchanges`** — scans prior messages for ask_user Q&A pairs, but the ask_user that triggered the phase switch is in the current tool batch, not yet in `context.messages` when the prune runs
- **`keyToolResults`** — only captures results from `HANDOFF_RESULT_TOOLS`; `ask_user` is not in that set

The LLM summary fallback may also fail or time out. The result is an incoming phase agent that starts with a handoff message containing no useful information.

## Real-world occurrence

Oregon IDML session — the user provided PDF back paths via `ask_user`. The response triggered a phase auto-switch to `import_backs`. The prune ran immediately, extracted nothing, and the new agent had zero context — including losing the PDF paths it was switching phases specifically to process.

## Root cause

The phase switch is detected inside `executeToolCalls`, triggered by inspecting the tool results as they arrive. At that moment the current tool batch has not yet been appended to `context.messages`. `pruneContextForPhaseTransition` operates entirely on `context.messages`, so the triggering `ask_user` response exists in `toolResults` but is invisible to every extraction path the prune uses.

```
executeToolCalls()
  → detects PDF paths in toolResults          # switch trigger fires here
  → calls pruneContextForPhaseTransition()    # reads context.messages — stale
      agentTexts        = []                  # no text block on last assistant turn
      askUserExchanges  = []                  # triggering Q&A not in messages yet
      keyToolResults    = []                  # ask_user not in HANDOFF_RESULT_TOOLS
  → handoff message is empty
  → new phase agent starts blind
```

## Solution

A safety net was added inside `pruneContextForPhaseTransition`: if `agentTexts`, `askUserExchanges`, and `keyToolResults` are all empty and no LLM summary was produced, fall back to keeping text-only content from the last 5 messages, stripping `tool_use` and `tool_result` blocks that reference tools belonging to the old phase. `justPruned` is set to `true` per the existing invariant.

**File:** `src/main/agent-loop.ts` — `pruneContextForPhaseTransition` method

## Prevention

When adding a new auto-switch trigger that fires inside `executeToolCalls`:

1. Verify that the data which caused the trigger (e.g. PDF paths from an `ask_user` response) survives the subsequent prune.
2. If it will not — because it lives only in `toolResults` at switch time — explicitly capture and inject that data into the handoff context before calling the prune.
3. The safety net covers the general empty-context case, but it cannot reconstruct specific structured data (like file paths) that was never in `context.messages` to begin with.
