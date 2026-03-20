---
status: pending
priority: p2
issue_id: "005"
tags: [code-review, architecture, prompt-vs-code]
dependencies: []
---

# Enforce set_output_name Before run_python

## Problem Statement

The prompt says to call `set_output_name` before `run_python`, but if skipped, `context.outputName` is undefined and the code silently falls back to `context.meetName` — the user's raw input like "Can you process the Iowa state championships for 2025?". This creates ugly folder names in the user's Documents directory.

## Findings

- **system-prompt.md:60**: "IMMEDIATELY after identifying the correct meet, call set_output_name"
- **agent-loop.ts:657**: Falls back to `context.outputName || context.meetName`
- **agent-loop.ts:156-158**: `meetName` is the user's raw input string

## Proposed Solutions

### Solution A: Refuse run_python without outputName (Recommended)
Return an error from `run_python` if `context.outputName` is not set.

- **Pros**: Guaranteed clean folder names; simple check
- **Cons**: One extra tool call required; could be annoying for quick re-runs
- **Effort**: Small (30 min)
- **Risk**: Very low

### Solution B: Auto-generate clean name
If `outputName` not set, auto-generate from `--meet` and `--state` flags in the args.

- **Pros**: No extra tool call needed
- **Cons**: Generated name may not be what the user wants
- **Effort**: Small
- **Risk**: Low

## Acceptance Criteria

- [ ] `run_python` does not create folders from raw user input
- [ ] Clear error message guides agent to call `set_output_name` first

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-03-19 | Created from architectural review | Silent fallback creates user-visible mess |

## Resources

- context-tools.ts:657
- system-prompt.md line 60
