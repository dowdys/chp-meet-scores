# Skill: Output Generation

## Overview
After the database is built and quality-checked, generate three output files plus an optional shirt PDF. All outputs are derived from the `winners` table.

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
- For division ordering maps per state, load `details/division_ordering`

## Output 4: Shirt PDF (optional)

Back-of-shirt PDF matching championship shirt format.

**Layout**:
- Title block: "[Year] Gymnastics", "State Champions of [State]", "Levels [range]"
- 5 event columns at x-centers: [62, 184, 306, 428, 550] on 612x792pt (Letter) page
- Names in Times-Roman 9pt, line height 13pt
- Names grouped by level with bold centered "Level X" dividers
- Auto-paginated: levels that don't fit on page 1 flow to page 2

**Font sizes**: Title=22pt, Subtitle=16pt, Column headers=13pt, Names=9pt

## Copy to Windows Downloads
After generating all outputs:
```bash
cp /home/goduk/chp-meet-scores/data/[meet_slug]/*.{db,md,txt,csv,pdf} "/mnt/c/Users/goduk/Downloads/"
```
