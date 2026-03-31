---
title: "Fix agent reliability and ordering bugs across 14 categories"
type: fix
status: active
date: 2026-03-31
---

# Fix Agent Reliability and Ordering Bugs

## Enhancement Summary

**Deepened on:** 2026-03-31
**Sections enhanced:** All 17 items reviewed and refined
**Review agents used:** architecture-strategist, publishing-pipeline-guardian, code-simplicity-reviewer, prompt-enforcement-detector, data-integrity-guardian, learnings-researcher

### Key Improvements from Reviews
1. **3.1 dropped** — TypeScript-side level normalization is fully redundant with 1.1 (Python fix). Eliminates cross-language constant sync burden.
2. **2.4 simplified** — Instead of adding `getExistingStagingDbPath()`, fix the existing `getStagingDbPath()` to not create phantom paths when `currentStagingDbPath` is null.
3. **1.3 refined** — Don't fully remove cascade. Narrow it: `shirt` cascades to `order_forms` + `summary` only (drop `idml` + `gym_highlights` from cascade). No `shirt_only` parameter needed.
4. **3.4 strengthened** — Instead of appending instructions to tool results (prompt enforcement), architecturally gate `regenerate_output` when suspicious names exist.
5. **New: 1.6** — Wrap `build_database` Python body in a single atomic transaction (prevents partial state on crash).
6. **New: 2.6** — Wrap meet rename in `publishMeet` in a transaction (prevents split-name state).
7. **`buildDatabaseFailed` must be persisted** in `ProgressData` per learning `persist-destructive-operation-guards`.

### Learnings Applied
- `level-groups-must-be-sticky` — Confirms `division_order` is safe to persist (ordering, not filtering)
- `sticky-params-silently-exclude` — Counter-context: `division_order` reorders but does NOT exclude athletes, so persistence is safe
- `persist-destructive-operation-guards` — `buildDatabaseFailed` flag MUST be serialized in `ProgressData` for save/resume
- `switch-phase-helper-invariant` — All phase changes must use `switchPhase()`, not direct assignment
- `just-pruned-flag-prevents-premature-exit` — Sparse handoff safety net must set `justPruned = true`
- `context-pruning-with-llm-summary` — Explains why Oregon handoff went empty (ask_user was last tool, no agent text to extract)
- `run-script-vs-run-python-env-vars` — DB paths must be CLI args, not env vars, for `build_database`/`regenerate_output`
- `warn-but-proceed-not-block-and-retry` — SUSPICIOUS_NAMES fix should direct (provide exact fix command), not block-and-retry

## Overview

Analysis of 5 process logs (Missouri, Tennessee, Kansas, Alabama, Oregon) and user-reported issues revealed 40+ bugs across 14 categories. The core theme: **the Python pipeline has correctness bugs that no amount of agent prompting can fix**, and **the agent architecture allows the LLM to make structural mistakes that should be impossible**.

This plan prioritizes fixes by blast radius. Phase 1 fixes produce-wrong-output bugs in Python. Phase 2 fixes architecture gaps that let the agent get stuck or lose context. Phase 3 adds guardrails that make correct behavior the only path.

## Prior Art

- `docs/plans/2026-03-19-004` (completed) — Fixed `_page_h` crash, division ordering source fix in `division_detector.py`, stale file cleanup
- `docs/plans/2026-03-20-006` (partially completed) — Fixed MSO duplicate extraction, legal-size matching, name cleaning regex, `level_groups` persistence
- `docs/plans/2026-03-20-010` (partially completed) — Fixed stale extraction file cleanup, date passthrough to `build_database`

Some issues from those plans have regressed or were only partially fixed. This plan addresses remaining gaps and new issues discovered in the March 27-31 logs.

---

## Phase 1: Python Pipeline Correctness (P0)

These bugs produce wrong output silently. No agent behavior change can fix them.

### 1.1 `parse_level_groups()` must auto-sort levels within each group

**Problem**: `parse_level_groups()` in `layout_engine.py:278-323` preserves the caller's level order verbatim. If the agent passes `"6,7,8,9,10"`, levels appear ascending on the shirt (wrong — should be 10,9,8,7,6). The agent in Missouri spent 6+ iterations unable to fix this because it confused `level_groups` order with `division_order`.

**Root cause**: The auto-sort at lines 187-189 only applies when `level_groups` is None. Custom groups bypass sorting entirely.

**Fix**: After parsing each group in `parse_level_groups()`, auto-sort the levels within that group using a three-bucket sort:

1. **Xcel levels** — sorted by `XCEL_PRESTIGE_ORDER` (Sapphire first, Bronze last)
2. **Numbered levels** — sorted descending by int value (10, 9, 8, ...)
3. **Other levels** ("Senior", "2A", "Adults", "PR") — preserved in their original relative order, placed between Xcel and numbered

```python
# In parse_level_groups(), after filtering valid levels for each group:
def _sort_group(levels):
    xcel = []
    numbered = []
    other = []
    for lv in levels:
        if XCEL_MAP.get(lv) in XCEL_PRESTIGE_ORDER:
            xcel.append(lv)
        elif lv.isdigit():
            numbered.append(lv)
        else:
            other.append(lv)  # preserve original order
    xcel.sort(key=lambda x: XCEL_PRESTIGE_ORDER.index(XCEL_MAP[x]))
    numbered.sort(key=lambda x: -int(x))
    return xcel + other + numbered
```

**IMPORTANT** (from publishing-pipeline-guardian): The existing code at `layout_engine.py:187` uses `XCEL_ORDER.index(...)` but `XCEL_ORDER` is imported as `XCEL_PRESTIGE_ORDER` (a list) via the alias `from constants import XCEL_PRESTIGE_ORDER as XCEL_ORDER`. Verify this import is correct in the actual file — if `XCEL_ORDER` resolves to the dict from `constants.py:23` instead of the list, `.index()` will raise `AttributeError`. Use `XCEL_PRESTIGE_ORDER` explicitly to avoid ambiguity.

Also: pass the sorted list to `label_group()`, not the original unsorted `group_levels`.

**Files**: `python/core/layout_engine.py:278-323`

**Acceptance criteria**:
- [ ] `parse_level_groups("6,7,8,9,10")` produces levels in order `[10, 9, 8, 7, 6]`
- [ ] `parse_level_groups("XB,XS,XG")` produces levels in order `[XG, XS, XB]` (prestige order)
- [ ] `parse_level_groups("XSA,XD,XP,XG,XS,XB;6,7,8,9,10")` produces two groups, each correctly sorted
- [ ] Non-standard levels like "Senior", "2A", "Adults" preserve their relative order and sort between Xcel and numbered
- [ ] Agent passing levels in any order always gets correct shirt output

---

### 1.2 `meet_summary.py` WINNERS PER LEVEL must use canonical level ordering

**Problem**: The WINNERS PER LEVEL section orders by `CAST(level AS INTEGER)`, which puts all Xcel levels at 0 (undefined relative order among them), then numbered levels ascending. Seen in Tennessee, Kansas, and Alabama summaries — Xcel levels appear in random order.

**Fix**: Use the same three-bucket Python-side sort from 1.1 after fetching levels from the DB. Also apply to the "Levels:" summary line (must sort before that line is generated).

**Files**: `python/core/meet_summary.py:121-136`

**Acceptance criteria**:
- [ ] WINNERS PER LEVEL shows Xcel in order: Sapphire, Diamond, Platinum, Gold, Silver, Bronze
- [ ] Numbered levels follow in descending order: 10, 9, 8, ..., 2
- [ ] "Levels:" summary line also uses canonical ordering
- [ ] Consistent with SHIRT BACK PAGES ordering

---

### 1.3 Narrow `regenerate_output` cascade (don't regenerate everything on shirt change)

**Problem**: Across ALL logs, requesting `outputs: ["shirt", "idml"]` regenerates all 5 outputs because `process_meet.py:764-766` cascades `shirt` to add everything.

**Fix** (refined per architecture review): Don't fully remove the cascade — narrow it. When `shirt` is in the regeneration set:
- **Keep in cascade**: `order_forms` (embeds shirt PDF pages) + `summary` (depends on layout data)
- **Remove from cascade**: `idml` (re-derives layout independently) + `gym_highlights` (independent of shirt PDF)

```python
# Replace lines 764-766:
if 'shirt' in regen_set:
    # order_forms embeds shirt pages, summary reads layout data — must stay in sync
    regen_set.update(['order_forms', 'summary'])
    # idml and gym_highlights are independent — don't cascade
```

This cuts regeneration time roughly in half for layout tweaks while keeping the shirt ↔ order_forms dependency intact.

**Files**: `python/process_meet.py:764-766`

**Acceptance criteria**:
- [ ] `--regenerate shirt` regenerates shirt + order_forms + summary (not idml or gym_highlights)
- [ ] `--regenerate shirt,idml` regenerates shirt + idml + order_forms + summary
- [ ] `--regenerate all` still regenerates everything
- [ ] Order forms always reflect the current shirt layout

---

### 1.4 Name cleaning regex must handle space-separated event annotations

**Problem**: Missouri had 4 athletes with garbled names like "Grace Gosselin VT Bars BM". The `cleanName()` regex only handles comma-separated abbreviations.

**Fix**: Expand the regex in both TypeScript and Python. Add `Bars?`, `Beam`, `BM`, `Floor` to the pattern. Keep the `$` end anchor to prevent false positives on mid-name substrings.

**Caution** (from data-integrity-guardian): The single-character codes `V`, `Be`, `Fl` already exist in the current regex and risk false-positives on names ending with initials (e.g., "Emma V" would strip the "V"). This is a pre-existing risk, not introduced by this fix, but note it in comments.

**Files**: `src/main/tools/extraction-tools.ts:24`, `python/core/db_builder.py` (`_EC` constant and `_CLEANUP_PATTERNS`)

**Acceptance criteria**:
- [ ] "Grace Gosselin VT Bars BM" → "Grace Gosselin"
- [ ] "Meg Sexton - VT BM" → "Meg Sexton"
- [ ] "Brooklyn Deckelman - BM" → "Brooklyn Deckelman"
- [ ] "Jane Smith VT,BB,FX" → "Jane Smith" (existing behavior preserved)
- [ ] "Jane Smith" → "Jane Smith" (no false positives)
- [ ] "Ana Beamer" → "Ana Beamer" (no false positive on "Beam" prefix)

---

### 1.5 Tennessee crash in `_build_winners_score_based` — diagnose and fix

**Problem**: Tennessee's `build_database` crashed 3 times at `db_builder.py:175`. Agent hallucinated success and continued with a stale/broken database.

**Fix**:
- Add defensive NULL coalescing for `session`, `level`, `division` columns (coalesce to empty string)
- Add per-row try/except around winner inserts that logs the failing row data
- Ensure `_find_solo_sessions` handles empty strings and NULLs gracefully

**Confirmed safe** (from data-integrity-guardian): `_create_winners_table` at line 239 already runs `DELETE FROM winners WHERE meet_name = ?` before inserting, so re-running after a crash is safe — no duplicate insertion risk.

**Files**: `python/core/db_builder.py:175-342`

**Acceptance criteria**:
- [ ] Tennessee ScoreCat data processes without crash
- [ ] NULL/empty session, level, or division values handled gracefully
- [ ] Winner build errors are logged with the failing row, not just a raw traceback

---

### 1.6 Wrap `build_database` in a single atomic transaction (NEW)

**Problem** (from data-integrity-guardian): `build_database` currently commits after athletes (line 164), then separately commits after division normalization (line 170), then commits after winners (line 342). If the process crashes between commits, the staging DB has results but no winners — structurally inconsistent.

**Fix**: Wrap the entire `build_database` body — DELETE through winner commit — in a single `with conn:` context manager. This makes the operation atomic.

```python
conn = sqlite3.connect(db_path)
try:
    with conn:  # single atomic transaction
        cur = conn.cursor()
        # ... all DDL, DELETE, INSERT, normalize, winners ...
finally:
    conn.close()
```

**Files**: `python/core/db_builder.py:82-178`

**Acceptance criteria**:
- [ ] Successful build commits all results + winners atomically
- [ ] Crash during winner build leaves staging DB unchanged (no partial state)
- [ ] Re-running after crash starts from a clean slate

---

## Phase 2: Architecture Fixes (P1)

These bugs cause the agent to get stuck, lose context, or enter unrecoverable states.

### 2.1 `build_database` failure must block phase advancement

**Problem**: Tennessee — `build_database` failed 3x but agent advanced to output_finalize.

**Fix**: Set `context.buildDatabaseFailed = true` when `runPython()` returns a failure string. Gate `set_phase` to block advancement past `database`.

**CRITICAL** (from learning `persist-destructive-operation-guards`): The `buildDatabaseFailed` flag MUST be persisted in `ProgressData` and serialized in `toolSaveProgress`/`autoSaveProgress`/`loadProgressData`. Without this, save/resume bypasses the guard.

Also (from data-integrity-guardian): Move the meets metadata write (lines 237-260) to AFTER the failure check, so metadata isn't written to a broken staging DB.

```typescript
// In toolBuildDatabase, after runPython():
if (result.includes('Python script failed')) {
  context.buildDatabaseFailed = true;
  return result;
}
context.buildDatabaseFailed = false;
// THEN write meets metadata (only on success)
```

```typescript
// In toolSetPhase(), add guard:
if (context.buildDatabaseFailed && (phase === 'output_finalize' || phase === 'import_backs')) {
  return 'Error: Cannot advance — build_database has not completed successfully. Fix the build error and re-run build_database.';
}
```

```typescript
// In AgentContext interface, add:
buildDatabaseFailed?: boolean;

// In ProgressData interface, add:
build_database_failed?: boolean;

// In toolSaveProgress, add to progressData:
build_database_failed: context.buildDatabaseFailed || undefined,

// In loadProgressData restore:
if (savedProgress.build_database_failed) context.buildDatabaseFailed = true;
```

**Files**: `src/main/context-tools.ts` (AgentContext, ProgressData, toolBuildDatabase, toolSetPhase, toolSaveProgress, loadProgressData)

**Acceptance criteria**:
- [ ] Agent cannot call `set_phase("output_finalize")` after a failed `build_database`
- [ ] Successful `build_database` clears the block
- [ ] Flag survives save/resume cycle
- [ ] Meets metadata only written after successful build

---

### 2.2 Phase handoff must never produce empty context

**Problem**: Oregon IDML log — phase handoff was COMPLETELY EMPTY.

**Root cause** (confirmed by learning `context-pruning-with-llm-summary`): If the prior phase ended with `ask_user` as the last tool and the agent's response was just the tool_use block (no text), `agentTexts` is empty. The LLM summary timed out or failed.

**Fix** (refined per architecture review): Replace the character-count threshold with an explicit emptiness check on the two key collections:

```typescript
// After building the handoff parts:
const hasContent = agentTexts.length > 0 || askUserExchanges.length > 0 || keyToolResults.length > 0;
if (!hasContent) {
  // Safety: keep recent messages as text-only (strip tool_use/tool_result blocks)
  console.warn('[AGENT] Handoff empty — preserving recent text from last 5 messages');
  const recentText = messages.slice(-5)
    .flatMap(m => typeof m.content === 'string' ? [m.content] :
      m.content.filter(b => b.type === 'text').map(b => b.text))
    .join('\n\n');
  context.messages = [{
    role: 'user',
    content: `[Phase: ${fromPhase} → ${context.currentPhase}]\n\n${recentText || 'No context available — ask the user what to do.'}`
  }];
  context.justPruned = true;  // per learning: must set to prevent premature exit
  return;
}
```

**Important** (from architecture review): Strip tool_use/tool_result blocks from the fallback — they reference tools that may not exist in the new phase and would confuse the LLM.

**Files**: `src/main/agent-loop.ts:811-1003` (pruneContextForPhaseTransition)

**Acceptance criteria**:
- [ ] Phase handoff never produces empty context
- [ ] Fallback keeps text-only content from recent messages
- [ ] `justPruned` is set in the fallback path
- [ ] Agent in new phase has enough context to continue without re-asking

---

### 2.3 Add `regenerate_output` to `import_backs` phase tools

**Problem**: Oregon IDML log — IDML generation structurally impossible from import_backs phase.

**Fix**: Add `regenerate_output` to the tool list. Update the prompt to correct the false "NEVER use regenerate_output" statement.

**Important** (from prompt-enforcement review): The code guard at `context-tools.ts:287` already blocks `shirt` and `all` when `idmlImported` is true. The prompt change is documentation cleanup, not enforcement — the code is already the authority.

**Also important** (from publishing-pipeline-guardian): IDML generated post-import will NOT match the designer's imported PDF — it re-derives layout from the DB. This should be noted in the prompt so the agent can warn the user.

```typescript
// In workflow-phases.ts, import_backs phase tools — add:
'regenerate_output',
```

```
// Update import_backs prompt, replace "NEVER use build_database or regenerate_output":
- NEVER use `build_database` after import — it destroys designer edits
- NEVER regenerate `shirt` or `all` after import — they overwrite imported backs
- You CAN use `regenerate_output` with outputs: ["idml"], ["order_forms"], ["gym_highlights"], or ["summary"]
- Note: IDML generated post-import reflects DATABASE layout, not the designer's visual edits
```

**Files**: `src/main/workflow-phases.ts:292-295` (tools), `src/main/workflow-phases.ts:338-341` (prompt)

**Acceptance criteria**:
- [ ] IDML can be generated from import_backs phase
- [ ] `regenerate_output` with `outputs: ["shirt"]` still blocked after import
- [ ] Prompt no longer says "NEVER use regenerate_output"

---

### 2.4 Fix `getStagingDbPath()` phantom path side-effect

**Problem**: After `finalize_meet` sets `currentStagingDbPath = null`, calling `getStagingDbPath()` creates a new phantom path as a side effect — corrupting the module state for all subsequent callers in the session.

**Fix** (simplified per code-simplicity review): Don't add a new function. Fix the existing `getStagingDbPath()` to not auto-create when the path is null — split into "get or create" (used by `toolBuildDatabase`) and "get if exists" (used by everything else):

```typescript
// Rename existing function for clarity:
export function getOrCreateStagingDbPath(): string {
  if (!currentStagingDbPath) {
    currentStagingDbPath = path.join(getDataDir(), `staging_${Date.now()}.db`);
  }
  return currentStagingDbPath;
}

// New: returns null if no staging DB exists
export function getStagingDbPath(): string | null {
  if (currentStagingDbPath && fs.existsSync(currentStagingDbPath)) {
    return currentStagingDbPath;
  }
  return null;
}
```

Update callers:
- `toolBuildDatabase` (line 231): use `getOrCreateStagingDbPath()` — needs to create on first use
- `toolRegenerateOutput` (line 348): use `getStagingDbPath()` — should not create
- `toolImportPdfBacks` (line 433): use `getStagingDbPath()` — should not create
- `run_script` (line 98): use `getStagingDbPath()` — should not create

**Files**: `src/main/tools/python-tools.ts:18-25`, `src/main/context-tools.ts` (all callers)

**Acceptance criteria**:
- [ ] `regenerate_output` after `finalize_meet` uses central DB (not a phantom staging path)
- [ ] `regenerate_output` during processing still uses staging DB
- [ ] `getStagingDbPath()` never creates a phantom path as side effect
- [ ] `toolBuildDatabase` still creates staging DB on first use

---

### 2.5 Layout parameter persistence for `division_order`

**Problem**: Division ordering is lost between `regenerate_output` calls.

**Fix**: Persist `division_order` in `shirt_layout.json` as the comma-separated string (same format as CLI `--division-order`). Read it back as default when `--division-order` is not provided on CLI.

**Safe to persist** (confirmed by learning `sticky-params-silently-exclude`): `division_order` reorders presentation but does NOT exclude athletes, so it's safe to make sticky (unlike `exclude_levels` which was the problem in that learning).

**Serialization** (per Gap 3): Save the raw CLI string. Restore by passing to `args.division_order`:
```python
# Write path (after successful shirt generation):
if args.division_order:
    saved_layout['division_order'] = args.division_order

# Read path (inside --regenerate branch):
if args.division_order is None and 'division_order' in saved_layout:
    args.division_order = saved_layout['division_order']
```

This mirrors how `level_groups` is already handled at lines 896-897.

**Files**: `python/process_meet.py` (shirt_layout.json read/write sections)

**Acceptance criteria**:
- [ ] `division_order` set during `build_database` survives into `regenerate_output` calls
- [ ] Explicit CLI `--division-order` overrides the saved value
- [ ] Date-only regeneration preserves both level grouping AND division ordering

---

### 2.6 Remove raw Chrome from discovery; add site-specific browse tools (NEW)

**Problem**: Agent repeatedly navigates to `scorecat.com` instead of `scorecatonline.com`, and browses MSO manually instead of trusting `search_meets`. The existing gate (remove Chrome tools after `search_meets` returns) helps but doesn't prevent pre-search browsing.

**Fix**: Remove ALL raw Chrome tools (`chrome_navigate`, `chrome_execute_js`, `chrome_screenshot`, `chrome_click`) and `web_search` (uses Chrome for Google) from the discovery phase. Replace with two site-specific tools that construct correct URLs:

**`browse_mso(meet_id)`**:
- Navigates Chrome to `https://www.meetscoresonline.com/R{meet_id}`
- Takes a screenshot automatically
- Extracts key page text (meet name, dates, levels)
- Returns screenshot + extracted metadata
- Agent cannot control the URL — tool constructs it

**`browse_scorecat(meet_id)`**:
- Navigates Chrome to `https://results.scorecatonline.com/meets/{meet_id}`
- Takes a screenshot automatically
- Extracts key page text
- Returns screenshot + extracted metadata

**Discovery phase tools after this change**:
```typescript
tools: [
  'search_meets', 'lookup_meet', 'http_fetch',
  'browse_mso', 'browse_scorecat',  // site-specific, URL-safe
  'set_output_name',
],
// REMOVED: chrome_navigate, chrome_execute_js, chrome_screenshot, chrome_click, web_search
```

**Unknown-source agent** (loaded via `unknown_source_extraction` skill) keeps the full raw Chrome toolkit for unfamiliar platforms.

**Also remove the `searchMeetsReturned` Chrome gating logic** from `agent-loop.ts:343-351` — no longer needed since Chrome tools aren't in discovery at all.

**Files**: `src/main/workflow-phases.ts:67-69` (discovery tools), `src/main/tools/browser-tools.ts` (new `browse_mso`/`browse_scorecat` executors), `src/main/tool-definitions.ts` (new tool schemas), `src/main/agent-loop.ts:343-351` (remove Chrome gating)

**Acceptance criteria**:
- [ ] Agent cannot navigate to wrong URLs during discovery
- [ ] `browse_mso("34670")` navigates to `meetscoresonline.com/R34670` and returns screenshot + metadata
- [ ] `browse_scorecat("VQS0J5FI")` navigates to `results.scorecatonline.com/meets/VQS0J5FI` and returns screenshot + metadata
- [ ] Raw Chrome tools still available via `unlock_tool` or `unknown_source_extraction` skill
- [ ] `searchMeetsReturned` gating logic removed (no longer needed)

---

### 2.7 Wrap meet rename in `publishMeet` in a transaction (NEW)

**Problem** (from data-integrity-guardian): `publishMeet` in `supabase-sync.ts:284-290` renames the meet across `meets`, `results`, and `winners` in three separate UPDATE statements with no transaction. If the process dies mid-rename, the central DB has a split-name state.

**Fix**: Wrap the three UPDATEs in a `better-sqlite3` transaction:

```typescript
const rename = db.transaction(() => {
  db.prepare('UPDATE meets SET meet_name = ? WHERE meet_name = ?').run(canonicalName, meetName);
  db.prepare('UPDATE results SET meet_name = ? WHERE meet_name = ?').run(canonicalName, meetName);
  db.prepare('UPDATE winners SET meet_name = ? WHERE meet_name = ?').run(canonicalName, meetName);
});
rename();
```

**Files**: `src/main/supabase-sync.ts:284-290`

**Acceptance criteria**:
- [ ] All three tables renamed atomically
- [ ] Crash during rename leaves central DB unchanged

---

## Phase 3: Agent Guardrails (P2)

These prevent the agent from making structurally-possible-but-wrong choices.

### 3.1 ~~TypeScript-side level_groups normalization~~ DROPPED

**Dropped** per code-simplicity review: Fully redundant with 1.1 (Python auto-sort). The Python is the authoritative layer for level ordering, and all outputs flow through it. Adding the same sort in TypeScript creates a cross-language constant sync burden that will inevitably drift.

---

### 3.2 Gate `set_phase` after `build_database` failure

Already covered in 2.1.

---

### 3.3 `regenerate_output` must echo the actual level order in its result

**Problem**: Missouri — agent claimed correct order but the PDF showed the opposite.

**Fix**: Verify that Python's `--regenerate` output already includes the "SHIRT BACK PAGES" summary with per-page level listing. The `meet_summary.py` code generates this. Check that it's not truncated by the TypeScript result processing.

This is a **verification task**, not a code change. If the summary is already included and not truncated, close this item. If truncated, increase the truncation limit in `toolRegenerateOutput`.

**Files**: Verify in `python/core/meet_summary.py`, `src/main/context-tools.ts` (toolRegenerateOutput)

**Acceptance criteria**:
- [ ] Every `regenerate_output` result includes per-page level listing in full
- [ ] Agent can compare level order against user requirements without rendering a PDF

---

### 3.4 `SUSPICIOUS_NAMES` must be architecturally enforced, not prompt-nudged

**Problem**: Missouri — 4 athletes with garbled names surfaced as warnings 10 times but the agent never fixed them.

**Fix** (strengthened per prompt-enforcement review): Don't just append instructions to the tool result — that's still prompt enforcement. Instead, architecturally gate re-runs:

1. Have Python emit a `SUSPICIOUS_NAMES_JSON:` line with `[{"raw": "Grace Gosselin VT Bars BM", "cleaned": "Grace Gosselin"}]` — TypeScript parses this reliably (no fragile regex)
2. Store the list in `context.suspiciousNames`
3. On the FIRST detection, return the regeneration result normally but append the actionable fix commands (per learning `warn-but-proceed`)
4. On SUBSEQUENT `regenerate_output` calls, if `context.suspiciousNames` is still non-empty, return an error with pre-built SQL UPDATE statements — block regeneration until names are fixed

This makes it structurally impossible to regenerate more than once with garbled names.

**Files**: `python/process_meet.py` (add JSON output), `src/main/context-tools.ts` (parse JSON, gate re-runs)

**Acceptance criteria**:
- [ ] First regeneration with suspicious names succeeds but warns with fix commands
- [ ] Second regeneration with same suspicious names is blocked with error
- [ ] After agent fixes names via `query_db`, the gate clears
- [ ] Names without event suffixes are not flagged

---

## Phase 4: Lower Priority Fixes (P3)

### 4.1 Gym normalization — prefer more-capitalized canonical form

**Problem**: Missouri — "KCGym" → "Kcgym". Kansas — "Aspiregymnasticsclub".

**Fix**: When merging case variants, prefer the form with more uppercase characters (or the longer form if tied).

**Files**: `python/core/gym_normalizer.py`

---

### 4.2 Duplicate meet name detection in `set_output_name`

**Problem**: Oregon — same meet under two names ("March 13 & 21" vs "March 13-21").

**Fix**: Normalize date separators and whitespace in `meet-naming.ts`.

**Files**: `src/main/meet-naming.ts`, `src/main/agent-loop.ts` (set_output_name)

---

### 4.3 Gym rename tool for post-finalization corrections

**Problem**: Kansas — gym rename overwritten by `pull_meet`.

**Fix**: Add `rename_gym` tool that updates local DB + Supabase atomically.

**Files**: `src/main/tools/db-tools.ts` (new tool), `src/main/tool-definitions.ts`, `src/main/supabase-sync.ts`

---

## Implementation Order

```
Phase 1 (Python pipeline) — do first, fixes wrong output:
  1.1  parse_level_groups auto-sort (three-bucket: Xcel/other/numbered)
  1.2  meet_summary canonical ordering
  1.3  Narrow shirt cascade (keep order_forms+summary, drop idml+gym_highlights)
  1.4  Name cleaning regex expansion
  1.5  Tennessee crash diagnosis + per-row error handling
  1.6  Wrap build_database in atomic transaction

Phase 2 (Architecture) — do second, fixes stuck/lost states:
  2.1  build_database failure blocks phase advancement (+ persist flag)
  2.2  Empty handoff safety net (text-only fallback, not raw messages)
  2.3  Add regenerate_output to import_backs (+ fix prompt)
  2.4  Fix getStagingDbPath() split (get-or-create vs get-if-exists)
  2.5  Persist division_order in shirt_layout.json
  2.6  Remove raw Chrome from discovery; add browse_mso/browse_scorecat
  2.7  Transaction-wrap meet rename in publishMeet

Phase 3 (Guardrails) — do third, prevents wrong choices:
  3.3  Verify regenerate_output echoes level order (verification task)
  3.4  Architectural SUSPICIOUS_NAMES gate (JSON output + context gate)

Phase 4 (Lower priority) — do when time allows:
  4.1  Gym normalization canonical form
  4.2  Duplicate meet name prevention
  4.3  Gym rename tool
```

## Files to Change

| File | Changes | Phase |
|------|---------|-------|
| `python/core/layout_engine.py` | Auto-sort levels in `parse_level_groups()` with three-bucket sort | 1.1 |
| `python/core/meet_summary.py` | Canonical Xcel + descending numbered ordering | 1.2 |
| `python/process_meet.py` | Narrow cascade; persist `division_order`; add SUSPICIOUS_NAMES_JSON | 1.3, 2.5, 3.4 |
| `src/main/tools/extraction-tools.ts` | Expand `cleanName()` regex | 1.4 |
| `python/core/db_builder.py` | Defensive NULL handling; per-row try/except; atomic transaction | 1.5, 1.6 |
| `src/main/context-tools.ts` | `buildDatabaseFailed` guard + persistence; SUSPICIOUS_NAMES gate; meets metadata after success check | 2.1, 3.4 |
| `src/main/agent-loop.ts` | Empty handoff text-only fallback | 2.2 |
| `src/main/workflow-phases.ts` | Add `regenerate_output` to import_backs tools + fix prompt | 2.3 |
| `src/main/tools/python-tools.ts` | Split `getStagingDbPath()` into get-or-create / get-if-exists | 2.4 |
| `src/main/workflow-phases.ts` | Remove raw Chrome from discovery tools | 2.6 |
| `src/main/tools/browser-tools.ts` | Add `browse_mso` + `browse_scorecat` executors | 2.6 |
| `src/main/tool-definitions.ts` | Add `browse_mso` + `browse_scorecat` schemas | 2.6 |
| `src/main/agent-loop.ts` | Remove `searchMeetsReturned` Chrome gating logic | 2.6 |
| `src/main/supabase-sync.ts` | Transaction-wrap meet rename | 2.7 |

## Estimated Impact

| Category | Iterations Wasted (per log) | After Fix |
|----------|---------------------------|-----------|
| Level ordering confusion | 6-10 | 0 |
| Name ordering wrong | entire run | 0 |
| regenerate_output regenerating everything | 2-3 per tweak | 0 |
| Staging DB crash after finalize | 9 | 0 |
| Empty phase handoff | entire phase | 0 |
| IDML unavailable in import_backs | manual unlock | 0 |
| build_database crash not caught | entire run | 0 |
| SUSPICIOUS_NAMES ignored | cosmetic but repeated | 0 |
| **Total per run** | **20-40 wasted** | **0-2** |
