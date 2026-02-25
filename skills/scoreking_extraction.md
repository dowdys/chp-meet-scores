# Skill: ScoreKing Extraction

## Overview
ScoreKing (scoreking.com) is a gymnastics scoring platform used primarily in southeastern US states (NC, SC, etc.). It provides meet results via HTML tables behind a form-based interface.

## CRITICAL: http_fetch Does NOT Work
ScoreKing requires browser-based form submission. Do NOT waste iterations trying `http_fetch` — it will fail every time. Use Chrome form submission only.

## Discovery
ScoreKing meets are found via web search (not Algolia or MSO). Look for links to `scoreking.com` in search results. Common URL pattern:
```
https://scoreking.com/ViewScores.php
```

## Extraction Steps

### Step 1: Navigate to ScoreKing
```
chrome_navigate: https://scoreking.com
```

### Step 2: Find Available Meets
The homepage has dropdown `<select>` elements for choosing a meet. Inspect them:
```javascript
// Find all select elements and their options
JSON.stringify(
  Array.from(document.querySelectorAll('select')).map(sel => ({
    name: sel.name,
    options: Array.from(sel.options).map(o => ({ value: o.value, text: o.text }))
  }))
)
```

The select name follows the pattern `meetfile{YEAR}` (e.g. `meetfile2025`). Option values are CSV filenames.

### Step 3: Submit the Form
Select the desired meet option and submit the form via Chrome:
```javascript
// Set the select value and submit
document.querySelector('select[name="meetfile2025"]').value = 'filename.csv';
document.querySelector('form').submit();
```

Wait 2-3 seconds for the page to load, then extract.

### Step 4: Extract Data
ScoreKing renders results as HTML tables. Extract with:
```javascript
// Extract all athlete rows from ScoreKing results table
JSON.stringify(
  Array.from(document.querySelectorAll('table tr')).slice(1).map(row => {
    const cells = Array.from(row.querySelectorAll('td'));
    // Column order varies by meet — inspect the header row first
    return cells.map(c => c.textContent.trim());
  })
)
```

**Always inspect the header row first** to determine column order. Common columns: Name, Gym, Level, Division, Session, VT, UB, BB, FX, AA.

### Step 5: Save to File
Use `chrome_save_to_file` to save the extracted JSON. Build a clean JSON array with standardized column names before saving.

## Encoding Warning
ScoreKing HTML contains non-ASCII characters (accented names, special characters). Always:
- Save files with UTF-8 encoding
- When processing in Python `run_script`, open files with `encoding='utf-8'`
- Use `ensure_ascii=True` when writing JSON to avoid encoding issues downstream

## Division Names
ScoreKing uses these division abbreviations:
- `Ch A`, `Ch B`, `Ch C` (Child A/B/C)
- `Jr A`, `Jr B` (Junior A/B)
- `Sr A`, `Sr B` (Senior A/B)

**These do NOT match MSO divisions** (`CHA`, `JRA`, `SRA`). If combining with MSO data, normalize divisions in the JSON BEFORE building the database. See the `database_building` skill.

## Multiple Meets
A single ScoreKing page may have multiple meets available (e.g. separate meets for compulsory levels, optional levels, and Xcel). Each is a different option in the dropdown. Extract each one separately, then combine into a single JSON file for the database build.
