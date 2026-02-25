# MeetScoresOnline (MSO) - Full Schema & Access Documentation

Last updated: 2026-02-24

## Architecture Overview

MeetScoresOnline (meetscoresonline.com) is a traditional ASP.NET server-rendered website with AJAX JSON endpoints. Standard HTML DOM scraping works. Results are also available via a JSON API (no auth required).

```
User searches for meet  -->  Results.All.YYYY-YYYY page (all meets, client-side filter)
                               |
                               v
                          Meet found: meetId from data-meetid attribute
                               |
                               v
JSON API (headless)      -->  POST Ajax.ProjectsJson.msoMeet.aspx
                               |   body: p_meetid=XXXXX&query_name=lookup_scores
                               v
                          Full athlete data (names, scores, ranks, levels, divisions)
```

## Meet Discovery: Results.All Page

**This is the primary way to find meets on MSO. No API needed — parse the HTML.**

### Season Archive URLs

- Current season: `https://www.meetscoresonline.com/Results.All` (redirects to current season)
- Specific season: `https://www.meetscoresonline.com/Results.All.2024-2025`
- **Season crossover**: May/June boundary. Meets before ~June belong to the prior season.
- Seasons go back to 2000-2001.

### Page Structure

The page contains ALL meets for the season (~1,778 meets for 2024-2025). Each meet is a `div.meet-container` with data attributes:

```html
<div class="meet-container clear status-3"
     data-meetid="34582"
     data-state="al"
     data-filter-by="2025 alabama state/district championship talladega al  wom">
  <h3><a href="/R34582">2025 Alabama State/District Championship</a></h3>
  <div class="meet-status">Meet Complete</div>
  <div class="meet-dates">Apr 12, 2025</div>
  <div class="meet-city">Talladega, AL</div>
  <div class="meet-props"><span> MEN </span><span>WOM</span></div>
</div>
```

### Key Attributes

| Attribute | Description |
|-----------|-------------|
| `data-meetid` | Numeric meet ID (used for JSON API and `/R####` URLs) |
| `data-state` | 2-letter state code, lowercase (e.g., `"al"`, `"tx"`, `"ny"`) |
| `data-filter-by` | Lowercase searchable text: meet name + city + state + gender |

### Filter Behavior

- The "Filter Meets" text input is **purely client-side JavaScript** — no AJAX calls
- It matches against the `data-filter-by` attribute
- Typing "alabama" filters to all Alabama meets
- No network request made during filtering

### Headless Discovery (no browser needed)

```python
import re, urllib.request

# 1. Determine season (before June = use prior year pair)
season = '2024-2025'
url = f'https://www.meetscoresonline.com/Results.All.{season}'

# 2. Fetch page HTML
with urllib.request.urlopen(url) as resp:
    html = resp.read().decode('utf-8')

# 3. Parse meet containers
pattern = r'data-meetid="(\d+)"\s+data-state="([^"]+)"\s+data-filter-by="([^"]+)"'
meets = re.findall(pattern, html)
# meets = [(meetId, state, filterText), ...]

# 4. Filter by state or keyword
iowa_meets = [(mid, st, ft) for mid, st, ft in meets if st == 'ia']
state_champs = [(mid, st, ft) for mid, st, ft in meets if 'state' in ft and 'championship' in ft]
```

### Alternative URLs

| URL Pattern | Purpose |
|-------------|---------|
| `/Results` | Active/upcoming + ~860 recent meets |
| `/Results.All` | Current season archive |
| `/Results.All.YYYY-YYYY` | Specific season archive |
| `/R{meetId}` | Direct results page (numeric ID) |
| `/Results/{meetId}` | Same as above (alternate URL) |
| `/YYYY-ST-Meet-Slug` | Event/landing page (slug-based, from Calendar) |
| `/Event/{eventId}` | Event details page |
| `/Calendar/ST` | State calendar |
| `/Calendar/M-YYYY/ST` | Month+state calendar |

### Two IDs Per Meet

MSO has two numeric IDs:
- **meetId** (e.g., 34582): Used for score queries and `/R####` URLs
- **eventId** (e.g., 32044): Used for meet details/extended info

Both are embedded in the page HTML when you load any meet URL. The `meetId` is what you need for data extraction. It comes directly from the `data-meetid` attribute on the Results.All page.

## Score Data: JSON API

**Primary extraction method. Works headlessly — no browser, no cookies, no auth.**

### Endpoint

```
POST https://www.meetscoresonline.com/Ajax.ProjectsJson.msoMeet.aspx?_cpn=999999
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
```

### Queries

#### lookup_scores — Get All Athletes

```
p_meetid=34582&query_name=lookup_scores
```

Omit `p_session` to get ALL athletes across all sessions in one call.

Optional filters: `p_session`, `p_level`, `p_division`, `p_gym`, `p_gymnastname`

#### lookup_clubs — Get Gym List

```
p_meetid=34582&query_name=lookup_clubs
```

Returns all gyms with official name, short name, club number, and athlete count.

### Response Format

```json
{
  "results": [{
    "result": {
      "row": [
        {
          "scoresid": "47467723",
          "meetid": "34330",
          "Season": "2024-2025",
          "MeetName": "2025 MRGVC USAG",
          "first_name": "Ti&#108;ly",
          "last_name": "Le&#119;is",
          "fullname": "Tilly&#32;Lewis",
          "gym": "Sapphire Gymnastics",
          "sess": "1",
          "level": "XS",
          "div": "Junior A",
          "EventType": "ARTW",
          "EventScore1": "9.200000",
          "EventScore2": "",
          "EventScore3": "",
          "EventScore4": "",
          "AAScore": "9.200000",
          "EventPlace1": "1",
          "EventPlace2": "",
          "EventPlace3": "",
          "EventPlace4": "",
          "AAPlace": "1"
        }
      ]
    }
  }]
}
```

### JSON API Field Schema

| Field | Type | Description |
|-------|------|-------------|
| scoresid | string | Score record ID |
| meetid | string | Numeric meet ID |
| Season | string | `"2024-2025"` |
| MeetName | string | Meet display name |
| gymnastid | string | Athlete numeric ID |
| first_name | string | **HTML-encoded** first name |
| last_name | string | **HTML-encoded** last name |
| fullname | string | **HTML-encoded** full name |
| gym | string | Gym/club name |
| clubnum | string | Club USAG number |
| sess | string | Session number/code |
| level | string | Level (e.g., `"XS"`, `"4"`, `"8"`, `"XG"`) |
| div | string | Division (e.g., `"Junior A"`, `"Senior"`, `"10B"`, `"All"`) |
| EventType | string | `"ARTW"` (Women) or `"ARTM"` (Men) |
| EventScore1 | string | Vault score (e.g., `"9.200000"`) or empty |
| EventScore2 | string | Bars score (Women) / Pommel Horse (Men) |
| EventScore3 | string | Beam score (Women) / Rings (Men) |
| EventScore4 | string | Floor score (Women) / Vault (Men) |
| EventScore5 | string | — (Women) / Parallel Bars (Men) |
| EventScore6 | string | — (Women) / High Bar (Men) |
| AAScore | string | All-Around score |
| EventPlace1-6 | string | Place/rank per event (may include `"T"` for ties, e.g., `"2T"`) |
| AAPlace | string | All-Around place |
| FigBScore1-6 | string | Execution scores (optional meets) |
| FigStartVal1-6 | string | Difficulty/start values (optional meets) |
| FigND1-6 | string | Neutral deductions (optional meets) |
| TeamResult | string | `"N"` for individual, `"Y"` for team |

### WAG Event Mapping (EventType: ARTW)

| Event# | Apparatus | Short |
|--------|-----------|-------|
| EventScore1 | Vault | VT |
| EventScore2 | Bars | UB |
| EventScore3 | Beam | BB |
| EventScore4 | Floor | FX |
| AAScore | All-Around | AA |

### Data Quirks

- **HTML-encoded names**: `"Ti&#108;ly"` = "Tilly". Decode with `html.unescape()` in Python or equivalent in JS.
- **Decimal scores**: Stored as `"9.250000"` (6 decimal places). Parse to float.
- **Empty strings**: Empty score = athlete did not compete in that event.
- **Tie indicator**: Place strings may end with `"T"` (e.g., `"2T"`, `"35T"`).
- **Xcel levels**: XS (Silver), XB (Bronze), XG (Gold), XD (Diamond), XP (Platinum).
- **Not all meets have this API**: Some meets only have Report Builder (PDF) or rotation-view results. If the JSON API returns 0 rows, fall back to HTML scraping.

### Example: Python (headless, no browser)

```python
import json, html, urllib.request

# Fetch all athletes for a meet
url = 'https://www.meetscoresonline.com/Ajax.ProjectsJson.msoMeet.aspx?_cpn=999999'
data = 'p_meetid=34582&query_name=lookup_scores'
req = urllib.request.Request(url, data=data.encode(), headers={
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
})
with urllib.request.urlopen(req) as resp:
    result = json.loads(resp.read().decode('utf-8'))

rows = result['results'][0]['result']['row']
for row in rows:
    name = html.unescape(row['fullname'])
    vault = float(row['EventScore1']) if row['EventScore1'] else None
    # ...
```

## Score Data: HTML Table (Fallback)

**Use when JSON API returns empty or when navigating via browser.**

### Table Structure

Navigate to `/R{meetId}` or `/Results/{meetId}`. The page has filter controls and a score table.

#### Filter Controls

| Control | ID | Options Example |
|---------|----|-----------------|
| Results type | — | Individual, Team |
| Session | `session_dd` | Combined, 1, 2, 3... |
| Level | `level_dd` | Combined, 2, 3, XB, XS... |
| Division | `division_dd` | Combined, All, Junior, Senior... |

There is also a `levels_all_dd` select that shows hierarchical level+division combos with counts:
```
"Level 2 (3)", "All [Level 2]", "Level XS (44)", "Junior A [Level XS]", ...
```

#### Table Cell Classes

| Class | Content |
|-------|---------|
| `.td_1` | Athlete name (in a `.names` div) |
| `.td_2` | Gym/team name (in a `.names` div) |
| `.td_3` | Session number |
| `.td_4` | Level |
| `.td_5` | Division |
| `.event.event-1` | Vault score cell |
| `.event.event-2` | Bars score cell |
| `.event.event-3` | Beam score cell |
| `.event.event-4` | Floor score cell |
| `.event.event-AA` | All-Around score cell |

#### Score Cell HTML

```html
<td class="event event-1 medals place-1" data-field="eventscore1" data-score="9">
  <span class="small place">1</span>
  <sup>200</sup>
  <span class="score">9</span>
</td>
```

- **Score**: `data-score` attribute (integer) + `"."` + `<sup>` text (decimal) = `9.200`
- **Place**: `<span class="small place">` text = `1`
- **data-field**: `eventscore1`-`eventscore4` for individual events, `aascore` for AA
- **CSS class indicators**: `place-1`, `place-2`, `medals` (has a placement), `AAWinner`, `AASilver` (row classes)

#### Empty Scores

When an athlete didn't compete in an event, the cell has no innerHTML and `data-score=""`.

### HTML Extraction JavaScript

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
        score: base && sup ? parseFloat(base + '.' + sup) : null,
        place: place
      });
    });

    data.push({ name, gym, session, level, division, scores });
  });
  return JSON.stringify(data);
}
```

## Extraction Strategy (Recommended)

### Priority 1: JSON API (headless, fast)

```
1. Determine season from meet date (May/June crossover)
2. Headless fetch Results.All.YYYY-YYYY page
3. Parse data-meetid + data-filter-by from HTML
4. Match user's search against filter-by text
5. POST to Ajax.ProjectsJson.msoMeet.aspx with meetId
6. Decode HTML entities in names
7. Process scores
```

### Priority 2: HTML Table (browser, fallback)

```
1. Navigate to /R{meetId} in Chrome
2. Set Session/Level/Division filters to show all data
3. Run extraction JavaScript
4. Parse scores from DOM
```

### Priority 3: Report Builder (browser, login required)

Some meets only have Report Builder format with PDF checkboxes. These require a free MSO account login. Load `mso_pdf_extraction` skill for this approach.

## Security & Rate Limits

- JSON API requires no authentication (no cookies, no session, no API key)
- HTML pages are publicly accessible
- Report Builder requires free account login
- No known rate limits on the JSON API
- The `_cpn=999999` query parameter appears to be a cache-buster, not auth
