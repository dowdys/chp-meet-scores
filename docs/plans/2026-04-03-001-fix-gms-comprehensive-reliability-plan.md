---
title: "fix: GMS Comprehensive Reliability Overhaul"
type: fix
status: completed
date: 2026-04-03
origin: Full-codebase review (6-agent audit, 2026-04-03)
---

# fix: GMS Comprehensive Reliability Overhaul

## Overview

Comprehensive reliability fix addressing 8 P0, 18 P1, and 20+ P2 findings from a full-codebase audit. The findings cluster into five systemic themes: (1) agent orchestration gaps that cause incomplete handoffs and stuck phases, (2) skill document drift where prompts reference tools/workflows that no longer exist, (3) cloud sync bugs including calling a destructive v1 RPC, (4) Python pipeline ordering issues that put athletes in wrong positions on shirts and order forms, and (5) main process reliability gaps including force-installing updates mid-run.

## Problem Frame

The GMS app's inner AI agent has been unreliable in production. Users report agents that don't finish their work before transitioning to the next phase, agents that can't find meets or navigate to the wrong sites, incorrect athlete ordering on shirts, and cloud sync issues. A 6-agent code review identified the root causes: the `set_phase` tool literally cannot transition to `import_backs` (missing from the enum), skill documents reference 3+ tools that don't exist (`run_python`, `import_idml`), `publish_meet` calls a destructive v1 RPC that will cascade-delete orders, and order forms silently ignore division ordering.

## Requirements Trace

- R1. Agent can transition to all phases including `import_backs` without getting stuck
- R2. All skill documents reference only tools that exist and are available in the correct phase
- R3. Phase transitions have precondition guards that prevent skipping required work
- R4. Cloud publish uses safe v2 UPSERT RPC; `supabaseEnabled` is consistently enforced
- R5. Extraction files are not deleted until new extraction succeeds
- R6. Order forms use the same division ordering as shirts (precomputed shirt back data)
- R7. All divisions/levels provided to layout engine appear in output (no silent drops)
- R8. Auto-update does not kill an active agent run
- R9. Suspicious names can be fixed by the agent without a deadlock
- R10. SQL injection vectors in query-engine and exec_query are closed
- R11. Agent context (PDF paths, discovered meet IDs) survives phase transitions and progress saves

## Scope Boundaries

- NOT creating a second Supabase project for staging — using config toggle instead
- NOT automating suspicious name fixes — surfacing to agent for reasoning
- NOT changing level ordering logic — agent decides per-meet, but validation ensures completeness
- NOT rewriting the layout engine — targeted fixes only
- NOT adding tests for Python pipeline (separate effort) — but adding validation guards

## Key Technical Decisions

- **Phase guards: mixed hard/soft** — Hard block for critical transitions (no DB without data files, no output without staging DB, no finalize without winners). Warn-but-allow for softer ones (discovery→extraction without output name set). Rationale: hard blocks prevent the most damaging failures; soft warnings preserve flexibility for edge cases where the agent legitimately needs to skip ahead.
- **Suspicious names: dedicated `fix_names` tool** — Creates a new tool that accepts a list of name corrections and applies them to the staging DB. The agent reasons through each suspicious name and calls the tool with its decisions. Rationale: user has seen that automation fails on edge cases (e.g., "Cobb" vs "BB" suffix), but the agent reasons through them well. A dedicated tool is better than allowing raw UPDATEs via query_db (security risk) or using run_script (fragile).
- **chrome_navigate: unlock_tool only** — Remove from all phase tool lists. Available only via explicit `unlock_tool` call. Rationale: the only use case is rare internet searches for meets not on MSO/ScoreCat; purpose-specific browse tools cover normal usage.
- **Order form ordering: use precomputed shirt back data** — Order forms should display each athlete's actual shirt back, not recompute ordering independently. Rationale: user confirmed this is the intent; independent recomputation is the source of mismatches.
- **Level ordering validation: completeness lock** — After the agent provides division/level ordering, validate that every division/level in the data appears in the ordering. Hard error if anything is missing. Rationale: data was dropped yesterday; this is the #1 user pain point in this area.

## Open Questions

### Resolved During Planning

- **Staging environment**: Use config toggle (`supabaseEnabled`) consistently, not a second Supabase project. The v2 UPSERT handles multi-user publishing safely.
- **chrome_navigate disposition**: Remove from phases, available only via `unlock_tool` per user decision.
- **Non-numeric level placement**: Agent decides per-meet — no code change to ordering logic, but add completeness validation.

### Deferred to Implementation

- **Exact precondition checks per phase**: Implementation will determine the specific file/state checks for each transition. The plan specifies which transitions are hard vs soft.
- **fix_names tool UX**: Exact format of the name correction list the agent passes. Implementation should mirror existing tool patterns.
- **exec_query hardening approach**: Whether to use `SET TRANSACTION READ ONLY` or restrict the RPC to admin role. Implementation should evaluate Supabase's capabilities.

## Implementation Units

### Phase 1: Critical Agent Orchestration (blocks all other agent reliability work)

- [ ] **Unit 1: Tool Schema & Availability Fixes**

  **Goal:** Fix the structural gaps that prevent the agent from entering phases and loading skills.

  **Requirements:** R1, R2

  **Dependencies:** None

  **Files:**
  - Modify: `src/main/tool-definitions.ts` — add `import_backs` to `set_phase` enum
  - Modify: `src/main/workflow-phases.ts` — add `list_skills`, `load_skill` to `ALWAYS_AVAILABLE_TOOLS`; add `web_search` to discovery phase tools; remove `chrome_navigate`, `chrome_execute_js`, `chrome_save_to_file`, `chrome_screenshot`, `chrome_click` from any phase tool lists (leave them as unlock_tool-only)
  - Modify: `src/main/workflow-phases.ts` — fix line 121 reference from `import_idml` to `import_pdf_backs`

  **Approach:**
  - `set_phase` enum: add `'import_backs'` as the 5th entry
  - `ALWAYS_AVAILABLE_TOOLS`: append `'list_skills'` and `'load_skill'`
  - Discovery phase tools: append `'web_search'`
  - Chrome tools: verify they are NOT in any phase's tool list (they should only be accessible via `unlock_tool`)
  - Fix the `import_idml` string reference in the extraction phase prompt

  **Patterns to follow:** Existing `ALWAYS_AVAILABLE_TOOLS` array pattern; existing phase tool list arrays

  **Test scenarios:**
  - Happy path: `set_phase("import_backs")` accepted by tool schema validation
  - Happy path: `load_skill` callable during discovery phase
  - Happy path: `web_search` available in discovery phase tool list
  - Edge case: `chrome_navigate` NOT available in any phase without `unlock_tool`
  - Integration: agent calls `set_phase("import_backs")` → phase transitions successfully → import_backs tools become available

  **Verification:** `filterToolsForPhase` returns `list_skills`/`load_skill` for every phase; `set_phase` accepts all 5 phase values; chrome tools only appear when explicitly unlocked.

- [ ] **Unit 2: Phase Transition Precondition Guards**

  **Goal:** Prevent the agent from skipping phases by validating that required work is complete before transitions.

  **Requirements:** R3

  **Dependencies:** Unit 1

  **Files:**
  - Modify: `src/main/context-tools.ts` — add precondition checks to `toolSetPhase`
  - Modify: `src/main/tools/python-tools.ts` — reference `getStagingDbPath` for output_finalize guard

  **Approach:**
  Hard blocks (refuse transition, return error message):
  - `→ database`: at least one extraction data file must exist in the data directory (glob for `*.json` extraction files)
  - `→ output_finalize`: staging DB must exist (`getStagingDbPath()` returns non-null)
  - `→ output_finalize`: `buildDatabaseFailed` must be false (already exists)
  - `→ import_backs`: staging DB must exist

  Soft warnings (allow transition, prepend warning to return string):
  - `→ extraction`: warn if `context.outputName` is not set
  - `→ database`: warn if `context.discoveredMeetIds` is empty

  The guard function checks conditions BEFORE setting `context.currentPhase`. On hard block, return an error string explaining what's missing. On soft warning, prepend the warning to the success message.

  **Patterns to follow:** Existing `buildDatabaseFailed` check pattern at `context-tools.ts:153`

  **Test scenarios:**
  - Happy path: transition to `database` succeeds when extraction files exist
  - Error path: transition to `database` blocked when no extraction files exist — returns descriptive error
  - Error path: transition to `output_finalize` blocked when no staging DB — returns descriptive error
  - Edge case: transition to `extraction` with no output name — succeeds with warning prepended
  - Edge case: transition to `database` with empty discoveredMeetIds — succeeds with warning
  - Happy path: transition to `import_backs` succeeds when staging DB exists

  **Verification:** Agent cannot enter `database` phase without data files; cannot enter `output_finalize` without staging DB; soft warnings appear but don't block.

- [ ] **Unit 3: Agent Context & State Persistence**

  **Goal:** Ensure critical agent state survives phase transitions and progress saves.

  **Requirements:** R11

  **Dependencies:** Unit 1

  **Files:**
  - Modify: `src/main/context-tools.ts` — add `discoveredMeetIds` to `ProgressData` type and save/restore logic
  - Modify: `src/main/agent-loop.ts` — add dedicated `import_backs` handoff builder in `pruneContextForPhaseTransition`; fix `filePattern` regex to match Windows paths
  - Modify: `src/main/agent-loop.ts` — unify the two auto-switch detection patterns (lines 464-486 and line 249)

  **Approach:**
  - `ProgressData`: add `discovered_meet_ids?: string[]` field. Save in `toolSaveProgress` and `autoSaveProgress`. Restore in the resume path.
  - `pruneContextForPhaseTransition` handoff builder: add a case for `import_backs` that explicitly includes: PDF file paths from the tool results that triggered the switch, the meet name, and instructions to use `import_pdf_backs`.
  - `filePattern` regex: extend to match Windows paths like `C:\Users\...` in addition to Unix paths.
  - Auto-switch unification: extract the PDF detection logic into a single helper function used by both `runAgentLoop` and `continueConversation`. The helper should check for `.pdf` with adjacent path separators (forward or back slash) rather than the current fragile heuristic.

  **Patterns to follow:** Existing handoff builders for `extraction` phase at agent-loop.ts ~line 1001; existing `ProgressData` save/restore pattern

  **Test scenarios:**
  - Happy path: save progress with discoveredMeetIds → resume → IDs are available and validation guard works
  - Happy path: auto-switch to import_backs → handoff message includes PDF paths
  - Edge case: Windows path like `C:\Users\Dowdy\Downloads\back.pdf` detected by auto-switch
  - Edge case: message mentioning `.pdf` in non-path context (e.g., "the order_forms.pdf looks good") does NOT trigger auto-switch
  - Error path: progress resume with no saved discoveredMeetIds → field is empty array, guard allows extraction (backward compat)

  **Verification:** After progress resume, `context.discoveredMeetIds` is populated; after import_backs auto-switch, the agent knows which PDF files to process without re-asking.

- [ ] **Unit 4: Suspicious Names Tool**

  **Goal:** Break the deadlock where `regenerate_output` blocks on suspicious names but `query_db` rejects the UPDATEs needed to fix them.

  **Requirements:** R9

  **Dependencies:** Unit 1

  **Files:**
  - Modify: `src/main/tool-definitions.ts` — add `fix_names` tool definition
  - Modify: `src/main/tools/db-tools.ts` — add `fix_names` executor
  - Modify: `src/main/workflow-phases.ts` — add `fix_names` to `database` and `output_finalize` phase tools
  - Modify: `src/main/context-tools.ts` — update the `regenerate_output` suspicious names error message to reference `fix_names`

  **Approach:**
  The `fix_names` tool accepts an array of `{original: string, corrected: string}` pairs. It:
  1. Opens the staging DB (or central if no staging) in read-write mode
  2. For each pair, runs `UPDATE results SET name = ? WHERE name = ? AND meet_name = ?`
  3. After all updates, re-runs `_build_winners_score_based` (or triggers a winners rebuild) so the winners table stays in sync
  4. Returns a summary: "Fixed N names: Anna NicklowBB → Anna Nicklow, ..."

  The `regenerate_output` error message changes from "Run these SQL updates via query_db" to "Use the fix_names tool with your corrections."

  The agent sees the suspicious names, reasons about each one (is "BB" part of the name or an event code?), and passes only the corrections it's confident about.

  **Patterns to follow:** `rename_gym` tool pattern in db-tools.ts (similar read-write DB access with Supabase sync consideration)

  **Test scenarios:**
  - Happy path: fix_names with `[{original: "Anna NicklowBB", corrected: "Anna Nicklow"}]` → results table updated, winners rebuilt
  - Happy path: regenerate_output after fix_names → no longer blocked by suspicious names
  - Edge case: fix_names called with empty array → no-op, returns "No corrections to apply"
  - Edge case: original name not found in DB → skip with warning in output, don't error
  - Error path: no staging DB and no central DB → returns descriptive error

  **Verification:** The suspicious names → fix_names → regenerate_output flow works end-to-end without deadlock.

### Phase 2: Cloud Sync & Data Safety

- [ ] **Unit 5: Cloud Sync Critical Fixes**

  **Goal:** Fix the destructive v1 RPC call, enforce supabaseEnabled consistently, fix auth listener leak, and add ownership check to delete.

  **Requirements:** R4

  **Dependencies:** None (independent of Phase 1)

  **Files:**
  - Modify: `src/main/supabase-sync.ts` — change `'publish_meet'` to `'publish_meet_v2'` at line 118; update response shape handling
  - Modify: `src/main/supabase-client.ts` — move `onAuthStateChange` registration outside the `if (!authInitialized)` block; handle `TOKEN_REFRESHED` failures; prevent listener duplication
  - Modify: `src/main/main.ts` — add `if (!configStore.get('supabaseEnabled'))` guard to all cloud IPC handlers that currently lack it (`list-cloud-meets`, `get-cloud-meet-files`, `download-cloud-file`, `pull-cloud-meet`, `delete-meet` cloud section); add `.eq('published_by', configStore.get('installationId'))` to delete-meet Supabase calls
  - Modify: `src/main/tools/db-tools.ts` — in `rename_gym`, skip Supabase write when operating on staging DB (premature sync)
  - Modify: `src/main/supabase-sync.ts` — check `meet_files` upsert error and push to `failed[]` if it fails

  **Approach:**
  - v1→v2: one-line change at supabase-sync.ts:118. v2 returns `meet_id` additionally — update the response destructuring.
  - Auth: register `onAuthStateChange` once at module level (when `client` is first created). Set `authInitialized = false` on both `SIGNED_OUT` and `TOKEN_REFRESHED` where session is null.
  - supabaseEnabled: add early-return guard `if (!isSupabaseConfigEnabled()) return { ... }` to each cloud IPC handler. Create a helper `isSupabaseConfigEnabled()` that reads from configStore (distinct from the existing `isSupabaseEnabled()` which is hardcoded true).
  - delete ownership: add `.eq('published_by', installationId)` to prevent deleting another installation's data.
  - rename_gym staging guard: check `getStagingDbPath()` — if operating on staging, skip the Supabase update entirely with a log note.
  - meet_files: capture the upsert `{ error }` and push filename to `failed[]` array if error is non-null.

  **Patterns to follow:** Existing `configStore.get('supabaseEnabled')` check in `list-unified-meets` handler

  **Test scenarios:**
  - Happy path: publishMeet calls `publish_meet_v2` RPC — returns `meet_id`
  - Happy path: supabaseEnabled=false → all cloud handlers return early, no network calls
  - Happy path: delete-meet with matching installationId → succeeds
  - Error path: delete-meet with non-matching installationId → Supabase returns 0 rows deleted, no error but no data loss
  - Edge case: auth token expires → `TOKEN_REFRESHED` with null session → `authInitialized` resets → next call re-authenticates
  - Edge case: rename_gym on staging DB → Supabase write skipped
  - Error path: meet_files upsert fails → filename appears in `failed[]` array

  **Verification:** No calls to `publish_meet` v1 remain in codebase; all cloud IPC handlers respect supabaseEnabled config; auth re-authenticates after token expiry.

- [ ] **Unit 6: Extraction Safety**

  **Goal:** Prevent data loss from premature file cleanup and silent failures.

  **Requirements:** R5

  **Dependencies:** None

  **Files:**
  - Modify: `src/main/tools/extraction-tools.ts` — move old-file cleanup to AFTER successful extraction for both `mso_extract` and `scorecat_extract`
  - Modify: `src/main/tools/python-tools.ts` — surface missing winners table as explicit warning in `finalize_meet` return string (not just console.warn)

  **Approach:**
  - Extraction cleanup: instead of deleting old files first, write the new extraction to a temp filename, verify it has data (non-empty array, >0 athletes), THEN delete old files and rename temp to final. If extraction fails, old files remain intact.
  - finalize_meet: when catching `no such table: winners`, include it in the returned string: `"WARNING: No winners table found — meet may have incomplete processing. Finalized N athletes, 0 winners."` The agent will see this and can decide whether to proceed.

  **Patterns to follow:** Existing temp-file pattern in `_safe_move` in process_meet.py

  **Test scenarios:**
  - Happy path: mso_extract succeeds → old files cleaned up → new file in place
  - Error path: mso_extract API returns 0 athletes → old files preserved, error returned to agent
  - Error path: mso_extract network failure → old files preserved, error returned
  - Happy path: finalize_meet with winners table → normal success message
  - Edge case: finalize_meet without winners table → warning included in return string, agent sees it

  **Verification:** Old extraction files are never deleted unless new extraction produced valid data; missing winners table is visible to the agent.

- [ ] **Unit 7: SQL Injection Hardening**

  **Goal:** Close SQL injection vectors in the query engine and exec_query RPC.

  **Requirements:** R10

  **Dependencies:** None

  **Files:**
  - Modify: `src/main/query-engine.ts` — strengthen `run_sql` validation beyond `^select` regex
  - Modify: `supabase/migrations/` — new migration to wrap `exec_query` in a read-only transaction or restrict to admin role

  **Approach:**
  - query-engine `run_sql`: reject queries containing semicolons (after stripping trailing one), reject queries with SQL comments (`--`, `/*`), and reject multi-statement queries. This closes the `SELECT 1; DROP TABLE` bypass.
  - `exec_query` RPC: add `SET TRANSACTION READ ONLY` at the start of the function body before `EXECUTE`. This uses Postgres's built-in read-only enforcement rather than regex matching. Even if the regex is bypassed, the transaction will reject any mutation.

  **Patterns to follow:** Existing `isSelectOnly` function in db-tools.ts for the client-side pattern

  **Test scenarios:**
  - Error path: `run_sql` with `SELECT 1; DROP TABLE results--` → rejected (semicolon in middle)
  - Error path: `run_sql` with `/* delete */ SELECT 1` → rejected (SQL comment)
  - Happy path: `run_sql` with normal SELECT → succeeds
  - Error path: `exec_query` with mutation attempt → Postgres read-only transaction error
  - Happy path: `exec_query` with SELECT → succeeds within read-only transaction

  **Verification:** No SQL mutation possible through query-engine `run_sql` or Supabase `exec_query`.

### Phase 3: Python Pipeline Ordering

- [ ] **Unit 8: Order Form Division Ordering**

  **Goal:** Make order forms use the precomputed shirt back data instead of recomputing ordering independently.

  **Requirements:** R6

  **Dependencies:** None (independent Python work)

  **Files:**
  - Modify: `python/core/order_form_generator.py` — thread `explicit_order` (or the full precomputed `division_order`) into `_get_gym_athletes` and `generate_order_forms_pdf`

  **Approach:**
  The `generate_order_forms_pdf` function already accepts `precomputed` dict. The `division_order` is available in `precomputed['division_order']`. Thread this through to `_get_gym_athletes` so it uses the same ordering as the shirt back. The `_get_gym_athletes` function currently calls `detect_division_order(db_path, meet_name)` with no explicit order — change it to accept and use the precomputed order.

  Ensure the order form displays each athlete's shirt back content, not independently computed content.

  **Patterns to follow:** How `precompute_shirt_data` receives and uses `division_order` parameter

  **Test scenarios:**
  - Happy path: order form with explicit division_order `["Jr A", "Jr B", "Sr A"]` → athletes sorted by that order within each gym
  - Edge case: order form called without precomputed data → falls back to `detect_division_order` (backward compat, but with explicit_order if available)
  - Integration: same `division_order` used for shirt and order form → athlete ordering matches between the two outputs

  **Verification:** Order form athlete ordering within each gym matches the shirt division ordering.

- [ ] **Unit 9: Layout Engine Ordering & Completeness Validation**

  **Goal:** Fix NULL division handling, add completeness validation that ensures all divisions/levels appear in output, fix bin_pack overflow, and handle name dedup winner dropping.

  **Requirements:** R7

  **Dependencies:** None

  **Files:**
  - Modify: `python/core/layout_engine.py` — NULL division handling in sort key; completeness validation after ordering; bin_pack balance pass overflow fix; name dedup warning for dropped winners
  - Modify: `python/core/division_detector.py` — handle NULL divisions explicitly in detection

  **Approach:**
  - NULL divisions: when `division` is NULL, assign a sort key that groups them together with a descriptive label (e.g., "Unknown Division") rather than silently placing at end. Log a warning when NULL divisions are found.
  - Completeness validation: after the agent provides `division_order`, validate that every distinct division in the query results appears in the order list. If any are missing, return a hard error: `"ERROR: Division order is missing: [X, Y]. All divisions must be included."` This is the "lock" the user requested.
  - bin_pack overflow: in the balanced redistribution pass, add a safety check that the number of groups produced equals `num_pages`. If fewer groups are produced, fall back to the greedy packing result.
  - Name dedup: when two different raw names clean to the same string, keep both (differentiate by session or gym), and log a warning. Don't silently drop a winner.

  **Patterns to follow:** Existing `detect_division_order` warning output pattern; existing `UNKNOWN_DIVISIONS` handling in workflow-phases.ts

  **Test scenarios:**
  - Edge case: NULL division in results → grouped together, warning logged, not silently placed at end
  - Error path: division_order missing "Sr B" that exists in data → hard error returned with list of missing divisions
  - Happy path: complete division_order → no error, ordering proceeds
  - Edge case: bin_pack balanced pass produces fewer groups than num_pages → falls back to greedy result
  - Edge case: two "Emily Smith" athletes in different sessions → both kept on shirt, warning logged
  - Happy path: all divisions in order, no duplicates → clean output

  **Verification:** No division/level from the data can be silently omitted from output; bin_pack never produces fewer pages than requested; duplicate-name athletes are preserved with warning.

- [ ] **Unit 10: Data Adapter Fixes**

  **Goal:** Fix HtmlAdapter missing club_num, GenericAdapter "Last, First" format, and _safe_move dead code.

  **Requirements:** R6 (data consistency)

  **Dependencies:** None

  **Files:**
  - Modify: `python/adapters/html_adapter.py` — add `'club_num': ''` to the returned dict
  - Modify: `python/adapters/generic_adapter.py` — change name construction from `"Last, First"` to `"First Last"`
  - Modify: `python/process_meet.py` — fix unreachable `_safe_move` fallback code (un-indent from except block)

  **Approach:**
  - HtmlAdapter: add `'club_num': ''` to document the gap and enable gym normalizer Phase 1.5 to at least not error. Consider extracting club_num from MSO HTML if the field exists in the DOM.
  - GenericAdapter: change line 140 from `f"{last}, {first}"` to `f"{first} {last}"` to match ScoreCat adapter's format. This ensures consistent name formats across adapters.
  - _safe_move: the code after `pass` in the `except PermissionError` block is unreachable. Un-indent it so it runs as the fallback path.

  **Patterns to follow:** ScoreCat adapter name format; existing adapter dict structures

  **Test scenarios:**
  - Happy path: HtmlAdapter parse returns dict with `club_num` key
  - Happy path: GenericAdapter with firstName="Emily" lastName="Smith" → name="Emily Smith"
  - Edge case: _safe_move with PermissionError → falls through to _NEW naming pattern

  **Verification:** All adapters return consistent name format and include `club_num` field; `_safe_move` fallback is reachable.

### Phase 4: Main Process Reliability

- [ ] **Unit 11: Auto-Update, IPC, and Process Fixes**

  **Goal:** Fix auto-update killing active runs, IPC handler bugs, and process state issues.

  **Requirements:** R8

  **Dependencies:** None (independent of other phases)

  **Files:**
  - Modify: `src/main/main.ts` — gate `quitAndInstall` on `!agentRunning`; change `ipcMain.on('user-choice-response')` to `ipcMain.once`; set `agentRunning = true/false` in `continue-conversation` handler; call `clearQueryHistory()` in `save-settings` handler; use `getOutputBase()` in `get-output-files` handler
  - Modify: `src/main/tools/browser-tools.ts` — add redirect detection to `browse_mso` for invalid meet IDs
  - Modify: `src/main/tools/extraction-tools.ts` — add alphanumeric ID format validation to `scorecat_extract`
  - Modify: `src/main/supabase-sync.ts` — add `isAgentRunning()` check to `pullMeetData` to block pulls during active sessions

  **Approach:**
  - Auto-update: in the `update-downloaded` handler, check `if (agentRunning)`. If true, set a `deferredUpdate = true` flag. In the agent-complete path, check `deferredUpdate` and call `quitAndInstall` then.
  - user-choice-response: change `ipcMain.on` to `ipcMain.once` — the cleanup handler already removes it, but `once` is belt-and-suspenders.
  - continue-conversation: wrap in `agentRunning = true` at start, `agentRunning = false` in finally block.
  - save-settings: add `clearQueryHistory()` call after settings are saved.
  - get-output-files: replace `configStore.get('outputDir')` with `getOutputBase()`.
  - browse_mso: after the 2s wait, check if the final URL still contains the expected meet ID. If MSO redirected to `Results.All`, return an error: "Meet ID not found — MSO redirected to the results list."
  - scorecat_extract: validate each meet_id matches `/^[A-Za-z0-9]+$/` (mirror `browse_scorecat`'s validation).
  - pullMeetData: add guard `if (agentRunning) throw new Error('Cannot pull while agent is running')`.

  **Patterns to follow:** Existing `agentRunning` check pattern in `process-meet` handler; existing `browse_scorecat` ID validation

  **Test scenarios:**
  - Happy path: update downloads while agent idle → installs normally after 2s
  - Edge case: update downloads while agent running → deferred, installs after agent completes
  - Edge case: user double-clicks choice button → `once` prevents stale response from resolving wrong Promise
  - Happy path: continue-conversation sets agentRunning=true → agent completes → agentRunning=false
  - Error path: continue-conversation throws → finally block sets agentRunning=false
  - Happy path: save-settings → query history cleared
  - Edge case: get-output-files with empty outputDir config → uses default path from getOutputBase()
  - Error path: browse_mso with invalid meet ID → redirect detected → error returned
  - Error path: scorecat_extract with numeric MSO ID → format validation rejects it
  - Error path: pullMeetData while agent running → blocked with error

  **Verification:** Auto-update never interrupts an active agent; IPC handlers are robust to edge cases; stale state doesn't leak between operations.

### Phase 5: Skill Document Refresh

- [ ] **Unit 12: Critical Skill Fixes**

  **Goal:** Fix all references to non-existent tools and deprecated workflows across skill documents.

  **Requirements:** R2

  **Dependencies:** Units 1 and 4 (tool changes must land first so skills reference correct state)

  **Files:**
  - Modify: `skills/meet_discovery.md` — replace `run_python` with `build_database`; update source table to reference `mso_extract` tool instead of `mso_html_extraction` skill for MSO JSON API; demote "Browser Discovery" section to fallback with note about `unlock_tool`; remove `run_script` date check (system provides current date); template example queries with `<STATE>` / `<YEAR>` placeholders
  - Modify: `skills/scorecat_extraction.md` — replace `run_python` with `build_database`; add `window.__allAthletes` verification between chunk retrievals; template Algolia example with placeholders
  - Modify: `skills/mymeetscores_extraction.md` — replace `run_python` with `build_database`
  - Modify: `skills/output_generation.md` — delete "IDML Import" section (lines 182-208); remove all `icml` references; add explicit reminder that `division_order` must be passed on first `regenerate_output` call
  - Modify: `skills/database_building.md` — clarify "exactly once" to "don't run with different source files; re-running with corrected division_order or gym-map is expected"
  - Modify: `skills/data_quality.md` — complete Check 8 query with all 5 events (vault, bars, beam, floor, aa); fix Check 3 to reference `fix_names` tool instead of direct SQL UPDATE
  - Modify: `skills/gym_dedup.md` — replace raw SQL merge instructions with `rename_gym` tool usage
  - Modify: `skills/scoreking_extraction.md` — add "Next Steps" section pointing to `build_database` with `source: "generic"`
  - Modify: `skills/unknown_source_extraction.md` — document which Chrome tools to unlock: `chrome_navigate`, `chrome_execute_js`, `chrome_save_to_file`, `chrome_screenshot`, `chrome_click`
  - Modify: `skills/system-prompt.md` — add "DO NOT LOAD — this file is outdated" warning at the very top
  - Modify: `skills/general_scraping.md` — add standard `ask_user` template for "all approaches failed" case
  - Modify: `skills/details/scorecat_schema.md` — ensure Algolia credentials are here as the single source of truth
  - Modify: `skills/details/mso_schema.md` — standardize score parsing to use `parseFloat` consistently

  **Approach:**
  Batch all skill document changes in one unit since they are all text edits with no code dependencies between them. Work through each file systematically. For `run_python` → `build_database`, search-and-replace across all skill files to ensure none are missed.

  **Test expectation: none** — these are documentation files, not code. Verification is by manual review.

  **Verification:** grep for `run_python`, `import_idml`, `icml` across skills/ returns zero hits; each skill references only tools that exist in `tool-definitions.ts` and are available in the phase the skill is used in.

## System-Wide Impact

- **Interaction graph:** Phase transition guards (Unit 2) affect every tool that calls `toolSetPhase`. The `fix_names` tool (Unit 4) introduces a new write path to the staging DB. Cloud sync changes (Unit 5) affect every IPC handler that touches Supabase.
- **Error propagation:** Hard phase blocks return error strings to the agent, which should retry or ask the user. Cloud handler guards return early with `{success: false}` responses.
- **State lifecycle risks:** The `discoveredMeetIds` persistence (Unit 3) adds new data to `ProgressData` — old progress files won't have this field, so the restore must handle undefined gracefully (default to empty array).
- **API surface parity:** The new `fix_names` tool must be added to tool definitions, executors, AND phase tool lists. Missing any one creates a gap.
- **Unchanged invariants:** The core agent loop structure, LLM client, and renderer UI are NOT changed. The Python pipeline's core algorithm is not changed — only adding validation and fixing data flow.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Phase guards too strict — block legitimate edge-case workflows | Mix of hard/soft guards; `unlock_tool` as escape hatch; monitor agent logs after deploy |
| Old progress files lack `discoveredMeetIds` field | Default to empty array on restore; existing guard already handles empty array (skips validation) |
| `publish_meet_v2` RPC has different return shape | Update response destructuring in supabase-sync.ts; test with actual Supabase call |
| Skill document changes create inconsistencies with workflow-phases prompts | Cross-reference all skill updates against phase prompts; grep for removed tool names |
| Division completeness validation too aggressive | Only fires when `division_order` is explicitly provided; if auto-detected, log warning instead of error |

## Sources & References

- **Origin:** Full-codebase 6-agent review conducted 2026-04-03 (agent orchestration, tools, Python pipeline, cloud sync, skills, UI/main process)
- Related plans: `docs/plans/2026-03-26-001-fix-discovery-extraction-reliability-plan.md` (prior extraction reliability work), `docs/plans/2026-03-31-001-fix-agent-reliability-and-ordering-bugs-plan.md` (prior ordering fixes)
- Key files: `src/main/agent-loop.ts`, `src/main/tool-definitions.ts`, `src/main/workflow-phases.ts`, `src/main/context-tools.ts`, `src/main/supabase-sync.ts`, `python/core/layout_engine.py`, `python/core/order_form_generator.py`
