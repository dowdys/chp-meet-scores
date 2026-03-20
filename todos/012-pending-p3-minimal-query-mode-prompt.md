---
status: pending
priority: p3
issue_id: "012"
tags: [code-review, architecture, performance]
dependencies: []
---

# Use Minimal System Prompt for Query Mode

## Problem Statement

Query mode appends "## Query Mode" to the **full 268-line system prompt** including all extraction, workflow, and output generation instructions. Query mode only uses `query_db`, `query_db_to_file`, and `list_output_files` — it doesn't need workflow documentation.

## Findings

- **agent-loop.ts:224-229**: Full system prompt loaded for queries
- Query mode only exposes 3 tools but sends documentation for 30

## Proposed Solutions

### Solution A: Dedicated query system prompt (Recommended)
Use a minimal prompt with just database schema docs and query guidance.

- **Pros**: Reduces token cost per query; prevents workflow confusion
- **Effort**: Small (1 hour)
- **Risk**: Very low

## Acceptance Criteria

- [ ] Query mode uses a focused system prompt (< 50 lines)
- [ ] Database schema and query guidance still available
- [ ] Token usage per query reduced measurably

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-03-19 | Created from architectural review | |

## Resources

- agent-loop.ts:224-229
