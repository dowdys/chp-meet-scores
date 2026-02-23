# Skill: MeetScoresOnline PDF Extraction

## Overview
Some meets on MeetScoresOnline.com provide results via a Report Builder that generates a combined PDF of all divisions. The PDF uses a coordinate-based table layout parsed by PyMuPDF.

## Prerequisites
- Chrome with remote debugging connected via Chrome DevTools MCP
- User has navigated to the meet page on meetscoresonline.com
- The page shows a "Report Builder" section with checkboxes per division

## Extraction Steps

### Step 1: Check all division boxes
Run via `evaluate_script`:
```javascript
() => {
  const checkboxes = document.querySelectorAll('input[type="checkbox"]');
  let checked = 0;
  checkboxes.forEach(cb => { if (!cb.checked) { cb.click(); checked++; } });
  return { total: checkboxes.length, newlyChecked: checked };
}
```
This checks both Individual Results and Team Results boxes. A dropdown appears showing all selected sheets.

### Step 2: Download the PDF
Take a snapshot to locate the "Generate PDF Report" button, then click it. The PDF downloads to `C:\Users\goduk\Downloads\` with the meet name as filename.

### Step 3: Copy PDF to workspace
```bash
cp "/mnt/c/Users/goduk/Downloads/[MEET_NAME].pdf" /home/goduk/chp-meet-scores/data/[meet_slug]/
```

### Step 4: Parse the PDF
Run the Python PDF adapter. It uses PyMuPDF (`fitz`) to extract text with coordinates from each page.

**PDF layout**: Each page is a table with columns identified by x-coordinate ranges:
| Column | X Range |
|--------|---------|
| Rank | 10-50 |
| Number | 50-85 |
| Name/Gym | 85-240 |
| Vault | 240-290 |
| Bars | 318-368 |
| Beam | 395-445 |
| Floor | 472-522 |
| AA | 540-600 |

**Page structure**:
- Header area (y < 100): Contains Session, Level, Division text
- Data area (130 < y < 750): Athlete rows grouped in y-clusters
- Each athlete spans 2-3 y-clusters: name+scores row, rank+num row (close y), gym+event-ranks row

**Automatic handling**:
- Team Results pages (containing "Meet Results - Team") are skipped
- Multi-line names (long names wrapping) are handled by the y-cluster grouping
- Scores validated as 5.0-40.0 range

## After Parsing
The adapter builds the SQLite database directly. Proceed to `data_quality` skill for validation.

## Troubleshooting
For unusual PDF layouts, shifted columns, or multi-line name issues, load `details/pdf_layout_calibration`.
