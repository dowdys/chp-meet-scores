# Plan 010: Critical Fixes — Stale Files, Dates, Backs, Gym Highlights, Mixed Sources, Search

## Issues to Fix

### Issue 1: Stale extraction files cause 17x data bloat [CRITICAL]
**Problem**: Data directory accumulates mso_extract_*.json files across runs. The generic_adapter's directory glob loads ALL matching files. 12 extract files × ~971 records each = 17,479 parsed instead of 971.
**Root cause**: Old extract files are never cleaned up. The adapter's `_parse_directory` globs `*.json`.
**Fix**:
- Clean up old extract files before new extraction in `mso_extract` and `scorecat_extract` tools
- Also clean in `build_database` tool before calling Python
- Add timestamp-based cleanup: delete extract files older than the current session

### Issue 2: Order form dates showing "TBD" [HIGH]
**Problem**: Agent collects dates (April 4, 8, 20) in discovery but order forms show "TBD".
**Root cause**: Need to trace the date flow:
- Agent stores dates in conversation context
- `build_database` tool doesn't accept date params (only `regenerate_output` does)
- When `build_database` generates outputs (including order_forms), it calls Python without date flags
- Similarly, `import_pdf_backs` may not be passing dates through
**Fix**:
- Add date params to `build_database` tool schema and pass to Python
- Verify `import_pdf_backs` passes dates correctly
- Add date params to the `--import-pdf` Python path

### Issue 3: No backs on order forms after PDF import [HIGH]
**Problem**: After importing designer PDFs, order forms have no back pages.
**Root cause**: Need to check if `back_of_shirt.pdf` has searchable text after import. The rasterized+invisible-text approach may have a bug.
**Fix**: Verify the order form generator can find names in the imported back_of_shirt.pdf. Test with `search_for()` on the imported file.

### Issue 4: Gym highlights not using imported designer backs [HIGH]
**Problem**: Despite code to call `generate_gym_highlights_from_pdf`, gym highlights are still code-generated.
**Root cause**: The `--import-pdf` Python path may not be reaching the `generate_gym_highlights_from_pdf` call. Need to trace the exact code path.
**Fix**: Add logging to trace which gym highlights function is called. Verify the letter-only and legal PDF paths are correct.

### Issue 5: Mix of designer + code-generated backs per page [NEW CAPABILITY]
**Problem**: User wants designer backs for Levels 2-10 AND Xcel gym highlights/order forms, but wants code-generated Xcel back for ORDER FORMS (since they don't have a letter-size Xcel PDF).
**Root cause**: Currently import is all-or-nothing — either all pages from imported PDF or all from code.
**Fix**:
- When back_of_shirt.pdf has both imported pages (letter) and scaled pages (legal), the order form generator already handles this (it reads from back_of_shirt.pdf which contains both)
- For gym highlights: use imported PDF where available, code-generated where not
- This may already work if the import correctly builds back_of_shirt.pdf with all pages

### Issue 6: search_meets tool needed [OPTIMIZATION]
**Problem**: Agent spends 10-20 iterations browsing MSO. Needs a structured search.
**Root cause**: No tool that calls Algolia + MSO Results.All API.
**Fix**:
- Test Algolia API and MSO Results.All API to confirm they work
- Build `search_meets` tool that calls both and returns structured results
- Add to discovery phase

## Implementation Order

### Stage 1: Fix stale file cleanup [CRITICAL — fixes 17x bloat]
- [ ] In extraction-tools.ts: clean old extract files before new extraction
- [ ] In context-tools.ts toolBuildDatabase: clean old extract files if data_path is specific file
- [ ] Add cleanup in resetStagingDb or at start of processMeet

### Stage 2: Fix date passthrough [HIGH — fixes TBD on order forms]
- [ ] Add date params to build_database tool schema
- [ ] Pass dates from build_database through to Python
- [ ] Verify import_pdf_backs passes dates to Python
- [ ] Test: dates should appear on order forms

### Stage 3: Fix order form backs after import [HIGH]
- [ ] Test search_for on imported back_of_shirt.pdf
- [ ] If names not found, fix the invisible text layer
- [ ] Verify back_of_shirt.pdf has correct structure after import

### Stage 4: Fix gym highlights to use imported backs [HIGH]
- [ ] Add debug logging to trace which function is called
- [ ] Verify _letter_only_shirt path exists when generate_gym_highlights_from_pdf is called
- [ ] Test the full import → gym highlights flow

### Stage 5: Build search_meets tool [OPTIMIZATION]
- [ ] Test Algolia API: does it return structured meet data?
- [ ] Test MSO Results.All: can we get meet IDs from HTML/API?
- [ ] Build search_meets Python function
- [ ] Add search_meets TypeScript tool
- [ ] Add to discovery phase

### Stage 6: Mixed source capability [NEW]
- [ ] Document which scenarios need mixed sources
- [ ] Determine if existing code already handles this
- [ ] If not, modify order form generator to accept per-page source
