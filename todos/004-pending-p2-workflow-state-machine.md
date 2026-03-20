---
status: pending
priority: p2
issue_id: "004"
tags: [code-review, architecture, prompt-vs-code, performance]
dependencies: []
---

# Add Workflow Phase-Based Tool Filtering

## Problem Statement

All 30 tools are sent in every API call regardless of workflow phase. During meet discovery, the agent sees `finalize_meet`. Before data exists, it sees `render_pdf_page`. This adds ~5,000 tokens of tool definitions per call and allows nonsensical tool sequences.

## Findings

- **agent-loop.ts:322**: `const tools = getToolDefinitions()` — always the full set
- **tool-definitions.ts**: 30 tools returned unconditionally
- No concept of workflow phase in `AgentContext`

## Proposed Solutions

### Solution A: Phase-based tool filtering with auto-advance
Track current workflow phase in context. Filter tools to phase-relevant subset. Auto-advance phase when key tools succeed (e.g., extraction complete → database phase).

- **Pros**: Reduces token cost ~60%; prevents nonsensical sequences; simpler agent decisions
- **Cons**: May be too rigid; agent needs to go back sometimes (re-extract after quality issue)
- **Effort**: Medium (1-2 days)
- **Risk**: Medium — could block legitimate backtracking

### Solution B: Soft phase annotations
Keep all tools available but add phase hints to descriptions (e.g., "Phase: output generation"). No blocking.

- **Pros**: No risk of blocking legitimate use; easy to implement
- **Cons**: Doesn't reduce token cost; agent may ignore hints
- **Effort**: Small
- **Risk**: Very low

## Acceptance Criteria

- [ ] Tool set is contextually appropriate for current workflow phase
- [ ] Agent can still backtrack when needed (re-extract, re-query)
- [ ] Token usage per API call reduced measurably

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-03-19 | Created from architectural review | 30 tools * ~170 tokens each = ~5K tokens per call |

## Resources

- agent-loop.ts:322
- tool-definitions.ts (full file)
