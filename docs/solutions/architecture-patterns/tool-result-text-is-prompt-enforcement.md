---
title: "Tool result text is prompt enforcement, not architectural enforcement"
category: architecture-patterns
tags:
  - architecture-over-prompting
  - tool-results
  - agent-behavior
  - enforcement
module: "AgentLoop, context-tools"
symptom: "SUSPICIOUS_NAMES warning appended to tool result was ignored by the agent across 10 consecutive calls"
root_cause: "LLMs treat tool results as informational context; appended instructions compete with primary result content and lose"
date: 2026-03-31
---

# Tool result text is prompt enforcement, not architectural enforcement

## Problem

Appending "FIX REQUIRED: run these SQL updates" to a `regenerate_output` tool result does NOT cause the agent to act on it. In the Missouri process log, the SUSPICIOUS_NAMES warning was appended to 10 consecutive regeneration results. The agent ignored it every time and continued with layout tweaks. The text was present in the tool result — the agent simply chose not to act on it.

This feels "architectural" because the instruction is IN the tool result (not in a system prompt), but it's still just text the LLM can choose to ignore. True architectural enforcement means the tool refuses to execute until the precondition is met.

## Root Cause

LLMs process tool results as informational context, not as imperative commands. An appended instruction competes with the primary result content for the model's attention. When the primary content says "regeneration complete, here are the results" and a footer says "also fix these names", the model focuses on the primary content and treats the footer as optional.

## Solution

Move the check to BEFORE the tool runs. Store the suspicious names list on `context.suspiciousNames` after the first detection. On the next `regenerate_output` call, check `context.suspiciousNames` at the TOP of the function — before calling Python. If non-empty, return an error immediately (never run Python). This makes it structurally impossible to regenerate with dirty names.

The pattern:

- **First detection** → warn (return result + fix commands)
- **Second call** → block (return error before execution, Python never runs)

**File:** `src/main/context-tools.ts` (`toolRegenerateOutput`)

## Key Insight

The test for whether something is "architectural enforcement" vs "prompt enforcement": **does the tool refuse to execute, or does it execute and then ask nicely?**

If it executes, it's prompt enforcement — regardless of where the text appears. A footer in a tool result is no different from a note in the system prompt. The LLM can acknowledge it, deprioritize it, and move on.

## Prevention

When adding enforcement to tool results, ask: **"Can the agent ignore this and still get a successful result?"**

If yes, it's prompt enforcement. Move the check to a precondition that blocks execution.

See also: `CLAUDE.md` — *Design Principle: Architecture Over Prompting*. Every prompt warning replaced by architectural enforcement makes the system more reliable. If you find yourself adding a prompt warning for the third time, build it into the code instead.
