---
status: pending
priority: p3
issue_id: "010"
tags: [code-review, architecture, prompt-vs-code, error-handling]
dependencies: []
---

# Improve finalize_meet Error When No Staging DB Exists

## Problem Statement

The system prompt says "Do NOT call finalize_meet after --import-idml." If the agent does it anyway, the error message is a confusing file-not-found rather than explaining that IDML imports don't use staging DBs.

## Findings

- **system-prompt.md:68**: "Do NOT call this after --import-idml"
- **python-tools.ts:126-263**: `finalize_meet` doesn't give a contextual error

## Proposed Solutions

### Solution A: Contextual error message (Recommended)
Check if staging DB exists and return a clear explanation if not.

- **Effort**: Small (30 min)
- **Risk**: Very low

## Acceptance Criteria

- [ ] Clear error message when finalize_meet called without staging DB

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-03-19 | Created from architectural review | |

## Resources

- python-tools.ts:126-263
