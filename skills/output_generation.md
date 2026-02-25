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

## Output 2: Order Forms by Gym (`order_forms_by_gym.txt`)

Grouped by gym (alphabetical). Each winner listed with events won and level/division.

**Structure**:
```
============================================================
  Gym Name Here
============================================================
  Athlete Name - Vault, Beam, AA
  Level 7 Division Jr A

  Another Athlete - Floor
  Level 8 Division Sr B
```

**Rules**:
- Gyms alphabetical
- Within each gym: athletes sorted by level (ascending), then division, then name
- Events listed in order: Vault, Bars, Beam, Floor, AA
- Each athlete entry shows all events won in one line, level+division on the next

## Output 3: Winners CSV (`winners_sheet.csv`)

Spreadsheet format with TRUE/FALSE event columns.

**Columns**: `name, gym name, level, Vault, Bars, Beam, Floor, AA`

**Rules**:
- One row per unique winning athlete (per level+division+session)
- Event columns: TRUE if athlete won that event, FALSE otherwise
- Sort order: level descending (highest first), then division youngest-to-oldest, then AA score descending
- Division ordering is auto-detected from division names in the database (Child < Youth < Junior < Senior, with sub-letters A-D). Cached per state in `state_divisions.json` alongside the database.

## Output 4: Back-of-Shirt PDF (`back_of_shirt.pdf`)

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

**Signature**: `generate_shirt_pdf(db_path, meet_name, output_path, year='2026', state='Maryland')`

**Column centers**: [72, 192, 306, 420, 546] on 612x792pt (Letter) page

## Output 5: Order Forms PDF (`order_forms.pdf`)

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

**Signature**: `generate_order_forms_pdf(db_path, meet_name, output_path, year='2026')`

## CLI Arguments

The `process_meet.py` script accepts:
- `--year YYYY` — Championship year for PDF titles (defaults to current year)
- `--state` — State name (required, also used for PDF title)
- PDFs are always generated; no `--title-line` flags needed

## Copy to Windows Downloads
After generating all outputs:
```bash
cp /home/goduk/chp-meet-scores/data/[meet_slug]/*.{db,md,txt,csv,pdf} "/mnt/c/Users/goduk/Downloads/"
```
