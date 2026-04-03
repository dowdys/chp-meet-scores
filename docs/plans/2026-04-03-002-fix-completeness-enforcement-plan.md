---
title: "fix: Enforce Data Completeness Across Pipeline"
type: fix
status: active
date: 2026-04-03
---

# fix: Enforce Data Completeness Across Pipeline

## Overview

After the comprehensive reliability overhaul (plan 001), a full architectural audit found 15+ instances where the system silently accepts incomplete data, producing wrong output with no warning. All share one theme: the system should enforce completeness while letting the agent make decisions. This plan addresses all user-reported issues plus the audit findings, organized into 9 implementation units.

## Problem Frame

### User-Reported Issues
1. **Michigan multi-meet**: ScoreCat meet "Level 3/4 Xcel Platinum State Meet" has no state/year in title. `state=` param is optional; "search ONCE" restriction blocks retry. Tested live: facetFilters don't work on ScoreCat's Algolia index, but the meet IS findable with specific queries like "Xcel Platinum" — the agent just isn't allowed to retry.
2. **South Carolina missing divisions**: B1-5 for Level 3 existed with valid scores but excluded from shirts. Root cause: `division_order` not persisted in context.
3. **Random athlete ordering**: Same as #2 — `division_order` lost between tool calls.
4. **Email buttons**: IPC wiring correct; issue at Vercel/Postmark endpoint level.
5. **Custom backs reverting**: `idmlImported` flag fragile; PDF paths with spaces lost; session state not restored from disk.

### Audit Findings (new)
6. **finalize_meet succeeds with 0 rows** — copies nothing, deletes staging DB, data lost.
7. **Solo winners never verified** — athletes who won by default on shirts without user confirmation.
8. **Division gap warnings only printed** — missing championship divisions go unnoticed.
9. **Winner insert errors silently dropped** — missing athletes on shirts.
10. **Missing backs on order forms only logged** — athletes get starless order forms.
11. **Name collision picks first gym** — wrong gym on highlights PDF.
12. **gym_map not persisted** — gym corrections lost on regeneration.

## Requirements Trace

- R1. `search_meets` must allow iterative search when levels are missing; `state=` must be required
- R2. `division_order` must persist in context and auto-inject on every `regenerate_output` call
- R3. Warnings from `detect_division_order` must be surfaced to the agent
- R4. All levels in `results` must appear in `winners` or produce an explicit warning
- R5. Email relay must return clear errors on failure
- R6. `idmlImported` must only be set on Python success; import state restored from disk on new sessions
- R7. PDF paths with spaces must survive context pruning
- R8. `finalize_meet` must hard-error on 0 rows copied
- R9. Solo winners must be gated with a structured marker for agent verification
- R10. Division gap warnings must be structured and surfaced
- R11. Winner insert failures must produce visible warnings
- R12. `gym_map` must persist across regenerations via `shirt_layout.json`
- R13. Missing-backs count on order forms must be surfaced to agent

## Scope Boundaries

- NOT changing Algolia's index configuration (we don't control it)
- NOT adding state_abbrev parameter (P3 — regional logos are rare)
- NOT persisting exclude_levels (intentionally ephemeral per existing design)
- NOT restructuring search_meets into multiple tools (prompt + retry fix is sufficient)

## Key Technical Decisions

- **division_order persistence via context (like dates)**: Follow the exact `postmarkDate`/`onlineDate`/`shipDate` pattern. Agent sets it once; system remembers it. Rationale: proven pattern, identical use case.

- **Structured Python markers for gating**: Follow the `SUSPICIOUS_NAMES_JSON` pattern for solo winners and division gaps. Python emits a JSON marker on stdout; TypeScript parses it and gates subsequent operations. Rationale: proven pattern, enables the agent to reason about the issue rather than automating a decision.

- **Search retry instead of search overhaul**: Remove "search ONCE" restriction. After extraction, if levels are incomplete, the agent should search again with level-specific queries. Rationale: Algolia facets don't work; the agent is smarter at query construction than any hardcoded query list.

- **gym_map in shirt_layout.json**: Persist the gym_map file path in sticky params so it's automatically re-applied on regeneration. Rationale: follows existing sticky param pattern for level_groups, page_size_legal, etc.

- **finalize_meet zero-row hard error**: Return an error string starting with "Error:" when 0 results are copied. Rationale: 0 rows is never intentional; the staging DB deletion after 0-row copy is irrecoverable data loss.

## Implementation Units

### Phase 1: Data Completeness Guards (Python)

- [ ] **Unit 1: Structured markers for solo winners and division gaps**

  **Goal:** Emit structured JSON markers from Python that TypeScript can parse and use to gate operations, following the existing SUSPICIOUS_NAMES_JSON pattern.

  **Requirements:** R9, R10

  **Dependencies:** None

  **Files:**
  - Modify: `python/core/db_builder.py` — emit `SOLO_WINNERS_JSON: [...]` after solo session detection; emit `DIVISION_GAP_JSON: [...]` after gap detection
  - Modify: `python/process_meet.py` — ensure gap warnings are printed in a parseable format
  - Modify: `src/main/context-tools.ts` — parse `SOLO_WINNERS_JSON` and `DIVISION_GAP_JSON` from build_database output; store on context; gate `regenerate_output` if unresolved (like suspicious names)

  **Approach:**
  - In `_find_solo_sessions` (db_builder.py ~line 282), after determining solo winners, emit `SOLO_WINNERS_JSON: [{"name":"...", "level":"...", "division":"...", "session":"..."}]` to stdout
  - In `detect_division_gaps` (called from process_meet.py ~line 886), emit `DIVISION_GAP_JSON: [{"tier":"Jr", "present":["D","E"], "missing":["A","B","C"]}]` to stdout
  - In `toolBuildDatabase` (context-tools.ts), parse both markers. Store as `context.soloWinners` and `context.divisionGaps`. If either is non-empty, include a structured warning in the return string directing the agent to verify with the user via `ask_user`
  - Don't hard-gate regeneration on these (unlike suspicious names) — just surface loudly

  **Patterns to follow:** `SUSPICIOUS_NAMES_JSON` parsing in `toolRegenerateOutput` (context-tools.ts ~line 434)

  **Test scenarios:**
  - Happy path: build with no solo winners → no SOLO_WINNERS_JSON emitted → no warning
  - Happy path: build with solo winner → SOLO_WINNERS_JSON emitted → warning in return string → agent asks user
  - Happy path: division gaps detected → DIVISION_GAP_JSON emitted → warning about missing divisions
  - Edge case: solo winner IS the only athlete in the division at the entire meet → still flagged for verification

  **Verification:** Agent always sees solo winner and division gap warnings; cannot miss them in wall of build output.

- [ ] **Unit 2: Level cross-check and winner insert error surfacing**

  **Goal:** After building winners, compare results levels vs winners levels; surface winner insert failures as visible warnings.

  **Requirements:** R4, R11

  **Dependencies:** None

  **Files:**
  - Modify: `python/core/db_builder.py` — add level cross-check after `_build_winners_score_based`; change winner insert error handling from print-only to structured output

  **Approach:**
  - After `_build_winners_score_based`, query `SELECT DISTINCT level FROM results` and `SELECT DISTINCT level FROM winners`. Diff them. Print `LEVEL_MISSING_WINNERS: Level 'X' has N athletes in results but ZERO winners.` for each missing level.
  - For winner insert errors: instead of just counting and printing the first 5, emit `WINNER_INSERT_ERRORS: N` as a summary line. The existing print of individual errors is fine for debugging, but the summary count must be prominent.

  **Patterns to follow:** Existing diagnostic prints in db_builder.py

  **Test scenarios:**
  - Happy path: all levels have winners → no LEVEL_MISSING_WINNERS output
  - Edge case: Level 3 has athletes with valid scores but all in solo sessions that were excluded → LEVEL_MISSING_WINNERS printed
  - Error path: winner insert fails for 3 athletes → WINNER_INSERT_ERRORS: 3 printed prominently

  **Verification:** The SC scenario (Level 3 divisions present but absent from shirt) would produce a visible warning at build time.

- [ ] **Unit 3: Order form missing-backs surfacing and gym name collision warnings**

  **Goal:** Surface the count of athletes with missing backs on order forms, and warn about gym name collisions in highlights.

  **Requirements:** R13

  **Dependencies:** None

  **Files:**
  - Modify: `python/core/order_form_generator.py` — print `ORDER_FORM_MISSING_BACKS: N athletes could not be found on any shirt page` to stdout
  - Modify: `python/core/layout_engine.py` — in `get_winners_with_gym`, print `GYM_NAME_COLLISION: "X" appears at gyms "Y" and "Z" — using "Y"` to stdout (already logged, just promote to print)

  **Approach:**
  - In `generate_order_forms_pdf`, after the athlete matching loop, if any athletes had no matching back page, print the count prominently to stdout. This gets captured by TypeScript's `runPython` and returned to the agent.
  - In `get_winners_with_gym`, change `logger.warning` for name collisions to `print()` so the info appears in the tool result.

  **Test scenarios:**
  - Happy path: all athletes found on backs → no missing-backs message
  - Edge case: 3 athletes have hyphenated names not found → "ORDER_FORM_MISSING_BACKS: 3 athletes" printed
  - Edge case: athlete at two gyms → collision warning printed

  **Verification:** Agent sees missing-backs count and can investigate before finalizing.

### Phase 2: State Persistence (TypeScript)

- [ ] **Unit 4: Persist division_order in context with auto-injection**

  **Goal:** Make division_order a persistent context field that auto-injects on every regenerate_output call.

  **Requirements:** R2, R3

  **Dependencies:** None

  **Files:**
  - Modify: `src/main/context-tools.ts` — add `divisionOrder?: string[]` to AgentContext; store when passed to build_database or regenerate_output; auto-inject when omitted; add to ProgressData save/restore; surface detect_division_order warnings
  - Modify: `src/main/agent-loop.ts` — restore divisionOrder from saved progress
  - Modify: `python/core/division_detector.py` — ensure NO_DIVISION_ORDER warning is printed to stdout (not just returned in list)

  **Approach:**
  - Follow the exact `postmarkDate`/`onlineDate`/`shipDate` pattern in context-tools.ts
  - In `toolBuildDatabase`: when `division_order` is in args, parse and store on `context.divisionOrder`
  - In `toolRegenerateOutput`: if agent didn't pass `division_order` but `context.divisionOrder` exists, add `--division-order` to Python args
  - In `detect_division_order`: print `NO_DIVISION_ORDER` warning to stdout so TypeScript captures it
  - Add `division_order?: string[]` to ProgressData and restore on resume

  **Patterns to follow:** `context.postmarkDate` auto-injection at context-tools.ts ~line 287

  **Test scenarios:**
  - Happy path: set division_order in build_database → regenerate_output without it → auto-injected from context
  - Happy path: persisted in progress → session resume → regenerate_output uses it
  - Edge case: agent passes different division_order to regenerate_output → explicit value wins over context
  - Error path: no division_order anywhere → NO_DIVISION_ORDER warning in tool return string

  **Verification:** Agent never sees silent alphabetical fallback. Division ordering consistent across all tool calls.

- [ ] **Unit 5: Persist gym_map in shirt_layout.json**

  **Goal:** Prevent gym name corrections from reverting when regenerate_output is called without re-passing the gym_map path.

  **Requirements:** R12

  **Dependencies:** None

  **Files:**
  - Modify: `python/process_meet.py` — add `gym_map` to the sticky params save/load logic in `shirt_layout.json`

  **Approach:**
  - In the sticky params section (~line 920), add `gym_map` to the save list alongside `level_groups`, `page_size_legal`, etc.
  - On load, if `gym_map` is in saved layout and the file still exists on disk, auto-apply it
  - If the saved gym_map path no longer exists, silently ignore (don't error — the file may have been cleaned up)

  **Patterns to follow:** Existing `level_groups` sticky param persistence in process_meet.py

  **Test scenarios:**
  - Happy path: build_database with --gym-map → saved in shirt_layout.json → regenerate_output without --gym-map → auto-loaded
  - Edge case: gym_map file deleted between runs → silently ignored, no error
  - Edge case: agent passes new --gym-map → overrides saved value

  **Verification:** Gym names stay corrected across regeneration cycles.

### Phase 3: Safety Guards (TypeScript)

- [ ] **Unit 6: finalize_meet zero-row guard**

  **Goal:** Prevent data loss when finalize_meet copies 0 rows due to meet_name mismatch.

  **Requirements:** R8

  **Dependencies:** None

  **Files:**
  - Modify: `src/main/tools/python-tools.ts` — check row counts after copy; hard-error if 0

  **Approach:**
  - After the transaction that copies results/winners from staging to central, check `counts.results`. If 0, ROLLBACK the transaction, do NOT delete staging DB, do NOT clear progress, and return `"Error: finalize_meet copied 0 athletes — meet_name may not match. Staging DB preserved."`.

  **Patterns to follow:** Existing `buildDatabaseFailed` error handling pattern

  **Test scenarios:**
  - Happy path: finalize with matching meet_name → copies N athletes → success
  - Error path: finalize with wrong meet_name → 0 rows → error returned, staging preserved
  - Edge case: results copy succeeds but winners table missing → existing missingWinnersTable warning (already handled)

  **Verification:** Staging DB is never deleted when 0 rows were copied.

- [ ] **Unit 7: Harden custom back import state**

  **Goal:** Fix idmlImported conditional, space-in-path regex, and session restore from disk.

  **Requirements:** R6, R7

  **Dependencies:** None

  **Files:**
  - Modify: `src/main/context-tools.ts` — only set idmlImported on Python success
  - Modify: `src/main/agent-loop.ts` — fix filePattern regex for spaces; check shirt_layout.json on session start
  - Modify: `src/main/agent-loop.ts` — in processMeet/continueConversation, read shirt_layout.json for _source=imported

  **Approach:**
  - `toolImportPdfBacks`: check `!result.includes('Python script failed')` before setting `context.idmlImported = true`
  - `filePattern` regex: change Unix path branch from `\/[\w./_-]+` to `\/[\w./_\- ]+` to allow spaces
  - Session start: in `processMeet`, after loading saved progress, also check if `shirt_layout.json` exists in data dir with `_source === 'imported'`. If so, set `context.idmlImported = true`.

  **Patterns to follow:** Existing `buildDatabaseFailed` check pattern; `shirt_layout.json` reading in process_meet.py

  **Test scenarios:**
  - Happy path: import succeeds → idmlImported set → shirt regeneration blocked
  - Error path: import Python fails → idmlImported NOT set → can retry
  - Edge case: path with spaces "/mnt/c/My Documents/back.pdf" → survives context prune
  - Integration: new session → shirt_layout.json has _source=imported → idmlImported=true → protected

  **Verification:** Custom imports persist across sessions and Python failures don't permanently block the workflow.

### Phase 4: Search & Email

- [ ] **Unit 8: Enable iterative meet search**

  **Goal:** Allow the agent to search multiple times when levels are incomplete, and make state= required.

  **Requirements:** R1

  **Dependencies:** None

  **Files:**
  - Modify: `src/main/tool-definitions.ts` — make `state` required in search_meets schema
  - Modify: `src/main/workflow-phases.ts` — remove "search ONCE" restriction; add guidance for level-gap-driven retry
  - Modify: `src/main/agent-loop.ts` — increase search_meets call limit from 5 to allow retry

  **Approach:**
  - Make `state` required: `required: ['query', 'state']` in tool definition. The agent always knows the target state.
  - Update discovery prompt: "After finding meets and extracting data, verify level coverage. If levels are missing, search again with level-specific queries (e.g., 'Xcel Platinum', 'Level 3/4') to find additional sub-meets."
  - The search_meets call limit (currently 5 in agent-loop.ts) may need to increase to 7 to accommodate retry searches.

  **Patterns to follow:** Existing discovery phase prompt structure

  **Test scenarios:**
  - Happy path: agent passes state="Michigan" → search generates state-based queries → finds most meets
  - Happy path: after extraction, agent notices Level 3/4 missing → searches "Xcel Platinum" → finds the meet
  - Error path: search_meets without state → tool returns error
  - Edge case: 7th search call → still allowed (increased limit)

  **Verification:** Michigan multi-meet scenario: agent finds all 3 WAG meets (including Level 3/4 Xcel Platinum) through iterative search.

- [ ] **Unit 9: Investigate and fix email relay**

  **Goal:** Determine why email buttons don't work and fix.

  **Requirements:** R5

  **Dependencies:** None

  **Files:**
  - Modify: `src/main/email-relay.ts` — potentially update API URL or key
  - Modify: `website/` — potentially fix Vercel API route

  **Approach:**
  - Test live endpoint with curl during implementation
  - Diagnose: 200/401/404/500 → fix accordingly
  - If Postmark config issue, may need user's help with dashboard access

  **Test scenarios:**
  - Happy path: curl returns 200 → email sent
  - Error paths: 401 (key), 404 (route), 500 (Postmark config)

  **Verification:** Both buttons complete with success or clear error message.

## System-Wide Impact

- **Interaction graph:** Unit 4 (division_order) affects build_database, regenerate_output, save_progress, and progress restoration. Unit 1 (structured markers) adds new context fields parsed from Python output. Unit 6 changes finalize_meet's error behavior.
- **Error propagation:** New Python markers (SOLO_WINNERS_JSON, DIVISION_GAP_JSON, LEVEL_MISSING_WINNERS) propagate via stdout → runPython return → tool result → agent message. Same proven path as SUSPICIOUS_NAMES_JSON.
- **State lifecycle:** division_order and divisionGaps added to ProgressData. idmlImported now restorable from disk via shirt_layout.json.
- **Unchanged invariants:** Core sort algorithm, Python pipeline logic, extraction tools, Supabase sync all unchanged.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Structured markers change Python stdout format | Follow exact SUSPICIOUS_NAMES_JSON pattern; test parsing end-to-end |
| division_order auto-injection could override agent intent | Explicit agent value always wins; inject only when omitted |
| finalize_meet zero-row guard could block legitimate edge cases | 0-row copy is never intentional; log the meet_name for debugging |
| Email fix may require Postmark dashboard access | User has credentials; escalate if needed |
| Algolia query construction changes could break existing search | State param was already used when provided; making it required doesn't change query logic |

## Sources & References

- Prior plan: `docs/plans/2026-04-03-001-fix-gms-comprehensive-reliability-plan.md`
- Full architectural audit: opus-level review of all pipeline files (2026-04-03)
- Live Algolia API testing: verified facetFilters don't work; specific queries like "Xcel Platinum" do find the meet
- ScoreCat screenshot: Michigan meet "Level 3/4 Xcel Platinum State Meet" (no state/year in title)
- Key files: `src/main/context-tools.ts`, `python/core/db_builder.py`, `python/process_meet.py`, `src/main/tools/python-tools.ts`, `src/main/tools/search-tools.ts`, `src/main/agent-loop.ts`
