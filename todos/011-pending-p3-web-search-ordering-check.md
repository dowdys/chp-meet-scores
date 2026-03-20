---
status: pending
priority: p3
issue_id: "011"
tags: [code-review, architecture, prompt-vs-code]
dependencies: []
---

# Add Soft Warning When web_search Used Before Direct Sources

## Problem Statement

The system prompt says "Do NOT use web_search as the first step" — try MSO/ScoreCat Algolia directly first. The agent sometimes jumps straight to Google.

## Findings

- **system-prompt.md:57, 221, 223**: Ordering preference: MSO → ScoreCat → MyMeetScores → web search

## Proposed Solutions

### Solution A: Track source usage, warn on premature web_search
If `http_fetch` hasn't been called yet, return a one-time note suggesting direct sources first.

- **Effort**: Small
- **Risk**: Very low

## Acceptance Criteria

- [ ] First call to web_search returns a note about trying direct sources
- [ ] Subsequent calls proceed normally

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-03-19 | Created from architectural review | |

## Resources

- search-tools.ts (web_search)
