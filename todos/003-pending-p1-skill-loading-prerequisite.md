---
status: pending
priority: p1
issue_id: "003"
tags: [code-review, architecture, prompt-vs-code]
dependencies: []
---

# Enforce Skill Loading Prerequisites Architecturally

## Problem Statement

The system prompt says "CRITICAL: Load the appropriate skill BEFORE every major workflow step" and specifically mandates loading `output_generation` before any layout work. But no code checks `context.loadedSkills` before tool execution. The agent regularly skips skill loading, doesn't know about available flags, and wastes 3-5 iterations guessing.

## Findings

- **system-prompt.md:55**: "CRITICAL: Load the appropriate skill BEFORE every major workflow step"
- **system-prompt.md:65**: "MANDATORY: Load output_generation skill FIRST"
- **system-prompt.md:228**: "Do NOT attempt layout changes without first loading the output_generation skill"
- **system-prompt.md:241-242**: "ALWAYS load the output_generation skill BEFORE attempting layout changes"
- **context-tools.ts:311-328**: `toolLoadSkill()` tracks loaded skills but nothing checks them
- **agent-loop.ts:329-336**: `buildSystem()` appends loaded skill names but doesn't gate tool access

## Proposed Solutions

### Solution A: Auto-load relevant skill on tool use (Recommended)
When `run_python` detects output-related mode, auto-load the `output_generation` skill content and append it to the tool result.

- **Pros**: Zero friction for the agent; always has the right information; eliminates wasted iterations
- **Cons**: Adds content to tool results (but this is cheaper than the iterations saved)
- **Effort**: Small (few hours)
- **Risk**: Low

### Solution B: Embed flag docs in split tool descriptions
If #001 is implemented (split tools), put relevant flag documentation directly in each tool's description field.

- **Pros**: Information always available; no extra tool calls needed
- **Cons**: Increases tool definition size; depends on #001
- **Effort**: Part of #001
- **Risk**: Low

### Solution C: Gate with warning
Check `context.loadedSkills` before tool execution and return a warning (not a block).

- **Pros**: Nudges agent without blocking; simple to implement
- **Cons**: Agent might ignore the warning; still requires a follow-up load_skill call
- **Effort**: Small
- **Risk**: Low

## Recommended Action
*(To be filled during triage)*

## Technical Details

**Affected files:**
- `src/main/context-tools.ts` — add skill check in `toolRunPython()`
- `src/main/agent-loop.ts` — or add check in `executeTool()`

## Acceptance Criteria

- [ ] Output generation tools have access to flag documentation without explicit skill loading
- [ ] Agent no longer wastes iterations guessing flags
- [ ] The 4 "load skill first" warnings in system-prompt.md can be removed or softened

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-03-19 | Created from architectural review | 4 separate prompt warnings = evidence of frequent failure |

## Resources

- system-prompt.md lines 55, 65, 228, 241-242
- context-tools.ts:311-328
