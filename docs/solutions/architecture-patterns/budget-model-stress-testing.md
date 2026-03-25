---
title: "Budget model stress testing exposes architectural gaps"
category: architecture-patterns
date: 2026-03-25
tags: [testing, budget-models, architecture-over-prompting, agent-loop]
components: [agent-loop, workflow-phases]
severity: p2
---

# Budget model stress testing exposes architectural gaps

## Problem

Smart models (Qwen 397B, Claude Sonnet) compensate for architectural gaps with reasoning. They follow prompt instructions even when the system doesn't enforce them structurally. This hides engineering problems until a weaker model is used.

## Discovery

Stress testing with Gemini Flash Lite ($0.10/M), DeepSeek V3.2 ($0.26/M), and Qwen 3 Coder ($0.22/M) exposed:

1. **Flash Lite**: Ignored "use dedicated tools" instruction, browsed parked domains for 90 iterations instead of calling `scorecat_extract`. Returned empty responses and quit after 1 iteration on structured input.
2. **DeepSeek V3.2**: Kept searching after finding a clear match. Asked if "all levels includes Xcel". Asked for dates multiple times across phases.
3. **Qwen 3 Coder**: Handled import_backs well (simple, prescriptive phase) but opened files sequentially instead of in parallel.

## Key Insight

If a budget model fails at a task, the architecture has a gap. The fix is never "add more prompt instructions" — it's to make the wrong action structurally impossible (or at least harder than the right action).

## Fixes Applied

| Budget model failure | Architectural fix |
|---------------------|-------------------|
| Browsed instead of using dedicated tools | Removed Chrome from extraction phase defaults |
| Kept searching after clear match | Tool gating: remove search tools after match found |
| Didn't know Xcel is USAG | Domain knowledge in base prompt (acceptable — factual, not behavioral) |
| Lost dates across phases | Store dates on context, auto-inject when agent omits them |
| Created duplicate folders | Prevent name change when folder has files, auto-correct meet_name to match outputName |

## When to Use

Run a meet through the full workflow with `qwen/qwen3-coder` or `deepseek/deepseek-v3.2-20251201` after any architectural change. If the budget model fails, there's a gap to close. The production model (Qwen 397B) stays for real work.
