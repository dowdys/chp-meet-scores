---
title: "Tool/Skill Document Drift Causes Agent Confusion"
date: 2026-04-03
problem_type: architecture_decision
severity: high
module: agent-loop, workflow-phases, skills
component: tool-definitions, skill-documents, phase-prompts
tags: [agent-reliability, tool-gating, skill-documents, maintenance-pattern]
category: architecture-patterns
track: knowledge
applies_when: Adding, renaming, removing, or deprecating any agent tool
---

# Tool/Skill Document Drift Causes Agent Confusion

## Context

The GMS app has an inner AI agent (Claude) that uses tools defined in `tool-definitions.ts` and guided by skill documents in `skills/*.md`. The tool schemas tell the LLM what tools exist and what parameters they accept. The skill documents provide human-readable instructions for multi-step workflows. Phase prompts in `workflow-phases.ts` tell the agent what's available and how to use it in each phase.

Over time, tools were renamed (`run_python` → `build_database`), deprecated (`--import-idml` → `import_pdf_backs`), and added (`fix_names`, `web_search` in discovery) — but the skill documents and phase prompts were not updated simultaneously. This created a systemic drift where the agent received instructions referencing tools that no longer existed.

## Guidance

**Every tool change requires a cross-cutting update across three layers:**

1. **Tool definitions** (`src/main/tool-definitions.ts`) — the schema the LLM sees
2. **Skill documents** (`skills/*.md`) — workflow instructions that reference tools by name
3. **Phase prompts** (`src/main/workflow-phases.ts`) — per-phase instructions and tool lists

When adding, renaming, removing, or deprecating a tool:

```bash
# After any tool change, grep all three layers:
grep -r "old_tool_name" skills/ src/main/workflow-phases.ts src/main/tool-definitions.ts
```

If a tool is added to a phase's tool list, it must also be documented in that phase's prompt section — otherwise the agent has access to the tool but doesn't know it exists or when to use it.

## Why This Matters

A 6-agent codebase review (2026-04-03) found this drift was the primary source of agent confusion in production:

- **3 skills** referenced `run_python` (deleted months earlier, replaced by `build_database`) — agent tried to call it, got "tool not found", and stalled
- **`output_generation.md`** documented `--import-idml` as the current workflow — agent attempted it, Python errored 100% of the time
- **`workflow-phases.ts`** line 121 referenced `import_idml` tool — didn't exist in `tool-definitions.ts`
- **`fix_names`** was added to phase tool lists but not documented in phase prompts — agent hit the suspicious names deadlock and didn't know `fix_names` existed to break it
- **`web_search`** was added to discovery tools but the discovery prompt's "Fallback Search" section didn't mention it

The agent's behavior directly mirrors what it's told. If a skill says "call `run_python`", the agent will try to call `run_python` — regardless of what tools actually exist. Prompt instructions that reference non-existent tools are worse than no instructions at all, because the agent wastes iterations trying to follow them.

## When to Apply

- Adding a new tool to `tool-definitions.ts`
- Renaming a tool (even just changing the string name)
- Removing or deprecating a tool
- Moving a tool between phases (changing which phase's tool list it appears in)
- Adding a tool to `ALWAYS_AVAILABLE_TOOLS`

## Examples

**Before (drift):**
```
# skills/scorecat_extraction.md (Step 5)
Run the Python adapter: `run_python --source scorecat --data athletes.json`
```
Tool `run_python` doesn't exist. Agent fails.

**After (aligned):**
```
# skills/scorecat_extraction.md (Step 5)
After extraction, use the `build_database` tool with `source: "scorecat"` and the extracted data file path.
```
References the actual tool that exists in tool-definitions.ts.

**Before (undocumented tool):**
```typescript
// workflow-phases.ts — output_finalize phase
tools: ['regenerate_output', 'fix_names', ...],
prompt: `## Output Generation
Use regenerate_output to generate outputs...`
// fix_names never mentioned in prompt
```
Agent has access to `fix_names` but doesn't know to use it.

**After (documented):**
```typescript
prompt: `### Fixing Issues During Output
- **Suspicious names**: If regenerate_output detects names with event code
  suffixes, use fix_names with the meet name and corrections...`
```

## Prevention

After any tool change, run this verification:

1. `grep -r "tool_name" skills/` — check all skill documents
2. `grep "tool_name" src/main/workflow-phases.ts` — check phase prompts and tool lists
3. Verify the tool appears in the correct phase's prompt section (not just tool list)
4. Run `npx vitest run src/main/__tests__/workflow-phases.test.ts` — catches tool list mismatches

## Related

- CLAUDE.md "Architecture Over Prompting" principle — the same principle applies to documentation alignment
- `docs/solutions/architecture-patterns/chrome-tools-removed-from-extraction.md` — specific instance of this pattern (removing tools from a phase)
