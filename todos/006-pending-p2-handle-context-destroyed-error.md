---
status: pending
priority: p2
issue_id: "006"
tags: [code-review, architecture, prompt-vs-code, error-handling]
dependencies: []
---

# Handle "Execution Context Destroyed" Error in Code

## Problem Statement

The system prompt warns "Do NOT retry JS execution after 'Execution context was destroyed' without navigating first." This is a common Chrome CDP error. The agent encounters it, retries the same script, gets the same error, then figures out it needs to navigate — wasting 1-2 iterations.

## Findings

- **system-prompt.md:217**: Explicit anti-pattern warning
- **chrome-controller.ts** `executeJS()`: No special handling for this error

## Proposed Solutions

### Solution A: Catch and return actionable error (Recommended)
Detect the error in `executeJS()` and return a clear message telling the agent what to do.

- **Pros**: Saves 1-2 iterations per occurrence; simple
- **Cons**: Tiny change
- **Effort**: Small (30 min)
- **Risk**: Very low

**Implementation:**
```typescript
} catch (err) {
  if (err.message?.includes('Execution context was destroyed')) {
    return 'Error: Page context was destroyed (page navigated away or refreshed). Call chrome_navigate first, then retry.';
  }
  throw err;
}
```

## Acceptance Criteria

- [ ] "Execution context destroyed" returns actionable error message
- [ ] Agent doesn't waste iterations retrying without navigating

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-03-19 | Created from architectural review | Common enough to warrant a system prompt warning |

## Resources

- chrome-controller.ts `executeJS()` method
- system-prompt.md line 217
