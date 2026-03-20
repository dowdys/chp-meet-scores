# Plan 008: IDML Import Workflow Overhaul

## Source
Process log analysis of 2026 Nevada State Championships IDML import session (37 iterations, ~15 wasted on IDML handling). User said agent should NOT have been triggered for this — needs a dedicated IDML import agent/workflow.

## Critical Issues Found

### Issue 1: First IDML import still uses "IDML Import" folder despite fallback params [BUG]
**Log line 1558-1562**: Agent passed `state: "Nevada"` and `meet_name: "2026 Nevada State Championships"` as fallback params, but the Python code still used "IDML Import" as the output folder. The fallback params in toolImportIdml set `context.outputName` but the Python `--import-idml` code path has its own metadata extraction and when that fails, it falls back to "IDML Import" internally. The TypeScript-level fallback doesn't reach the Python process.

**Fix**: Pass `--state` and `--meet` flags to process_meet.py when fallback params are provided, so Python uses them instead of "IDML Import".

### Issue 2: Agent combines pages manually via PyMuPDF — should be automatic [ARCHITECTURE]
**Log iterations 28-34**: Agent spent ~7 iterations manually combining the two imported PDFs, making mistakes (file locking errors, wrong page order, wrong page sizes in back_of_shirt.pdf). This manual PDF manipulation is error-prone and fragile.

**Fix**: The `import_idml` tool (or a new `combine_imported_backs` tool) should handle multi-back combination automatically. When user provides two IDML files for the same meet, the system should:
1. Import each IDML to the correct location
2. Automatically create a combined back_of_shirt.pdf with all pages
3. Keep individual files (back_of_shirt_8.5x14.pdf) as separate legal-only versions
4. Regenerate order_forms using the combined back

### Issue 3: Order forms need back_of_shirt.pdf to have ALL pages [ARCHITECTURE]
**Log line 1984**: User said "getting rid of Xcel from the letter size back of shirt made it so that you lost the Xcel back for the order forms." The order form generator reads pages from `back_of_shirt.pdf` and matches athletes to pages. If a page is missing, those athletes get no back on their order form.

**Key insight**: `back_of_shirt.pdf` MUST always contain ALL pages for order forms to work. Even if the Xcel page is also in `back_of_shirt_8.5x14.pdf` as a separate file, back_of_shirt.pdf needs both pages.

**Fix**: After any IDML import that produces a partial back (one page of a multi-page meet), automatically combine it with the existing pages in back_of_shirt.pdf.

### Issue 4: Agent tried to put legal-size page in back_of_shirt.pdf [UNDERSTANDING]
**Log line 2122**: "now you put the legal size back on a letter size sheet which is also wrong." The agent combined the XCEL legal page (612x900) into back_of_shirt.pdf alongside the letter page (612x792). This creates mixed-size pages which confuses the order form generator.

**Key insight**: Order forms should always use letter-size pages. The legal-size page should be scaled down to letter size when included in back_of_shirt.pdf for order form purposes.

**Fix**: When combining pages into back_of_shirt.pdf, scale legal-size pages to letter size. The legal-size originals remain in back_of_shirt_8.5x14.pdf.

### Issue 5: No dedicated IDML import workflow/agent [DESIGN]
The user explicitly requested "a whole new agent for handling what to do when receiving idml files." Currently the agent uses generic tools and manual PyMuPDF scripts. This should be a dedicated workflow.

**Fix**: Create a dedicated `import_and_combine_backs` tool that handles the complete IDML import workflow:
1. Accept one or more IDML file paths
2. Import each to PDF
3. Detect page sizes and meet metadata
4. Combine into back_of_shirt.pdf (all pages at letter size for order forms)
5. Keep legal-size originals as separate files
6. Regenerate order_forms and gym_highlights automatically

### Issue 6: gym_highlights still uses old/code-generated backs [KNOWN]
Already documented in plan 007. The gym_highlights regenerates from DB data and doesn't use the imported backs. The user accepted this for now but it should be improved long-term.

### Issue 7: Discovery phase still wastes iterations browsing MSO [RECURRING]
Despite adding MSO discovery guidance to the prompt, the agent still spent iterations 1-10 browsing MSO before using mso_extract. The prompt guidance isn't strong enough.

**Fix**: Make the discovery phase even more directive. When a meet ID is found in a URL (e.g., `/R34775`), the agent should immediately save it and move to extraction — not browse the website further.

## Implementation Plan

### Stage 1: Fix import_idml fallback to actually work [CRITICAL]
- [x] When fallback state/meet_name are provided, now passes --state and --meet to process_meet.py
- [x] Python --import-idml code already supports these (lines 247-262) — just wasn't receiving them

### Stage 2: Create `import_and_combine_backs` tool [DEFERRED]
- Decided to handle via detailed prompt guidance instead of a new tool
- The combination workflow is documented step-by-step in the output_finalize prompt
- A dedicated tool would be cleaner but the prompt-guided approach works for now

### Stage 3: Improve IDML import prompt in output_finalize phase [HIGH]
- [x] Detailed step-by-step multi-IDML workflow added to output_finalize prompt
- [x] CRITICAL RULES section: never ask user what they changed, always provide state/meet_name
- [x] Order forms behavior documented (back_of_shirt.pdf must have ALL pages)
- [x] Gym highlights behavior documented (always from DB, not imported backs)

### Stage 4: Strengthen discovery phase [MEDIUM]
- Already addressed in previous plan (MSO meet discovery guidance added)

## Files to Change

| File | Changes |
|------|---------|
| src/main/context-tools.ts | Fix import_idml fallback, add import_and_combine_backs tool |
| src/main/tool-definitions.ts | Add import_and_combine_backs tool definition |
| src/main/workflow-phases.ts | Add tool to output_finalize, improve prompts |
| python/process_meet.py | Accept --state/--meet fallback for --import-idml |
