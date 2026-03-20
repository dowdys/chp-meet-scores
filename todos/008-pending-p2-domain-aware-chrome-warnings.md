---
status: pending
priority: p2
issue_id: "008"
tags: [code-review, architecture, prompt-vs-code]
dependencies: []
---

# Add Domain-Aware Warnings to Chrome Tools

## Problem Statement

The system prompt says "ALWAYS use the dedicated extraction tools" for MSO and ScoreCat and "Do NOT manually script MSO or ScoreCat extraction." But the agent has full `chrome_execute_js` and `chrome_save_to_file` access on those domains and occasionally reinvents extraction logic that already exists in dedicated tools.

## Findings

- **system-prompt.md:85**: "ALWAYS use the dedicated extraction tools"
- **system-prompt.md:213**: "Do NOT manually script MSO or ScoreCat extraction"
- **browser-tools.ts**: No URL-based checks on chrome tools

## Proposed Solutions

### Solution A: Soft warning on known domains (Recommended)
Check the current page URL before executing JS. If on MSO or ScoreCat, return a warning suggesting the dedicated tool. Don't block — the agent may have a legitimate reason.

- **Pros**: Guides without blocking; simple check
- **Cons**: Agent could ignore warning
- **Effort**: Small (1 hour)
- **Risk**: Very low

## Acceptance Criteria

- [ ] `chrome_execute_js` on MSO/ScoreCat pages returns a warning about dedicated tools
- [ ] Warning doesn't block execution — agent can proceed with a second call

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-03-19 | Created from architectural review | Agent reinventing existing extraction logic wastes iterations |

## Resources

- browser-tools.ts (chrome_execute_js, chrome_save_to_file)
- extraction-tools.ts (mso_extract, scorecat_extract)
