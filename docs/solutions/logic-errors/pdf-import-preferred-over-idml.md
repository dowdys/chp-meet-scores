---
title: "PDF import is simpler and more reliable than IDML import for designer edits"
category: logic-errors
date: 2026-03-20
tags: [idml-import, pdf-import, designer-edits, indesign]
components: [process_meet, context-tools]
severity: p1
---

# PDF import is simpler and more reliable than IDML import

## Problem

The IDML import pathway accumulated 10+ bugs across multiple sessions:
- XML namespace handling breaks after InDesign round-trip
- PyMuPDF file handle leaks on Windows
- Page combining logic is fragile
- Metadata extraction fails silently
- Agent spends 7+ iterations manually combining PDFs

## Root Cause

IDML is a ZIP of XML files. Converting IDML→PDF requires:
1. Parsing InDesign XML (with namespace variations after round-trip)
2. Extracting embedded metadata (CHP_METADATA in Content tags)
3. Converting spreads to PDF pages via the IDML parser
4. Detecting page sizes from metadata
5. Combining pages from multiple imports

Each step has failure modes. The system was doing complex XML parsing and PDF manipulation when all it actually needed was the final rendered PDF.

## Solution

Added `import_pdf_backs` tool that accepts PDF files directly:
- User exports PDFs from InDesign (File → Export → PDF)
- System copies them to the correct locations
- Automatically combines letter + legal PDFs for order forms
- Regenerates order_forms, gym_highlights, and meet_summary
- No XML parsing, no namespace issues, no metadata extraction

The old `import_idml` remains as a legacy fallback but `import_pdf_backs` is preferred.

## Key Insight

When designing import workflows, ask: "What does the system actually need?" The system needed rendered PDF pages — not the editable source format. The IDML was being processed only to produce the same PDF that InDesign can export directly. Accepting the output format (PDF) instead of the source format (IDML) eliminates an entire class of conversion bugs.
