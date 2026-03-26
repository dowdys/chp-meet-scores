---
title: "Discovery ID validation and progressive tool gating"
category: architecture-patterns
date: 2026-03-26
tags: [discovery, extraction, tool-gating, id-validation, budget-models]
components: [agent-loop, search-tools, workflow-phases]
severity: p1
---

# Discovery ID validation and progressive tool gating

## Problem

Budget models in the discovery/extraction flow exhibited three failure patterns:
1. **Brute-force ID guessing**: Called `mso_extract` with random IDs like `["37000", "37500", "38000"]`
2. **Unnecessary browsing**: Used Chrome to navigate to MSO and take screenshots to "confirm" search results
3. **Excessive re-searching**: Called `search_meets` 4-5 times with slight keyword variations

## Root Cause

All three are the same underlying issue: the architecture provided tools without enforcing a logical sequence. The agent had extraction tools + Chrome tools + search tools simultaneously, with only prompt instructions ("trust the results", "call search_meets ONCE") to guide ordering.

## Solution: Progressive tool gating

Gate tools based on what has ALREADY HAPPENED in the session, not just the current phase:

### 1. After search_meets returns results → gate Chrome/browse tools
```typescript
if (context.searchMeetsReturned) {
  // Only search_meets, lookup_meet, set_output_name, ask_user, set_phase remain
  phaseTools = phaseTools.filter(t => ALLOWED_AFTER_SEARCH.has(t.name));
}
```

### 2. Extraction tools validate IDs against discovered set
```typescript
if (context.discoveredMeetIds?.length > 0) {
  const undiscovered = meetIds.filter(id => !context.discoveredMeetIds.includes(id));
  if (undiscovered.length > 0) return 'Error: ID not found by search_meets';
}
```

### 3. search_meets limited to 2 calls
Third call returns error directing agent to ask_user or proceed.

## Key Insight: Progressive vs Phase-Based Gating

Phase-based gating (discovery/extraction/database) controls WHAT CATEGORY of tools is available. Progressive gating controls WHICH tools within a phase based on SESSION STATE. Both are needed:

- Phase gating: "You can't build a database during discovery"
- Progressive gating: "You can't browse Chrome after getting search results"

## Also Fixed: Harmful Prompt Instruction

The discovery prompt said "Once you find a meet on MSO, move directly to extraction — do NOT also search ScoreCat." This actively prevented finding multi-source championships (e.g., KY with MSO for L2-3 + ScoreCat for L4-10). Replaced with "championships are split across MULTIPLE meets on DIFFERENT platforms — extract ALL."

## Prevention Rule

When a prompt instruction says "do NOT do X after Y", ask: can we structurally prevent X after Y? If yes, gate the tool instead of adding a prompt warning.
