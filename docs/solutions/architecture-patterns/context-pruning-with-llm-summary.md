---
title: "Context pruning with parallel LLM summary on phase transitions"
category: architecture-patterns
date: 2026-03-25
tags: [context-pruning, phase-transitions, token-optimization, handoff]
components: [agent-loop]
severity: p2
---

# Context pruning with parallel LLM summary on phase transitions

## Problem

The single-agent conversation grows monotonically. By the output_finalize phase, the context carries discovery search results, extraction API responses, and database quality checks — information the agent no longer needs. This wastes tokens and accelerates context exhaustion.

## Solution

When `set_phase` triggers a phase transition, `pruneContextForPhaseTransition` condenses the full message history into a compact handoff. Two strategies run in parallel:

### Automated extraction (synchronous)
- **Tool arg snapshots**: Key arguments from important tools (search_meets, build_database, etc.), deduplicated to last call per tool
- **Tool result snapshots**: First 800 chars of results from key tools (search_meets, mso_extract, etc.)
- **ask_user Q&A**: Full question + answer pairs from user interactions
- **File paths**: Regex extraction from all tool results
- **Agent text**: Last 3 assistant text blocks (capped at 2000 chars)

### LLM summary (async, 15s timeout)
- Uses a cheap model (qwen/qwen3.5-35b-a3b on OpenRouter, or haiku on Anthropic/subscription)
- Sends a condensed conversation (10K char cap) with agent text, tool names/args, truncated results
- Asks for "ALL key facts concisely" in under 300 words
- Best-effort: if it fails or times out, the automated parts suffice

### Post-prune behavior
- All messages replaced with a single handoff message
- `loadedSkills` cleared (agent reloads what it needs)
- `justPruned` flag set to prevent premature loop exit

## Key Design Decisions

- **Tool results preserved**: Meet IDs, athlete counts, and file paths survive because `HANDOFF_RESULT_TOOLS` captures the first 800 chars of key tool results
- **Dates preserved**: Stored on context (context.postmarkDate, etc.) and auto-injected into subsequent tool calls
- **State preserved**: Backfilled from tool args (build_database, regenerate_output) and persisted in ProgressData
- **Discovery-to-extraction special case**: Parses search_meets results for source/ID patterns and generates prescriptive "Next Step" directive with exact tool call
