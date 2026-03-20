# Plan 006: Process Log Analysis & Fixes (Nevada State Championships)

## Source
Analysis of 3890-line process log from 2026 Nevada State Championships run (64 iterations, ~33 wasted).

## Deepened Research Findings (from parallel subagent investigation)

## Issues Found (ordered by impact)

### Issue 1: MSO extraction produces duplicate records [CRITICAL]
**Log**: Iterations 15-18. 971 athletes extracted → 1971 records in DB (exactly doubled). Agent spent 4 iterations investigating, deduplicating via manual SQL, and rebuilding winners.

**Root cause**: Either `mso_extract` returns duplicate rows, or `generic_adapter.py` parses them twice, or `INSERT OR REPLACE` in db_builder doesn't catch them because of field differences.

**Evidence**: "Abby Trout" appears with identical IDs 652 and 1655 — same session, level, division, scores. The second set starts at ID ~1000, suggesting the entire athlete array was appended twice.

**Fix**: Investigate `mso_extract` (extraction-tools.ts) and `generic_adapter.py`. Add deduplication at the adapter level. Add a post-parse duplicate check that warns before DB insertion.

**Deepened**: Most likely root cause is `generic_adapter.py` lines 65-76. When `data_path` is a **directory** (not a specific file), the adapter globs ALL `*.json` files and extends them together. If multiple `mso_extract_*.json` files exist from previous runs not cleaned up, the athletes get doubled. The agent may have passed a directory path or the data dir contained a stale extract file. Fix: (1) always pass specific file paths, (2) add dedup in adapter based on `(name, gym, session, level, division)`, (3) clean up old extract files before new extraction.

---

### Issue 2: Legal-size shirt PDF generation always fails [CRITICAL]
**Log**: Iterations 37-45. ERROR: "cannot save with zero pages" and "list index out of range" on every attempt with `page_size_legal`. Agent tried 5+ different parameter combinations over 9 iterations.

**Root cause**: Bug in Python `pdf_generator.py` or `layout_engine.py`. The layout engine generates the letter-size pages correctly (2 pages), but when extracting the legal-size subset, it produces zero pages. Likely the `page_size_legal` parameter matching fails — the parameter specifies level codes like "XSA,XD,XP,XG,XS,XB" but the internal page groups may use different labels (e.g., "XCEL" as a group name).

**Note**: `gym_highlights_8.5x14.pdf` generates fine, so the legal-size page creation code works. The issue is specific to shirt PDF legal-size extraction.

**Fix**: Debug the Python layout engine's legal-size page extraction. The matching between `page_size_legal` level codes and internal page group names is likely broken.

**Deepened**: Root cause confirmed in `pdf_generator.py` lines 215-217. The matching logic does **substring matching** against page group **labels** (e.g., "XCEL"), not individual level codes. When user passes `--page-size-legal "XSA,XD,XP,XG,XS,XB"`, it checks if "XSA" is a substring of "XCEL" — which fails. But "XS" IS a substring of "XCEL", causing inconsistent matching. The fix: change the matching to filter by **actual levels in the page group**, not the label string. The gym_highlights code already does this correctly (lines 722-727 in process_meet.py extract levels from page groups). Apply the same approach to shirt PDF legal extraction.

---

### Issue 3: Gym highlights don't filter content by legal/letter page groups [CRITICAL]
**Log**: Iterations 52-62. Both gym_highlights.pdf and gym_highlights_8.5x14.pdf contain ALL levels. The user wanted letter=Levels 2-10, legal=Xcel. Agent spent 11 iterations generating twice with different `exclude_levels`, manually combining files.

**Root cause**: The gym highlights generator treats `page_size_legal` as a page-size modifier, not a content filter. It doesn't know that legal-size should only contain the Xcel page group and letter-size should only contain Levels 2-10.

**Fix**: When `page_size_legal` specifies certain levels, the gym highlights generator should:
- `gym_highlights.pdf` (letter) → only include levels NOT in the legal group
- `gym_highlights_8.5x14.pdf` (legal) → only include levels IN the legal group

**Deepened**: The filtering infrastructure already exists in `pdf_generator.py` lines 453-467 (`include_levels` parameter). The issue is that `process_meet.py` lines 722-727 use the same broken substring matching against page group labels. The fix is the same as Issue 2: match against actual levels in page groups, not label strings. Once the level-extraction logic works correctly, both gym_highlights files will be filtered properly since `generate_gym_highlights_pdf()` already supports `include_levels`.

---

### Issue 4: Regeneration wipes manual DB edits [HIGH]
**Log**: Iterations 28-32. Agent manually fixed 349 duplicates, 14 names, 2 gym names in the staging DB. Then called `regenerate_output` which re-ran the Python pipeline, re-parsed from the original JSON, and rebuilt the DB — wiping all manual fixes. Agent got confused when record count changed from 1622 back to 971.

**Root cause**: `regenerate_output` still invokes `process_meet.py --regenerate` which, despite its name, re-processes from the source data in some configurations. The staging DB is rebuilt from the JSON file, discarding edits.

**Fix**: `--regenerate` should ONLY regenerate output files from the existing DB. It should never re-parse source data or rebuild the results/winners tables. If the DB has been manually edited, those edits must be preserved.

**Deepened**: Confirmed that `--regenerate` does NOT rebuild the DB (process_meet.py lines 444-465 skip all parsing/building). The 1622→971 record change was likely caused by the agent running `build_database` again (which re-parses from the original JSON), not by `regenerate_output`. The issue is that `build_database` was called instead of `regenerate_output`, or the `regenerate_output` tool internally called the wrong Python code path. Investigate whether `toolRegenerateOutput` in context-tools.ts correctly maps to `--regenerate` and not to the full pipeline. Also: `level_groups` and `page_size_legal` are intentionally NOT sticky (they're excluded from STICKY_FIELDS in models.py as "destructive filters"). This means every regeneration that doesn't pass level_groups reverts to auto-grouping (4 pages). This is the root cause of the 4-page reversion.

---

### Issue 5: Name cleaning misses many event suffix patterns [HIGH]
**Log**: Iterations 24-26. `build_database` auto-cleaned only 3 names, but 14 had event suffixes. Agent spent 3 iterations manually cleaning them.

**Missed patterns**:
- `"Kenzie PrevendarVT,BB,FX"` — no space before event codes
- `"Megan Gentry VT, BB,"` — trailing comma and spaces between codes
- `"Raygan Jones  BB"` — double space before single event code
- `"Bella Estrada VT,"` — trailing comma after event code
- `"Isabella Pansano BB,VT"` — reversed event order

**Fix**: Expand the name cleaning regex in the Python adapters and in `mso_extract`'s JS `cleanName()` function. The current pattern only matches the `\s+(?:IES\s+)?(?:V|UB|Be|Fl|Fx|FX)(?:,(?:V|UB|Be|Fl|Fx|FX))*\s*$` format. Needs to handle no-space, trailing comma, double-space, and reversed order patterns.

**Deepened**: The same regex appears in 3 places: extraction-tools.ts (JS), generic_adapter.py (Python), and the db_builder's name cleanup. Root failures: (1) `\s+` requires leading whitespace but "Kenzie PrevendarVT,BB,FX" has none, (2) comma-separated pattern doesn't allow spaces after commas ("VT, BB,"), (3) trailing commas aren't matched ("VT,"). Proposed improved regex: `\s*(?:IES\s+)?(?:VT|UB|BB|FX|V|Be|Fl|Fx|FX)(?:[,\s]*(?:VT|UB|BB|FX|V|Be|Fl|Fx|FX))*[,\s]*$` — allows any mix of commas/spaces, optional leading whitespace, trailing commas. Must update in all 3 locations. Add VT/BB/FX as longer matches before V/Be/Fl to avoid partial matching.

---

### Issue 6: Agent searches for Men's meets unnecessarily [MEDIUM]
**Log**: Iterations 2-4. Found Men's Nevada State Championship on ScoreCat first. Asked user "Women's only, Men's only, or Both?" — wasting iterations.

**User feedback**: "There is no need to look for men's meets. We pretty much only ever do women's."

**Fix**: Add to the discovery phase prompt: "Default to Women's meets. Only search for Men's meets if the user explicitly requests it. If a search returns only Men's results, note it and keep searching for Women's."

---

### Issue 7: 4-page reversion when regenerating without explicit level_groups [HIGH]
**User feedback**: "It ultimately reverted back to the original backs it made which had 4 backs instead of 2."

**Root cause**: When `regenerate_output` is called without `level_groups`, the layout engine auto-groups based on its default algorithm (which produces 4 pages for this meet). The user's requested 2-page grouping ("all Xcel on one, Levels 2-10 on one") is only applied when `level_groups` is explicitly passed. If the agent regenerates for a different reason (e.g., adjusting dates or gym highlights) without re-specifying level_groups, the shirt reverts to 4 pages.

**Fix**: `shirt_layout.json` (sticky params) should persist `level_groups` across regenerations. If the user previously set level_groups, all subsequent regenerations should use those groups unless explicitly overridden. Verify that the sticky params mechanism actually saves and restores `level_groups`.

---

### Issue 8: MSO search via http_fetch returns homepage HTML [LOW]
**Log**: Iterations 1-2. Agent tried `http_fetch` to `meetscoresonline.com/search?q=...` but got the MSO homepage HTML, not search results. MSO's search is client-side JavaScript.

**Fix**: Remove MSO URL-based search from the discovery flow. MSO discovery should use: (1) Google search to find MSO meet URLs, or (2) direct navigation + `chrome_execute_js` to get the client-rendered search results. The Algolia/ScoreCat search should be the primary automated search.

---

### Issue 9: Domain warning fires during legitimate MSO browsing [LOW]
**Log**: Iterations 6, 10. Agent was browsing MSO to check meet details (not extracting data) and got the domain warning. Already fixed to warn-but-proceed, but still adds noise.

**Fix**: Only show the domain warning during the EXTRACTION phase. During DISCOVERY, the agent legitimately browses MSO to find meet IDs. The phase system can handle this — the warning should check `context.currentPhase` before triggering.

---

### Issue 10: User wants a separate legal-sizing agent [DESIGN]
**User feedback**: "I'm thinking that for meets where we have a back_of_shirt that needs legal sizing there needs to be a completely separate agent that handles that because it is quite tricky."

This is a design suggestion for the agent architecture. Legal sizing involves:
- Determining which page groups need legal size
- Generating shirt PDF with those groups at legal dimensions
- Generating separate gym_highlights filtered by level group
- Generating legal-size IDML
- Coordinating between letter and legal outputs (order forms always use letter)

**Recommendation**: Rather than a separate agent, create a dedicated `legal_sizing` tool that encapsulates all the legal-size logic. This tool would:
1. Accept: level groups to put on legal, page size, layout params
2. Generate: back_of_shirt_8.5x14.pdf, back_of_shirt_8.5x14.idml, gym_highlights_8.5x14.pdf
3. Automatically filter gym_highlights to only include the legal-size levels
4. Coordinate with the letter-size outputs to ensure consistency

Alternatively, fix Issues 2, 3, and 7 so the existing `regenerate_output` handles legal sizing correctly, and add clear instructions in the output_finalize phase prompt.

---

## Implementation Plan

### Stage 1: Fix Python pipeline bugs [CRITICAL — blocks everything]
- [x] 1a. Investigate and fix MSO duplicate extraction (Issue 1)
  - Root cause: generic_adapter.py directory glob loading doubles records
  - Fix: Added _deduplicate() method to generic_adapter.py
- [x] 1b. Fix legal-size shirt PDF generation (Issue 2)
  - Root cause: substring matching on labels instead of level set intersection
  - Fix: Changed pdf_generator.py and idml_generator.py to use set intersection
- [x] 1c. Fix gym_highlights level filtering for legal/letter split (Issue 3)
  - Fix: Changed process_meet.py level filtering to use set intersection
- [x] 1d. Fix `--regenerate` to not rebuild DB from source data (Issue 4)
  - Confirmed: --regenerate already doesn't rebuild DB. Issue was 4-page reversion from non-sticky level_groups
- [x] 1e. Expand name cleaning regex patterns (Issue 5)
  - Updated in both Python adapter and mso_extract JS cleanName()

### Stage 2: Fix level_groups persistence [HIGH]
- [x] 2a. Made level_groups and page_size_legal sticky in process_meet.py
  - Save to shirt_layout.json after generation
  - Restore from shirt_layout.json when not provided on CLI
- [x] 2b. Prevents 4-page reversion when regenerating without explicitly re-specifying
  - The current exclusion causes every regeneration without these params to revert to auto-grouping
  - At minimum, make level_groups sticky so the 2-page layout is preserved
  - Consider: make page_size_legal sticky too, or have the agent always pass it explicitly
  - Alternative: Add these to the context so `regenerate_output` always includes them

### Stage 3: Agent prompt/architecture improvements [MEDIUM]
- [x] 3a. Default to Women's meets in discovery phase (Issue 6)
  - Added "Women's by Default" section to discovery phase prompt
- [x] 3b. Removed domain warnings entirely (Issue 9)
  - Phase system restricts tools per phase; warnings were just noise
- [ ] 3c. Add legal-sizing guidance to output_finalize prompt
  - Document the correct workflow for meets with legal-size pages

### Stage 4: Test with Nevada data
- [ ] 4a. Reprocess Nevada meet with all fixes
- [ ] 4b. Verify: no duplicates, correct name cleaning, 2-page layout preserved
- [ ] 4c. Verify: legal-size shirt generates correctly
- [ ] 4d. Verify: gym_highlights split correctly (letter=Levels 2-10, legal=Xcel)
- [ ] 4e. Verify: regeneration preserves layout and doesn't revert to 4 pages

## Files to Change

| File | Changes |
|------|---------|
| python/adapters/generic_adapter.py | Dedup at parse level, expanded name cleaning |
| python/core/pdf_generator.py | Fix legal-size page extraction |
| python/core/output_generator.py | Gym highlights level filtering for legal/letter |
| python/process_meet.py | Ensure --regenerate doesn't rebuild DB |
| python/core/layout_engine.py | Persist level_groups in shirt_layout.json |
| src/main/tools/extraction-tools.ts | Investigate MSO double extraction |
| src/main/workflow-phases.ts | Default to Women's, phase-aware domain warnings |
| src/main/tools/browser-tools.ts | Phase-aware domain warning check |

## Iteration Savings Estimate
| Issue | Iterations Wasted | After Fix |
|-------|-------------------|-----------|
| Duplicate extraction | 4 | 0 |
| Legal-size shirt fails | 9 | 0-1 |
| Gym highlights filtering | 11 | 0-1 |
| Name cleaning | 3 | 0 |
| Men's meet search | 3 | 0 |
| Regeneration confusion | 3 | 0 |
| **Total** | **33** | **0-2** |

A clean run should complete in ~30 iterations instead of 64.
