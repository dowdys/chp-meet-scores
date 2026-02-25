# Skill: MeetScoresOnline PDF Extraction

## Overview
Fallback extraction method for MSO meets where the JSON API returns zero rows (meet not yet converted to Interactive format). The Report Builder generates PDFs parsed by PyMuPDF.

**Use this skill ONLY when the JSON API (see `mso_html_extraction`) returns empty.** The JSON API and Report Builder contain identical data — JSON is preferred because it's headless and needs no login.

## Prerequisites
- Meet discovered via `meet_discovery` skill with a numeric `meetId`
- JSON API confirmed empty (POST to `Ajax.ProjectsJson.msoMeet.aspx` returned 0 rows)
- Chrome connected via CDP, logged into MSO (Report Builder requires a free account)

## When This Is Needed
Newer meets often appear on MSO with Report Builder PDFs before they get the Interactive/JSON format. The timeline is typically:
1. Meet happens → Report Builder PDFs available (requires login)
2. Later → Interactive results + JSON API become available (no login)

If the JSON API has data, skip this skill entirely — use `mso_html_extraction` instead.

## Method 1: Direct PDF URL (Preferred — No UI Interaction)

PDF URLs follow a predictable pattern:
```
https://www.meetscoresonline.com/Reports.Meet.aspx?mt={meetId}&sess={session}&lvl={level}&div={division}&tax=1
```

Parameters:
- `mt` = meetId (numeric, from `data-meetid`)
- `sess` = session number (1, 2, 3...)
- `lvl` = level code (XB, XS, XG, 4, 8, etc.)
- `div` = division name (URL-encoded, e.g., `Ch%206-8`, `Junior%20A`)
- `tax` = 1 (always include)

To get all available session/level/division combos, navigate to the meet's event page first and extract them from the Report Builder checkboxes or from the page's filter dropdowns.

### Getting Available Combos
Navigate to the meet event page (e.g., `/2026-GA-Culprit-Cup`) and extract the checkbox labels:
```javascript
() => {
  const checkboxes = document.querySelectorAll('input[type="checkbox"]');
  return Array.from(checkboxes).map(cb => ({
    label: cb.parentElement?.textContent?.trim(),
    value: cb.value
  }));
}
```

Or use the Interactive results page filter dropdowns (if they exist, the JSON API also works — skip PDFs).

## Method 2: Bulk PDF via Report Builder UI

### Step 1: Check all division boxes
```javascript
() => {
  const checkboxes = document.querySelectorAll('input[type="checkbox"]');
  let checked = 0;
  checkboxes.forEach(cb => { if (!cb.checked) { cb.click(); checked++; } });
  return { total: checkboxes.length, newlyChecked: checked };
}
```

### Step 2: Download the combined PDF
Click the "Generate PDF Report" button. Downloads to `C:\Users\goduk\Downloads\` with the meet name as filename.

### Step 3: Copy PDF to workspace
```bash
cp "/mnt/c/Users/goduk/Downloads/[MEET_NAME].pdf" /home/goduk/chp-meet-scores/data/[meet_slug]/
```

## PDF Parsing (PyMuPDF)

The Python PDF adapter uses PyMuPDF (`fitz`) to extract text with coordinates from each page.

### PDF Layout
Each page is one session+level+division combo. Columns identified by x-coordinate ranges:

| Column | X Range |
|--------|---------|
| Rank | 10-50 |
| Number | 50-85 |
| Name/Gym | 85-240 |
| Vault (score + place) | 240-290 |
| Bars (score + place) | 318-368 |
| Beam (score + place) | 395-445 |
| Floor (score + place) | 472-522 |
| AA (score + place) | 540-600 |

### Page Structure
- **Header** (y < 100): Meet name, host gym, address, date, Session, Level, Division
- **Column headers** (~y 130): Rank, Num, Name/Gym, Vault, Bars, Beam, Floor, AA
- **Data rows** (130 < y < 750): Athlete rows in y-clusters
- **Footer**: "Official Results Published By" + "Official Results Verified"

### Row Structure
Each athlete spans 2 y-clusters:
- **Row 1**: Rank, Num, Name, Vault score, Bars score, Beam score, Floor score, AA score
- **Row 2**: (empty), (empty), Gym, Vault place, Bars place, Beam place, Floor place, AA place

Places may include "T" suffix for ties (e.g., "7T", "2T", "1T").

### Automatic Handling
- Team Results pages (containing "Meet Results - Team") → skip
- Multi-line names (long names wrapping) → handled by y-cluster grouping
- Score validation: individual events 0-10, AA 0-40

## Data Equivalence
The PDF Report Builder and the JSON API contain **identical data**: same athletes, same scores, same places, same ties. Confirmed by side-by-side comparison. The PDF additionally includes:
- `Num` column (athlete competition number) — not in JSON
- `Rank` column (AA placement) — same as `AAPlace` in JSON
- Meet header with host gym address

## After Parsing
The adapter builds the SQLite database directly. Proceed to `data_quality` skill for validation.

## Troubleshooting
For unusual PDF layouts, shifted columns, or multi-line name issues, load `details/pdf_layout_calibration`.
