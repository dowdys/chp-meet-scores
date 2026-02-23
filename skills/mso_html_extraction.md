# Skill: MeetScoresOnline HTML Table Extraction

## Overview
Some meets on MeetScoresOnline.com display results in a live HTML table (URL pattern `/R[meet_id]`). Data is scraped via JavaScript from the DOM, downloaded as TSV, then parsed into the database.

## Prerequisites
- Chrome with remote debugging connected via Chrome DevTools MCP
- Meet page loaded at URL like `meetscoresonline.com/R34472`

## Extraction Steps

### Step 1: Set filters to show all results
Select "ALL" for Session, Level, and Division dropdowns so the table shows every athlete.

### Step 2: Scrape table data via JavaScript
Run via `evaluate_script`:
```javascript
() => {
  const rows = document.querySelectorAll('tr');
  const data = [];
  rows.forEach(row => {
    const nameEl = row.querySelector('.td_1');
    const gymEl = row.querySelector('.td_2');
    const sessionEl = row.querySelector('.td_3');
    const levelEl = row.querySelector('.td_4');
    const divisionEl = row.querySelector('.td_5');
    if (!nameEl) return;

    let name = nameEl.textContent.trim();
    // Strip parenthetical event notations like "(V, Br, Bm)"
    name = name.replace(/\s*\([^)]*\)\s*$/, '');

    const gym = gymEl ? gymEl.textContent.trim() : '';
    const session = sessionEl ? sessionEl.textContent.trim() : '';
    const level = levelEl ? levelEl.textContent.trim() : '';
    const division = divisionEl ? divisionEl.textContent.trim() : '';

    // Extract scores from .event cells
    const events = row.querySelectorAll('.event');
    const scores = [];
    events.forEach(ev => {
      const baseScore = ev.getAttribute('data-score') || '0';
      const supEl = ev.querySelector('sup');
      const decimal = supEl ? supEl.textContent.trim() : '000';
      scores.push(baseScore + '.' + decimal);
    });

    data.push([name, gym, session, level, division, ...scores].join('\t'));
  });
  return data.join('\n');
}
```

**Score construction**: The HTML stores scores split across the `data-score` attribute (integer part) and a `<sup>` element (decimal part). Combine as: `data-score + "." + sup_text`. Example: `data-score="9"` + `<sup>450</sup>` = `9.450`.

### Step 3: Download as TSV
Create a blob download in the browser:
```javascript
() => {
  const header = "Name\tGym\tSession\tLevel\tDivision\tVault\tV_Rank\tBars\tB_Rank\tBeam\tBm_Rank\tFloor\tF_Rank\tAA\tAA_Rank";
  // Assuming window.__scrapedData holds the TSV rows from Step 2
  const blob = new Blob([header + '\n' + window.__scrapedData], {type: 'text/tab-separated-values'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'meet_data.tsv';
  a.click();
  return 'Download triggered';
}
```

### Step 4: Copy TSV to workspace and parse
```bash
cp "/mnt/c/Users/goduk/Downloads/meet_data.tsv" /home/goduk/chp-meet-scores/data/[meet_slug]/
```
Pass the TSV to the Python HTML adapter for database building.

## Key DOM Patterns
- `.td_1` = Name, `.td_2` = Gym, `.td_3` = Session, `.td_4` = Level, `.td_5` = Division
- `.event` cells contain score data (data-score attr + sup decimal)
- Names may have parenthetical event annotations — strip these before storing
