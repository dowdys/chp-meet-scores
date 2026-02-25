# Skill: MeetScoresOnline Data Extraction

## Overview
Extract athlete scores from MeetScoresOnline.com. Two methods available — prefer the JSON API when it works.

## Prerequisites
- Meet discovered via `meet_discovery` skill
- Have the numeric `meetId` (from `data-meetid` attribute on Results.All page)

## Method 1: JSON API (Preferred — Headless, No Browser)

### Pre-extraction Validation

Before extracting all data, validate the API response format with a quick check using `http_fetch`:

```
POST https://www.meetscoresonline.com/Ajax.ProjectsJson.msoMeet.aspx?_cpn=999999
Body: p_meetid=${meetId}&query_name=lookup_scores
```

Since http_fetch auto-saves responses >5KB, check the saved file for:
- `paging.to` value (total row count)
- Field names in the first row (fullname, gym, sess, level, div, EventScore1-4, AAScore)
- 2-3 sample rows to confirm data format

If the response is empty or fields are unexpected, switch to Method 2 (HTML scraping).

### Fetch All Athletes via chrome_save_to_file

Use `chrome_save_to_file` to extract all data in one tool call. Navigate Chrome to any MSO page first (e.g., the meet results page), then run the extraction script:

```javascript
// Template for chrome_save_to_file script
(async () => {
  const meetId = YOUR_MEET_ID;
  const resp = await fetch('https://www.meetscoresonline.com/Ajax.ProjectsJson.msoMeet.aspx?_cpn=999999', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: 'p_meetid=' + meetId + '&query_name=lookup_scores'
  });
  const data = await resp.json();
  const rows = data.results[0].result.row;
  const ta = document.createElement('textarea');
  function cleanName(raw) {
    // Strip MSO event annotations: "IES V,Be,Fx", "V,Fl", "UB", etc.
    return raw.replace(/\s+(?:IES\s+)?(?:V|UB|Be|Fl|Fx|FX)(?:,(?:V|UB|Be|Fl|Fx|FX))*\s*$/, '').trim();
  }
  const allRows = rows.map(r => {
    ta.innerHTML = r.fullname;
    return {
      name: cleanName(ta.textContent),
      gym: r.gym, session: r.sess, level: r.level, division: r.div,
      vault: r.EventScore1, bars: r.EventScore2, beam: r.EventScore3, floor: r.EventScore4,
      aa: r.AAScore, vaultPlace: r.EventPlace1, barsPlace: r.EventPlace2,
      beamPlace: r.EventPlace3, floorPlace: r.EventPlace4, aaPlace: r.AAPlace,
      num: r.gymnastnumber
    };
  });
  return JSON.stringify(allRows);
})()
```

This replaces the old chunk-and-poll workflow with a single tool call.

Omit `p_session` to get ALL athletes across all sessions in one request.

### Decode Names

Names are HTML-entity encoded (anti-scraping). Decode them:
- Python: `html.unescape(row['fullname'])`
- JavaScript: create a textarea element and set innerHTML, read textContent

### Key Fields

| Field | Description |
|-------|-------------|
| `fullname` | HTML-encoded athlete name |
| `gym` | Gym/club name |
| `sess` | Session number |
| `level` | Level (e.g., `"XS"`, `"4"`, `"8"`) |
| `div` | Division (e.g., `"Junior A"`, `"All"`) |
| `EventScore1` | Vault (decimal string like `"9.200000"`, or empty) |
| `EventScore2` | Bars |
| `EventScore3` | Beam |
| `EventScore4` | Floor |
| `AAScore` | All-Around |
| `EventPlace1`-`4` | Places per event (may include `"T"` for ties) |
| `AAPlace` | AA placement |

### If JSON API Returns Empty

The meet may not have interactive results. Fall back to Method 2 (HTML scraping) or `mso_pdf_extraction` skill.

See `skills/details/mso_schema.md` for complete field reference.

## Method 2: HTML Table Scraping (Fallback — Needs Browser)

Use when JSON API returns no data. Requires Chrome connected via CDP.

### Step 1: Navigate to Results Page

Navigate to `https://www.meetscoresonline.com/R{meetId}`.

### Step 2: Set Filters

Change Session dropdown (`#session_dd`) to "Combined" and Level to "Combined" to show all athletes. Or iterate through sessions one at a time.

### Step 3: Extract Data via JavaScript

```javascript
() => {
  const rows = document.querySelectorAll('tr');
  const data = [];
  rows.forEach(row => {
    const nameEl = row.querySelector('.td_1');
    if (!nameEl) return;
    const name = nameEl.textContent.trim().replace(/\s*\([^)]*\)\s*$/, '');
    const gym = row.querySelector('.td_2')?.textContent?.trim() || '';
    const session = row.querySelector('.td_3')?.textContent?.trim() || '';
    const level = row.querySelector('.td_4')?.textContent?.trim() || '';
    const division = row.querySelector('.td_5')?.textContent?.trim() || '';

    const events = row.querySelectorAll('.event');
    const scores = [];
    events.forEach(ev => {
      const base = ev.getAttribute('data-score') || '';
      const sup = ev.querySelector('sup')?.textContent?.trim() || '';
      const place = ev.querySelector('.place')?.textContent?.trim() || '';
      scores.push({
        score: base && sup ? base + '.' + sup : '',
        place: place
      });
    });
    // scores[0]=Vault, [1]=Bars, [2]=Beam, [3]=Floor, [4]=AA
    data.push([name, gym, session, level, division, ...scores.map(s => s.score + '\t' + s.place)].join('\t'));
  });
  return data.join('\n');
}
```

**Score construction**: `data-score` (integer) + `"."` + `<sup>` text (decimal). Example: `data-score="9"` + `<sup>200</sup>` = `9.200`.

### Key DOM Patterns
- `.td_1` = Name, `.td_2` = Gym, `.td_3` = Session, `.td_4` = Level, `.td_5` = Division
- `.event` cells contain score data with `data-score` attribute + `<sup>` decimal
- `<span class="small place">` inside event cells = placement rank
- Names may have parenthetical event annotations — strip before storing
- Row classes: `AAWinner` = first place AA, `AASilver` = second place AA
