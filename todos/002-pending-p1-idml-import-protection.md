---
status: pending
priority: p1
issue_id: "002"
tags: [code-review, architecture, prompt-vs-code, data-safety]
dependencies: []
---

# Enforce IDML Import Protection In Code

## Problem Statement

The rule "never run full pipeline after IDML import" appears **4+ times** across the codebase in different wordings, yet has zero code enforcement. One wrong tool call destroys hours of a designer's InDesign work by overwriting imported IDML with code-rendered versions.

The repetition itself is evidence that this fails often enough to warrant saying it 4 times — and it still isn't enough.

## Findings

- **system-prompt.md:18**: "Do NOT run --regenerate or any other run_python calls afterward"
- **system-prompt.md:226**: "NEVER run full pipeline (--source generic) after --import-idml"
- **tool-definitions.ts:134**: "CRITICAL: NEVER run full pipeline (--source generic) after --import-idml"
- **compound-engineering.local.md:21**: "running --regenerate after --import-idml destroys designer edits"
- **context-tools.ts:87-176**: IDML import path exists but sets no protection flag

## Proposed Solutions

### Solution A: Context flag + tool-level guard (Recommended)
Track IDML import state in `AgentContext`. When `run_python` is called with `--source`, check the flag and refuse.

- **Pros**: Simple (~10 lines), prevents the highest-consequence failure, clear error message
- **Cons**: Only protects within same session (agent restart clears context)
- **Effort**: Small (1 hour)
- **Risk**: Very low

### Solution B: Filesystem sentinel file
Write a `.idml_imported` marker file in the output directory after IDML import. Check for it before full pipeline runs.

- **Pros**: Persists across sessions; protects even if agent restarts
- **Cons**: Slightly more complex; need to clean up sentinel when appropriate
- **Effort**: Small (2-3 hours)
- **Risk**: Low

### Solution C: Combine with tool split (Finding #001)
If `run_python` is split into typed tools, `import_idml` sets a flag and `build_database` checks it.

- **Pros**: Cleanest integration; part of larger refactor
- **Cons**: Depends on #001 being done first
- **Effort**: Part of #001
- **Risk**: Low

## Recommended Action
*(To be filled during triage)*

## Technical Details

**Affected files:**
- `src/main/context-tools.ts` — add `idmlImported` flag, check in `toolRunPython()`
- `src/main/agent-loop.ts` — add `idmlImported?: boolean` to `AgentContext`

**Implementation (Solution A):**
```typescript
// In AgentContext interface:
idmlImported?: boolean;

// In toolRunPython, after IDML import completes:
context.idmlImported = true;

// In toolRunPython, before full pipeline:
if (argParts.some(a => ['--source'].includes(a)) && context.idmlImported) {
  return 'Error: Cannot run full pipeline after IDML import — this would overwrite the designer\'s edits. Use regenerate_output for specific outputs instead.';
}
```

## Acceptance Criteria

- [ ] Full pipeline (`--source`) is blocked after IDML import with clear error message
- [ ] `--regenerate` specific outputs still works after IDML import
- [ ] Protection flag is set automatically (no prompt required)
- [ ] Existing IDML import workflow still works end-to-end

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-03-19 | Created from architectural review | Most-repeated warning in codebase with zero enforcement |

## Resources

- context-tools.ts:87-176 (IDML import path)
- system-prompt.md lines 18, 226
- compound-engineering.local.md line 21
