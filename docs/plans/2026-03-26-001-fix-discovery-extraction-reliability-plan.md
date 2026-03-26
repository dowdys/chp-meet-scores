---
title: "fix: Discovery and extraction reliability for budget models"
type: fix
status: completed
date: 2026-03-26
deepened: 2026-03-26
---

## Enhancement Summary

**Deepened on:** 2026-03-26
**Agents used:** prompt-enforcement-detector, code-simplicity-reviewer

### Key Revision: Original plan was mostly redundant
The simplicity reviewer found that Fixes 3, 4, 5 from the original plan are already implemented in the codebase. Fix 2 (reject >5 IDs) wouldn't catch the observed failure (3 guessed IDs). Fix 1 (cleanAnnotation) is redundant with the Python layer.

### New findings from prompt-enforcement review:
1. **Harmful prompt instruction** at line 113 of workflow-phases.ts: "Once you find a meet on MSO, move directly to extraction — do NOT also search ScoreCat" — this actively prevents finding multi-source championships
2. **Validate extraction IDs against discovered IDs** — make it structurally impossible to use guessed IDs
3. **Gate Chrome tools after search_meets returns results** — not just after set_output_name
4. **Content-filter ask_user during extraction** — reject questions asking for meet IDs
5. **search_meets call counter** — limit to 2 calls, then force ask_user or proceed

---

# Fix: Discovery and Extraction Reliability

## Overview

Budget model stress testing revealed that while most code-level fixes are in place, the discovery-to-extraction workflow has prompt instructions that actively conflict with multi-meet championships, and lacks structural enforcement against ID guessing and unnecessary browsing.

## Fixes (Priority Order)

### Fix 1: Remove harmful "don't search ScoreCat" instruction

**File:** `src/main/workflow-phases.ts` line 113

The instruction "Once you find a meet on MSO, move directly to extraction — do NOT also search ScoreCat/MyMeetScores for the same meet" is actively harmful for multi-source championships like KY (MSO for L2-3, ScoreCat for L4-10). `search_meets` already searches both platforms in a single call. Remove this instruction.

**Acceptance criteria:**
- [ ] Misleading instruction removed from discovery prompt
- [ ] Agent no longer avoids ScoreCat after finding MSO results

### Fix 2: Validate extraction IDs against search results

**Files:** `src/main/context-tools.ts`, `src/main/agent-loop.ts`, `src/main/tools/extraction-tools.ts`

Store discovered meet IDs in context when `search_meets` returns results. Extraction tools (`mso_extract`, `scorecat_extract`) reject any ID not in the discovered set. This makes brute-force ID guessing structurally impossible.

Implementation:
- Add `discoveredMeetIds: Set<string>` to AgentContext (as a string[] for serialization)
- In `executeSingleTool`, after `search_meets` returns, parse Source/ID patterns and add to the set
- In `mso_extract` and `scorecat_extract` executors (or in the executeTool wrapper), reject IDs not in the discovered set
- Include a bypass: if the set is empty (no search was done), allow any ID (for resume scenarios)

**Acceptance criteria:**
- [ ] Guessed IDs rejected with "use search_meets to find IDs first"
- [ ] Legitimately discovered IDs pass through
- [ ] Empty discovered set = no filtering (backward compatible)

### Fix 3: Gate Chrome tools after search_meets returns results

**File:** `src/main/agent-loop.ts`

Currently Chrome tools are gated after `set_output_name` is called. But the agent wastes iterations browsing MSO BEFORE setting the output name. Gate Chrome after `search_meets` returns results instead.

Add `searchMeetsReturned: boolean` to context. Set it when search_meets returns non-empty results. In the tool filter:

```typescript
if (context.currentPhase === 'discovery' && context.searchMeetsReturned) {
  const ALLOWED_AFTER_SEARCH = new Set([
    'search_meets', 'lookup_meet', 'set_output_name', 'ask_user', 'set_phase',
    ...ALWAYS_AVAILABLE_TOOLS
  ]);
  phaseTools = phaseTools.filter(t => ALLOWED_AFTER_SEARCH.has(t.name));
}
```

This replaces the `outputName`-based gating with an earlier trigger.

**Acceptance criteria:**
- [ ] Chrome/browse tools gated after search_meets returns results
- [ ] search_meets, lookup_meet, set_output_name still available
- [ ] Agent cannot browse MSO to "confirm" results

### Fix 4: Content-filter ask_user during extraction

**File:** `src/main/agent-loop.ts`

When the agent calls `ask_user` during the extraction phase, scan the question for patterns like "meet ID", "MSO ID", "ScoreCat ID" and reject with guidance:

```typescript
if (name === 'ask_user' && context.currentPhase === 'extraction') {
  const question = String((args as any).question || '').toLowerCase();
  if (/\bmeet\s*id\b|\bsource\s*id\b|\bmso\s*id\b|\bscorecat\s*id\b/i.test(question)) {
    return 'Error: Do not ask the user for meet IDs. Users do not know platform-specific IDs. ' +
      'Use search_meets to find IDs, or ask for the meet NAME or URL instead.';
  }
}
```

**Acceptance criteria:**
- [ ] Agent cannot ask user for meet IDs during extraction
- [ ] Agent CAN ask legitimate questions ("should I include Level HUG?")

### Fix 5: search_meets call counter

**File:** `src/main/agent-loop.ts`

Track search_meets calls. After 2 calls, return a warning. After 3, return an error directing to ask_user.

**Acceptance criteria:**
- [ ] First 2 calls execute normally
- [ ] Third call returns error with guidance to ask user or proceed

### Fix 6: Deploy pending changes

- Clear Windows __pycache__ (already in sync script)
- lookup_meet ScoreCat redirect (already staged)
- Sync and relaunch

## Implementation Order

1. Fix 1 (remove harmful prompt) — 1 line deletion, highest impact
2. Fix 3 (gate Chrome after search) — replaces outputName-based gating
3. Fix 2 (validate extraction IDs) — structural enforcement
4. Fix 4 (content-filter ask_user) — prevents ID-asking
5. Fix 5 (search call counter) — prevents re-searching
6. Fix 6 (deploy) — sync and relaunch

## Sources

- Prompt-enforcement review: harmful "don't search ScoreCat" instruction
- Simplicity review: original plan fixes 3/4/5 already implemented
- KY process logs showing multi-meet discovery failures
