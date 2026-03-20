---
status: pending
priority: p1
issue_id: "001"
tags: [code-review, architecture, prompt-vs-code]
dependencies: []
---

# Split `run_python` God Tool Into Typed Purpose-Specific Tools

## Problem Statement

The `run_python` tool does 5 completely different things via a single free-form `args: string` parameter. Its tool description is ~3,000 characters of documentation teaching the agent which flag combinations are valid, dangerous, or deprecated. This is the single largest example of "prompt where architecture should be" in the codebase.

Invalid flag combinations (e.g., `--source generic` after `--import-idml`) are prevented only by prompt instructions repeated 4+ times across the codebase.

## Findings

- **tool-definitions.ts:132-141**: Single `args` string accepts any flag combination
- **context-tools.ts:61-199**: `toolRunPython()` does complex mode detection via string parsing
- **system-prompt.md**: Multiple warnings about flag combinations (lines 18, 226, 229)
- The tool description is sent with every API call, costing ~3KB of tokens per turn

The 5 distinct modes crammed into one tool:
1. Full pipeline (`--source --data --state --meet`)
2. Selective regeneration (`--regenerate shirt,order_forms`)
3. IDML import (`--import-idml <path>`)
4. IDML import with dates (`--import-idml <path> --postmark-date ...`)
5. Date-only update (`--regenerate order_forms --postmark-date ...`)

## Proposed Solutions

### Solution A: Split into 3 typed tools (Recommended)
Create `build_database`, `regenerate_output`, and `import_idml` tools with proper JSON schemas. Each has typed, required/optional parameters instead of a free-form string. Invalid combinations become structurally impossible.

- **Pros**: Eliminates entire class of flag-combination errors; reduces prompt overhead by ~3KB per API call; simpler agent decision-making
- **Cons**: More tool definitions; requires refactoring tool-definitions.ts and context-tools.ts; slight migration risk
- **Effort**: Medium (1-2 days)
- **Risk**: Low — internal refactor, no Python changes needed

### Solution B: Validate flag combinations in toolRunPython()
Keep the single tool but add a validation layer that rejects known-bad combinations before calling Python.

- **Pros**: Smaller change; same Python interface
- **Cons**: Still requires the massive tool description; validation is a whitelist/blacklist that may miss edge cases; doesn't reduce prompt overhead
- **Effort**: Small (few hours)
- **Risk**: Low

### Solution C: Typed args object instead of string
Change `args` from `string` to a typed JSON object with proper schema validation while keeping a single tool.

- **Pros**: Better than string parsing; schema prevents some invalid combos
- **Cons**: One tool still doing 5 things; description still large; requires Python CLI interface change or a mapping layer
- **Effort**: Medium
- **Risk**: Medium — touches both TypeScript and Python interface

## Recommended Action
*(To be filled during triage)*

## Technical Details

**Affected files:**
- `src/main/tool-definitions.ts` — tool schema definitions
- `src/main/context-tools.ts` — `toolRunPython()` implementation
- `src/main/agent-loop.ts` — `executeTool()` switch statement
- `skills/system-prompt.md` — can remove ~30 lines of flag documentation

**Schema example for split tools:**
```typescript
build_database: {
  source: { enum: ['scorecat', 'mso_pdf', 'mso_html', 'generic'] },
  data_path: string,
  state: string,
  meet_name: string,
  association?: string,
  year?: number,
  layout_params?: { line_spacing?, level_gap?, max_fill?, ... }
}

regenerate_output: {
  state: string,
  meet_name: string,
  outputs: string[],  // ['shirt', 'order_forms', 'gym_highlights', ...]
  layout_params?: { ... },
  date_params?: { postmark_date?, online_date?, ship_date? }
}

import_idml: {
  idml_path: string,
  date_params?: { ... }
}
```

## Acceptance Criteria

- [ ] `run_python` replaced by 3+ purpose-specific tools with typed schemas
- [ ] Invalid flag combinations are structurally impossible (not just warned about)
- [ ] Tool descriptions are concise (< 500 chars each)
- [ ] All existing test/usage patterns still work
- [ ] System prompt flag documentation reduced by ~30 lines

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-03-19 | Created from architectural review | Identified as #1 prompt-vs-architecture opportunity |

## Resources

- tool-definitions.ts:132-141
- context-tools.ts:61-199
- system-prompt.md lines 18, 226, 229
