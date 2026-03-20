---
title: "InDesign soft hyphens break PyMuPDF search_for() on long names"
category: logic-errors
date: 2026-03-20
tags: [indesign, pymupdf, soft-hyphen, search, name-matching, order-forms, gym-highlights]
components: [pdf_generator, order_form_generator]
severity: p1
---

# InDesign soft hyphens break PyMuPDF search_for() on long names

## Problem

After importing a designer-edited PDF from InDesign, some athletes were missing their back page in order forms and their highlight in gym highlights. Specifically, "Avery Bijou Marthepharack" had no back page — causing the front/back page alignment to shift for every athlete after her.

## Root Cause

InDesign wraps long names across lines using a **soft hyphen** (Unicode `\xad` / U+00AD). The PDF text content becomes:

```
Line 1: "Avery Bijou Marthep\xad"   (soft hyphen at end)
Line 2: "harack"
```

PyMuPDF's `search_for("Avery Bijou Marthepharack")` fails because the full string never appears on a single line. The soft hyphen is invisible to users viewing the PDF but splits the searchable text.

This affects ANY name long enough to be wrapped by InDesign's text engine. It's not specific to this athlete — any meet could have names that trigger it.

## Solution

Implemented `_search_by_word_proximity()` in `pdf_generator.py`:

1. Split the name into individual words
2. Search for each word until one has a hit (the "anchor")
3. Check text near the anchor position (within 40pt horizontal, 20pt vertical)
4. Count how many name words appear in that nearby text
5. For words not found exactly, check if a prefix appears (handles the hyphenated word)
6. If all-but-one or more words match → confirmed match, return the anchor rect

This handles edge cases:
- Last name hyphenated: "Marthep-" + "harack" → "Avery" and "Bijou" found nearby
- First name hyphenated: anchor on a later word, verify others nearby
- Very long multi-word names wrapping to 2+ lines: each word checked independently
- Short first name (e.g., "Jo"): requires other words nearby to prevent false matches

## Why the earlier prefix approach failed

The first fix tried searching for 80%/60% of the name as a prefix. This caused false positives: `"Charlotte "` (60% of "Charlotte Casella") matched OTHER Charlottes on different pages, giving athletes extra back pages and breaking the front/back alignment for everyone after.

## Prevention

When searching for text in PDFs that were edited in InDesign (or any professional layout tool), never assume the full text string appears contiguously. Layout tools insert soft hyphens, optional line breaks, and other invisible characters. Always have a fallback that searches by individual words with proximity verification.
