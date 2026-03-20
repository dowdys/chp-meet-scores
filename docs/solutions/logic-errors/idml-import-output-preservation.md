---
title: "After IDML import, only order_forms preserves designer edits — gym_highlights regenerates from scratch"
category: logic-errors
date: 2026-03-20
tags: [idml-import, order-forms, gym-highlights, designer-edits]
components: [pdf_generator, order_form_generator, process_meet]
severity: p2
---

# After IDML import, only order_forms preserves designer edits

## Problem

User edits IDML in InDesign (changes fonts, colors, spacing). Imports it back. Expects all outputs to reflect their changes. But only order_forms.pdf shows the changes — gym_highlights.pdf looks identical to before.

## Root Cause

The two outputs use fundamentally different mechanisms:

| Output | Mechanism | Preserves IDML edits? |
|--------|-----------|----------------------|
| **order_forms.pdf** | Embeds actual back_of_shirt.pdf pages via `show_pdf_page()` overlay, then adds red star highlighting | YES |
| **gym_highlights.pdf** | Regenerates entirely from database data using code-template styling (hardcoded fonts, sizes, colors) | NO |

Gym highlights can't embed back_of_shirt pages because it has a fundamentally different layout — it adds gym name headers between the title and the oval, and uses yellow highlighting instead of red stars.

## Key Locations

- Order forms PDF overlay: `order_form_generator.py` calls `add_shirt_back_pages_from_pdf()` from `pdf_generator.py`
- Gym highlights code generation: `generate_gym_highlights_pdf()` in `pdf_generator.py` — always renders from scratch

## Current State

The IDML import prompt now explicitly tells the agent:
- order_forms automatically use the imported PDF (designer edits preserved)
- gym_highlights regenerates from DB data (designer edits NOT reflected)
- NEVER ask the user what they changed — the IDML contains the changes

## Future Improvement

To fully preserve designer edits in gym_highlights, would need to extract styling parameters (font family, accent color, font sizes) from the IDML XML and pass them as layout parameters to `generate_gym_highlights_pdf()`. This is tracked but not yet implemented.
