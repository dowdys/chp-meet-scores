# Skill: Output Generation

## Overview
After the database is built and quality-checked, generate five output files. All outputs are derived from the `winners` table.

## Output 1: Back of Shirt (`back_of_shirt.md`)

Names grouped by level, then by event within each level. Names sorted alphabetically. No scores, no gyms — names only.

**Structure**:
```
# [Year] [State] State Champions

## Level [N]

### Vault
Alice Johnson
Bob Smith

### Bars
Carol Davis
...

## Level [N+1]
...
```

**Rules**:
- Level order: ascending numerically (1, 2, 3... or 6, 7, 8, 9, 10)
- Event order: Vault, Bars, Beam, Floor, All Around
- Names: DISTINCT per event per level (deduplicate if same athlete appears in multiple sessions/divisions)
- Alphabetical sort within each event section

## Output 2: Back-of-Shirt PDF (`back_of_shirt.pdf`)

Championship-style back-of-shirt PDF. Always generated (no longer optional).

**Visual elements**:
- Title line 1: "{Year} GYMNASTICS" in small caps (~16pt)
- Title line 2: "STATE CHAMPIONS OF {STATE}" in small caps (~20pt)
- Red filled oval below title containing level group label ("XCEL", "LEVELS 2-5", "LEVELS 6-10", etc.)
- Column headers in small caps: VAULT, BARS, BEAM, FLOOR, ALL AROUND
- Level dividers: red horizontal lines extending left/right with letter-spaced text in the middle ("L E V E L  1 0")
- Names centered in 5 columns (Times-Roman, 9pt default, shrinks to 6pt minimum if needed)
- Copyright "© C. H. Publishing" centered at page bottom (7pt)

**Auto-grouping**:
- Xcel levels (XSA/Sapphire, XD/Diamond, etc.) → one page labeled "XCEL", sorted by prestige
- Numbered levels → bin-packed descending (10, 9, 8... down) into page-sized groups
- Each group = one page in the PDF
- Oval label auto-derived from level range

**Name sort order** (`--name-sort` flag):
- `age` (DEFAULT — always use this): Names sorted by division age group (youngest first: Junior A → Junior B → ... → Senior A → Senior B → ...), then alphabetically within each age group
- `alpha`: Names sorted purely alphabetically, ignoring divisions
- The `--name-sort age` flag is the default and should always be used unless the user explicitly asks for alphabetical

**Signature**: `generate_shirt_pdf(db_path, meet_name, output_path, year='2026', state='Maryland', name_sort='age')`

**Column centers**: [72, 192, 306, 420, 546] on 612x792pt (Letter) page

## Output 3: Order Forms PDF (`order_forms.pdf`)

Personalized per-athlete order forms, grouped by gym with blank separator pages.

**Per-form layout**:
- Title: "CONGRATULATIONS TO YOUR {YEAR} STATE CHAMPION!"
- Subtitle about the championship accomplishment
- Athlete name (bold, 14pt), gym name (12pt)
- Events by level (e.g. "Level 7: Vault, Bars") — no session number
- Info about the championship t-shirt
- Contact/ordering box: C.H. Publishing address, phone, checks payable to
- Order table: shirt sizes (Youth S/M/L, Adult S/M/L/XL/XXL) with $27.45 price column

**Gym organization**:
- Athletes within each gym sorted alphabetically by name
- Between gyms: one blank separator page
- Structure: `[Gym A forms] [blank] [Gym B forms] [blank] ... [last gym forms]`

**Signature**: `generate_order_forms_pdf(db_path, meet_name, output_path, year='2026', state='', postmark_date='TBD', online_date='TBD', ship_date='TBD')`

## Per-Page Font Sizing

Each shirt page group independently calls `_fit_font_size()` to find the largest font that fits all names on that page. This means pages with fewer names get larger text automatically. You do NOT need to set a single font size for the entire PDF — it's already per-page.

The `--max-font-size` and `--min-font-size` flags set the upper and lower bounds for this per-page search. If a page has very few names, it uses `max-font-size`. If a page is packed, it shrinks down toward `min-font-size`.

## CLI Arguments

The `process_meet.py` script accepts:
- `--year YYYY` — Championship year for PDF titles (defaults to current year)
- `--state` — State name (required, also used for PDF title and t-shirt graphic)
- `--postmark-date` — Postmark deadline date for order forms (e.g. "March 15, 2026"). Defaults to "TBD".
- `--online-date` — Online ordering deadline date for order forms (e.g. "March 20, 2026"). Defaults to "TBD".
- `--ship-date` — Shipping date for order forms (e.g. "April 5, 2026"). Defaults to "TBD".
- `--max-shirt-pages N` — Constrain the total number of shirt pages to N. When set, the bin-packing algorithm tries progressively smaller font estimates for numbered levels until the page count fits. Xcel pages are kept as-is. Use this when the user wants to limit total pages (e.g., "I need this to fit on 2 pages").
- PDFs are always generated; no `--title-line` flags needed
- **Important**: Use `ask_user` to get ALL deadline dates from the user in a single prompt before generating order forms

## Selective Regeneration (`--regenerate`)

Use `--regenerate` to skip parsing/normalization/DB build and regenerate specific outputs from the existing database. **This is MUCH faster** and should be used for layout adjustments.

When using `--regenerate`, only `--state` and `--meet` are required. `--source` and `--data` are NOT needed.

```
--state Iowa --meet "2025 Iowa State Championships" --regenerate shirt
--state Iowa --meet "2025 Iowa State Championships" --regenerate shirt icml
--state Iowa --meet "2025 Iowa State Championships" --regenerate order_forms
--state Iowa --meet "2025 Iowa State Championships" --regenerate all
```

Available values: `shirt`, `icml`, `order_forms`, `gym_highlights`, `summary`, `all`. (Legacy: `order_txt`, `csv` still work if explicitly requested.)

**Auto-regenerate**: `--regenerate shirt` automatically also regenerates `meet_summary.txt` so the summary always reflects the current shirt layout (page count, grouping). You don't need to add `summary` explicitly.

**When to use**: Adjusting layout params (font size, spacing, fill), changing dates on order forms, or any change that doesn't affect the underlying data. Always prefer `--regenerate` over full pipeline when data hasn't changed.

**When NOT to use**: When the source data or gym map has changed — run the full pipeline instead.

**IMPORTANT**: Never try to edit a generated PDF directly (using PyMuPDF redaction, text replacement, etc.). Always regenerate with the correct parameters.

## Copy to Windows Downloads
After generating all outputs:
```bash
cp /home/goduk/chp-meet-scores/data/[meet_slug]/*.{db,md,txt,csv,pdf} "/mnt/c/Users/goduk/Downloads/"
```
