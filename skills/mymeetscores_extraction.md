# Skill: MyMeetScores Extraction

## Overview

MyMeetScores.com (`mymeetscores.com`) displays all scores for a meet on a single HTML page — no pagination, no API, just a big HTML table. Extraction is straightforward DOM scraping.

## Prerequisites

You need a `meetid` from the discovery step. Meet URLs look like:
```
https://www.mymeetscores.com/meet.pl?meetid=92680
```

## Step 1: Navigate to All Scores

Navigate Chrome to the meet page. The default view shows all scores already, sorted by name:
```
chrome_navigate: https://www.mymeetscores.com/meet.pl?meetid=92680
```

Wait 2 seconds for the page to load.

## Step 2: Extract All Scores

Use `chrome_save_to_file` to scrape the HTML table. The table has these columns:
- Rank, Name, Team, Session, Level, Division, Vault, Bars, Beam, Floor, AA

**CRITICAL**: Score cells may contain rank suffixes like "9.450 1" or "9.450 3T" (rank and tied-rank indicators). Strip everything after the score number.

```javascript
// Extract all athlete data from the scores table
JSON.stringify(
  Array.from(document.querySelectorAll('table tr')).slice(1).map(row => {
    const cells = Array.from(row.querySelectorAll('td'));
    if (cells.length < 10) return null;

    // Parse score: strip rank suffix (e.g. "9.450 1" → "9.450")
    const parseScore = (cell) => {
      const text = cell?.textContent?.trim() || '';
      const match = text.match(/^(\d+\.\d+)/);
      return match ? match[1] : null;
    };

    return {
      name: cells[1]?.textContent?.trim() || '',
      gym: cells[2]?.textContent?.trim() || '',
      session: cells[3]?.textContent?.trim() || '',
      level: cells[4]?.textContent?.trim() || '',
      division: cells[5]?.textContent?.trim() || '',
      vault: parseScore(cells[6]),
      bars: parseScore(cells[7]),
      beam: parseScore(cells[8]),
      floor: parseScore(cells[9]),
      aa: parseScore(cells[10]),
    };
  }).filter(Boolean)
)
```

Save with filename `mymeetscores_extract_{meetid}.json`.

## Step 3: Verify Extraction

Read the saved file and check:
- Total athlete count matches what the meet page shows
- Scores are numeric (not null for everyone)
- Session/level/division values look reasonable

## Step 4: Build Database

Use the `build_database` tool with `source: "generic"`, the extracted data file path, state, and meet name. The GenericAdapter handles this JSON format automatically.

## Notes

- All scores are on one page — no pagination to handle
- The table may be very large (1000+ rows) — `chrome_save_to_file` handles this
- Scores use 3 decimal places (e.g., 9.450)
- Sessions are numbered (01, 02, ... 14)
- Levels include standard (1-10) and Xcel (XG, XS, XB, XP, XD, XSA)
- Divisions follow standard patterns (Jr A, Sr B, Ch C, etc.)
- Some meets split across multiple meetids (e.g., Xcel and Levels as separate meets). Check if multiple meets need combining, like with MSO.
