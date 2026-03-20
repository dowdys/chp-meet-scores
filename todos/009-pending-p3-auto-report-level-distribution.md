---
status: pending
priority: p3
issue_id: "009"
tags: [code-review, architecture, prompt-vs-code]
dependencies: []
---

# Auto-Report Level Distribution After Extraction

## Problem Statement

The system prompt says "After extraction, IMMEDIATELY check that the extracted levels match what the user requested." The extraction tools report per-meet athlete counts but not level distribution, requiring an extra tool call.

## Findings

- **system-prompt.md:59**: Level verification instruction
- **extraction-tools.ts:123-138**: Summary only includes per-meet counts, not levels

## Proposed Solutions

### Solution A: Add level distribution to extraction summary (Recommended)
Count levels from the parsed athletes array and append to the result summary.

- **Pros**: Saves 1 iteration per extraction; automatic verification
- **Effort**: Small (30 min)
- **Risk**: Very low

## Acceptance Criteria

- [ ] Extraction tool results include level distribution
- [ ] Agent can verify levels without an extra tool call

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-03-19 | Created from architectural review | |

## Resources

- extraction-tools.ts:123-138
