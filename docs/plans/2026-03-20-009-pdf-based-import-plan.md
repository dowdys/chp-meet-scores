# Plan 009: Switch from IDML Import to PDF-Based Import

## Motivation

The IDML import pathway has accumulated 10+ bugs across multiple sessions:
- IDML XML namespace handling breaks after InDesign round-trip
- PyMuPDF file handle leaks on Windows
- Page combining logic is fragile (save-over-self corruption risk)
- Metadata extraction fails silently
- Gym highlights don't reflect designer edits
- Legal IDML overwrites letter IDML during sequential import
- Agent spends 7+ iterations manually combining PDFs

**The core insight**: The system doesn't need to *process* IDML files. It needs the final rendered PDF pages. When the user edits in InDesign and exports PDFs, those are the finished product. The system just needs to:
1. Place them in the correct output folder
2. Regenerate order forms (which embed PDF pages directly)
3. Regenerate gym highlights

## Design

### New tool: `import_pdf_backs`

Replaces `import_idml`. Accepts one or two PDF file paths:

```
import_pdf_backs({
  letter_pdf: "C:\Users\...\NV 2026 2-10.pdf",        // optional
  legal_pdf: "C:\Users\...\NV 2026 XCEL 8.5x14.pdf",  // optional
  state: "Nevada",                                      // required
  meet_name: "2026 Nevada State Championships",         // required
  postmark_date: "April 4, 2026",                       // optional
  online_date: "April 8, 2026",                         // optional
  ship_date: "April 20, 2026"                           // optional
})
```

The tool:
1. Copies letter PDF → `back_of_shirt.pdf` in the meet output folder
2. Copies legal PDF → `back_of_shirt_8.5x14.pdf` in the meet output folder
3. If BOTH are provided, creates a combined `back_of_shirt.pdf` with all pages (for order forms)
4. Regenerates `order_forms.pdf` using the combined back_of_shirt.pdf
5. Regenerates `gym_highlights.pdf` and `gym_highlights_8.5x14.pdf` with correct level splits
6. Sets `idmlImported` flag to prevent build_database from running
7. Returns summary of what was generated

### Keep `import_idml` as legacy/fallback

Don't remove import_idml — some users may still provide IDML files. But the primary workflow becomes PDF import. The agent should prefer `import_pdf_backs` when the user provides PDF files.

### What about IDML archival?

The user can keep IDML files alongside PDFs for future InDesign editing. The system doesn't need to process them. If the user provides IDML files, the agent should:
1. Ask: "Would you like to export these as PDFs from InDesign? That gives the best results."
2. If user insists on IDML, fall back to import_idml (with all its limitations)

## Implementation

### Stage 1: Create `import_pdf_backs` Python function
- [ ] New function in `process_meet.py` or a new module
- [ ] Accepts: letter_pdf_path, legal_pdf_path, state, meet_name, output_dir, db_path, dates
- [ ] Copies PDFs to correct locations
- [ ] Creates combined back_of_shirt.pdf when both sizes provided
- [ ] Regenerates order_forms using the PDF
- [ ] Regenerates gym_highlights with level splits (using saved level_groups from shirt_layout.json)
- [ ] Regenerates meet_summary
- [ ] No IDML parsing, no XML namespaces, no metadata extraction

### Stage 2: Create TypeScript tool
- [ ] Add `import_pdf_backs` to tool-definitions.ts with typed schema
- [ ] Add `toolImportPdfBacks` to context-tools.ts
- [ ] Calls Python with new CLI flag: `--import-pdf-letter <path> --import-pdf-legal <path>`
- [ ] Sets idmlImported flag (prevent build_database)
- [ ] Returns summary

### Stage 3: Update workflow phases
- [ ] Add `import_pdf_backs` to output_finalize phase tools
- [ ] Update output_finalize prompt to prefer PDF import over IDML
- [ ] When user provides .pdf file paths, use import_pdf_backs
- [ ] When user provides .idml file paths, suggest PDF export, fall back to import_idml

### Stage 4: Handle the combined PDF correctly
- [ ] When both letter and legal PDFs are provided:
  - back_of_shirt.pdf = combined (all pages, legal page first for consistency)
  - back_of_shirt_8.5x14.pdf = legal-only copy
  - The letter-only pages stay in back_of_shirt.pdf
- [ ] When only letter PDF provided:
  - back_of_shirt.pdf = letter pages
  - If back_of_shirt_8.5x14.pdf already exists, prepend it to back_of_shirt.pdf
- [ ] When only legal PDF provided:
  - back_of_shirt_8.5x14.pdf = legal pages
  - If back_of_shirt.pdf already exists, prepend legal pages to it
- [ ] Use safe temp-file-then-rename pattern (no save-over-self)

### Stage 5: Fix gym_highlights in import path
- [ ] Use generate_gym_highlights_from_pdf when available (overlays on actual PDF)
- [ ] Fall back to code-generated if overlay function can't handle the format
- [ ] Level split: letter gym_highlights gets letter levels, legal gets legal levels

### Stage 6: Update agent-loop.ts IDML path detection
- [ ] Currently detects .idml in user input → sets phase to output_finalize
- [ ] Also detect .pdf paths → same behavior
- [ ] When both .idml and .pdf are provided, prefer .pdf

## Files to Change

| File | Changes |
|------|---------|
| python/process_meet.py | Add --import-pdf-letter and --import-pdf-legal CLI flags, implement PDF import function |
| src/main/context-tools.ts | Add toolImportPdfBacks function |
| src/main/tool-definitions.ts | Add import_pdf_backs tool schema |
| src/main/workflow-phases.ts | Add tool to output_finalize, update prompts |
| src/main/agent-loop.ts | Detect .pdf paths in user input |

## What This Eliminates

| Bug | Status After Change |
|-----|-------------------|
| IDML namespace handling (Findings 10, 11) | Eliminated — no XML parsing |
| PyMuPDF file handle leaks (Finding 1) | Eliminated — simple file copy |
| Save-over-self corruption (Finding 3) | Fixed — temp file pattern |
| Gym highlights wrong layout (Finding 5) | Fixed — use from_pdf overlay |
| IDML overwrite (Finding 7) | Eliminated — no IDML processing |
| Metadata extraction failures | Eliminated — state/meet_name are explicit params |
| 7+ iterations of manual PDF combining | Eliminated — automatic in Python |
