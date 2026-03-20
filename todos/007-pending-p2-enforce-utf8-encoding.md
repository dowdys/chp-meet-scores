---
status: pending
priority: p2
issue_id: "007"
tags: [code-review, architecture, prompt-vs-code, bug-prevention]
dependencies: []
---

# Enforce UTF-8 Encoding via Environment Variable

## Problem Statement

The system prompt says "IMPORTANT: When using run_script to read files on Windows, ALWAYS use encoding='utf-8'" because Windows defaults to cp1252 which crashes on Unicode characters in athlete names (accented characters are common). This is enforced only through prompting.

## Findings

- **system-prompt.md:152-153**: Encoding requirement stated twice
- **python-tools.ts**: `run_script` executor does not set `PYTHONUTF8` env var

## Proposed Solutions

### Solution A: Set PYTHONUTF8=1 environment variable (Recommended)
Python 3.7+ respects `PYTHONUTF8=1` to make all `open()` calls default to UTF-8. One environment variable eliminates the entire class of encoding errors.

- **Pros**: One line of code; eliminates all encoding crashes; no prompt needed
- **Cons**: None meaningful
- **Effort**: Tiny (10 min)
- **Risk**: Very low

**Implementation:**
```typescript
const envVars = {
  ...existingEnvVars,
  PYTHONUTF8: '1',
};
```

## Acceptance Criteria

- [ ] `PYTHONUTF8=1` set for all Python subprocess calls
- [ ] Encoding-related prompt warnings can be removed from system-prompt.md

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-03-19 | Created from architectural review | 1 env var replaces 2 prompt warnings |

## Resources

- python-tools.ts (run_script executor)
- system-prompt.md lines 152-153
- Python docs: https://docs.python.org/3/using/cmdline.html#envvar-PYTHONUTF8
