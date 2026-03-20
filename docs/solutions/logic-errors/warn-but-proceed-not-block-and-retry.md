---
title: "Tool guardrails must warn-but-proceed, not block-and-suggest-retry"
category: logic-errors
date: 2026-03-19
tags: [tool-design, guardrails, agent-loop, infinite-loop]
components: [browser-tools]
severity: p2
---

# Tool guardrails must warn-but-proceed, not block-and-suggest-retry

## Problem

Added domain-aware warnings to `chrome_execute_js` and `chrome_save_to_file` that detected when the agent was on MeetScoresOnline.com or ScoreCat and suggested using the dedicated extraction tools instead. The implementation returned the warning string and did an early `return` — blocking execution entirely.

The warning text said: "If you have a specific non-extraction reason to run JS here, call this tool again."

But the second call hit the same domain check and returned the same warning. Infinite loop with no bypass.

## Root Cause

The guardrail assumed the agent could "try again" and somehow get past the check. But the check is stateless — it looks at the current page URL every time. There's no mechanism to distinguish "first warning" from "acknowledged retry."

## Solution

Changed to **warn-but-proceed**: the warning is prepended to the actual tool result instead of replacing it. The agent sees the note about dedicated tools but still gets its JS executed.

```typescript
// Before (blocks):
const domainWarning = await checkDedicatedToolDomain();
if (domainWarning) return domainWarning;
const result = await chromeController.executeJS(script);

// After (warns but proceeds):
const domainWarning = await getDedicatedToolWarning();
const result = await chromeController.executeJS(script);
return (domainWarning || '') + resultStr;
```

## Prevention

**Pattern for soft guardrails in agent tools:**

1. **Warn-but-proceed** (preferred): Prepend the warning to the result. The agent sees it and can adjust behavior on the *next* call. No iteration wasted.

2. **Block with bypass**: If blocking is truly needed, implement a bypass mechanism — e.g., track whether the warning was already shown for this URL, or accept a `bypass_warning: true` parameter.

3. **Never**: Block and suggest "call again" without a state change that would make the second call different. This always creates an infinite loop.
