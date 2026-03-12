# Skill: Output Generation

## Overview
After the database is built and quality-checked, generate six output files. All outputs are derived from the `winners` table.

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

**Visual elements** (all sizes configurable via flags):
- Title line 1: "{Year} {SPORT}" in small caps (~18pt, configurable via `--title1-size`, sport via `--sport`)
- Title line 2: "{TITLE_PREFIX} {STATE}" in small caps (~20pt, configurable via `--title2-size`, prefix via `--title-prefix`)
- Accent-colored filled oval below title containing level group label ("XCEL", "LEVELS 2-5", etc.) — color via `--accent-color`
- Column headers in small caps: VAULT, BARS, BEAM, FLOOR, ALL AROUND (size via `--header-size`)
- Level dividers: accent-colored lines extending left/right with letter-spaced text (size via `--divider-size`)
- Names centered in 5 columns (default Times-Roman, 9pt, shrinks to 6.5pt minimum if needed; font via `--font-family`)
- Name spacing controlled by `--line-spacing` (default 1.15, lower = tighter names)
- Copyright text centered at page bottom (7pt, text via `--copyright`)
- Y positions auto-adjust when title sizes change (bigger titles = less space for names)

**Level grouping** (auto or custom):
- **Default (auto)**: Xcel levels → one or more pages labeled "XCEL", sorted by prestige. Numbered levels → bin-packed descending (10, 9, 8... down) into page-sized groups. Oval labels auto-derived.
- **Custom** (`--level-groups`): Override auto grouping with explicit page assignments. Semicolon-separated groups, comma-separated levels. E.g. `"XSA,XD,XP,XG,XS,XB;10,9,8,7,6;5,4,3,2,1"` → page 1 = all Xcel, page 2 = levels 6-10, page 3 = levels 1-5. Use this when the user wants specific levels on specific pages. **IMPORTANT: Any level NOT included in the groups will be omitted from the shirt entirely.** Always cross-check your groups against the "WINNERS PER LEVEL" list in meet_summary.txt to ensure no levels with winners are accidentally excluded.
- **Constrained** (`--max-shirt-pages N`): Auto grouping but constrained to N total pages. Bin-packer shrinks font estimates until groups fit.

**Name sort order** (`--name-sort` flag):
- `age` (DEFAULT — always use this): Names sorted by division age group (youngest first: Junior A → Junior B → ... → Senior A → Senior B → ...), then alphabetically within each age group
- `alpha`: Names sorted purely alphabetically, ignoring divisions
- The `--name-sort age` flag is the default and should always be used unless the user explicitly asks for alphabetical

**Signature**: `generate_shirt_pdf(db_path, meet_name, output_path, year='2026', state='Maryland', name_sort='age')`

**Column centers**: [72, 192, 306, 420, 546] on 612x792pt (Letter) page

## Output 2b: Back-of-Shirt IDML (`back_of_shirt.idml`)

Full InDesign document (ZIP of XML files) that opens in InDesign CS6+ as a complete, editable document. Unlike ICML, IDML includes:
- Vector graphics: red filled oval behind group label, red underlines below column headers, red flanking lines on level dividers
- Proper page layouts with Letter-size pages and positioned text frames
- All paragraph styles, colors, and fonts embedded in the package
- No manual decoration work needed — opens as a complete document

**When to use IDML vs ICML**: IDML is the preferred InDesign format. ICML is text-only (no graphics) and requires manual InDesign work to add ovals and lines. IDML is a complete document that needs no manual work.

**Signature**: `generate_shirt_idml(db_path, meet_name, output_path, year='2026', state='Maryland', name_sort='age')`

Same style flags as the PDF (all `--accent-color`, `--font-family`, `--sport`, etc. flow through).

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

**Layout flags** (all have sensible defaults, all saved to `shirt_layout.json` for future runs):
- `--title1-size FLOAT` — Font size for title line 1 (default 18). The user may want this bigger (e.g. 22, 24) for visual impact. Y positions auto-adjust.
- `--title2-size FLOAT` — Font size for title line 2 (default 20).
- `--max-font-size FLOAT` — Maximum name font size (default 9). Pages with few names use this size.
- `--min-font-size FLOAT` — Minimum name font size (default 6.5). Pages with many names shrink toward this.
- `--line-spacing FLOAT` — Line height ratio for name spacing (default 1.15). Lower = tighter names (e.g. 1.05 for very tight, 1.3 for more breathing room). This is the main way to reduce margins between names.
- `--level-gap FLOAT` — Vertical gap before each level section (default 6).
- `--max-fill FLOAT` — Max page fill fraction (default 0.90). E.g. 0.85 = 85%.
- `--max-shirt-pages N` — Constrain total shirt pages (bin-packer shrinks font estimates to fit).
- `--level-groups STRING` — Custom level grouping (overrides auto bin-packing). Semicolon-separated groups, comma-separated levels. E.g. `"XSA,XD,XP,XG,XS,XB;10,9,8,7,6;5,4,3,2,1"`. Any levels with winners NOT listed are auto-appended to the last group (no winners are silently dropped).
- `--exclude-levels STRING` — Comma-separated levels to intentionally exclude from the shirt (e.g. `"3,4"` if those levels had no real scores). Excluded levels will not appear even with auto-grouping.

**Style flags** (all saved to `shirt_layout.json`):
- `--copyright TEXT` — Copyright footer text (default "© C. H. Publishing"). E.g. `--copyright "© My Company 2026"`.
- `--accent-color HEX` — Accent color for ovals, dividers, header underlines (default "#FF0000" red). E.g. `--accent-color "#003366"` for navy, `--accent-color "#CC0000"` for dark red.
- `--font-family serif|sans-serif` — Font family (default "serif" = Times). Use "sans-serif" for Helvetica.
- `--sport TEXT` — Sport name in title line 1 (default "GYMNASTICS"). E.g. `--sport "CHEERLEADING"` or `--sport "DANCE"`.
- `--title-prefix TEXT` — Title line 2 prefix before state (default "STATE CHAMPIONS OF"). E.g. `--title-prefix "REGIONAL CHAMPIONS OF"`.
- `--header-size FLOAT` — Font size for column headers VAULT, BARS, etc. (default 11).
- `--divider-size FLOAT` — Font size for level divider text LEVEL 10, SAPPHIRE, etc. (default 10).

PDFs are always generated; no `--title-line` flags needed.

**Important**: Use `ask_user` to get ALL deadline dates from the user in a single prompt before generating order forms.

**Important**: Before attempting ANY layout change, load this skill first so you know what flags are available. Do NOT guess or assume a feature doesn't exist.

## Selective Regeneration (`--regenerate`)

Use `--regenerate` to skip parsing/normalization/DB build and regenerate specific outputs from the existing database. **This is MUCH faster** and should be used for layout adjustments.

When using `--regenerate`, only `--state` and `--meet` are required. `--source` and `--data` are NOT needed.

```
--state Iowa --meet "2025 Iowa State Championships" --regenerate shirt
--state Iowa --meet "2025 Iowa State Championships" --regenerate shirt icml
--state Iowa --meet "2025 Iowa State Championships" --regenerate order_forms
--state Iowa --meet "2025 Iowa State Championships" --regenerate all
```

Available values: `shirt`, `icml`, `idml`, `order_forms`, `gym_highlights`, `summary`, `all`. (Legacy: `order_txt`, `csv` still work if explicitly requested.)

**Auto-regenerate**: `--regenerate shirt` automatically also regenerates ALL shirt-dependent outputs: `meet_summary.txt`, `back_of_shirt.icml`, `back_of_shirt.idml`, `order_forms.pdf`, and `gym_highlights.pdf`. This ensures they all use the updated layout (page groups, font sizes, spacing). You don't need to list them explicitly.

**When to use**: Adjusting layout params (font size, spacing, fill), changing dates on order forms, or any change that doesn't affect the underlying data. Always prefer `--regenerate` over full pipeline when data hasn't changed.

**When NOT to use**: When the source data or gym map has changed — run the full pipeline instead.

**IMPORTANT**: Never try to edit a generated PDF directly (using PyMuPDF redaction, text replacement, etc.). Always regenerate with the correct parameters.

## IDML Import (`--import-idml`)

Use `--import-idml` to convert a finalized IDML file (edited in InDesign) back into the definitive `back_of_shirt.pdf`. This is for the round-trip workflow where the user takes the IDML, makes final touches in InDesign, and returns it to the app.

When using `--import-idml`, only `--state`, `--meet`, `--output`, and the IDML path are required. `--source` and `--data` are NOT needed.

```
--state Mississippi --meet "2025 Mississippi State Championships" \
  --output ./output/ --import-idml /path/to/finalized.idml
```

**What it does**:
1. Parses the IDML ZIP (extracts text frames, positions, fonts, colors, graphics)
2. Renders a pixel-accurate PDF matching the InDesign edits
3. Reads embedded meet metadata (meet name, state, year) from the IDML
4. Regenerates `order_forms.pdf` and `gym_highlights.pdf` from the existing database

**Embedded metadata**: Every IDML generated by this app contains hidden meet metadata (meet name, state, year, DB path). When the IDML comes back after InDesign editing, this metadata identifies which meet it belongs to.

**When to use**: After the user has edited the IDML in InDesign and wants to finalize the shirt back. The imported PDF becomes the definitive version.

## Sticky Layout Params

ALL layout and style params (`--max-shirt-pages`, `--line-spacing`, `--level-gap`, `--max-fill`, `--min-font-size`, `--max-font-size`, `--title1-size`, `--title2-size`, `--level-groups`, `--copyright`, `--accent-color`, `--font-family`, `--sport`, `--title-prefix`, `--header-size`, `--divider-size`) are **saved to `shirt_layout.json`** in the output directory after each shirt generation. On subsequent runs (including full pipeline re-runs), saved params are loaded automatically — you do NOT need to re-pass them. CLI args still override saved values. This means:
- `--regenerate shirt --max-shirt-pages 2` → saves `max_shirt_pages: 2` → all future runs use 2 pages
- `--regenerate shirt --level-groups "XSA,XD,XP,XG,XS,XB;10,9,8,7,6;5,4,3"` → saves custom grouping → persists
- Full pipeline re-run (no layout args) → reads saved params → uses saved layout
- `--regenerate shirt --max-shirt-pages 3` → overrides saved value → now uses 3 pages

## Copy to Windows Downloads
After generating all outputs:
```bash
cp /home/goduk/chp-meet-scores/data/[meet_slug]/*.{db,md,txt,csv,pdf} "/mnt/c/Users/goduk/Downloads/"
```
