---
title: "justPruned flag prevents premature loop exit after context pruning"
category: architecture-patterns
date: 2026-03-25
tags: [context-pruning, end-turn, agent-loop, phase-transitions]
components: [agent-loop]
severity: p1
---

# justPruned flag prevents premature loop exit after context pruning

## Problem

After context pruning on a phase transition, the agent's first response typically summarizes prior work using words like "complete", "ready", "successfully". The `end_turn` detection logic matches these as completion patterns and exits the agent loop — even though the agent has an entire new phase to work through.

This caused runs to stop after extraction, requiring the user to re-run to continue from saved progress.

## Root Cause

The `end_turn` handler checks for `completionPatterns` (done, complete, finished, ready, successfully) and exits the loop when they match. After pruning, the agent's handoff response naturally contains these words when summarizing what happened in the prior phase.

## Solution

Two-part fix:

1. **`justPruned` flag on AgentContext**: Set to `true` after context pruning. When the next `end_turn` is detected with this flag, the loop nudges the agent ("You just transitioned to a new phase. Please proceed...") instead of exiting.

2. **Consumed on tool_use**: When the agent makes tool calls (tool_use response), `justPruned` is set to `false`. This prevents the flag from persisting across many tool-calling iterations and incorrectly blocking the final end_turn after the agent is actually done.

## Key Insight

The flag must be consumed when the agent starts WORKING (tool_use), not just when it talks (end_turn). If consumed only on end_turn, the agent could make 10+ tool calls before its final summary, and the flag would still be true — nudging the agent to continue after it's already finished everything.

## Where Applied

- `src/main/agent-loop.ts` — `justPruned` set in `pruneContextForPhaseTransition`, checked in `end_turn` handler, consumed in `tool_use` handler
- `src/main/context-tools.ts` — `justPruned?: boolean` on `AgentContext` interface
