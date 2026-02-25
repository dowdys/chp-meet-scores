# Skill: Meet Discovery

## Purpose
Find gymnastics meet results online given a meet name.

## CRITICAL: Budget & Efficiency
- You have limited iterations. Spend AT MOST 10 iterations total on discovery.
- **Search data sources DIRECTLY first** — do NOT start with web search.
- Priority order: ScoreCat (Algolia) → MSO (Results.All) → Web search (last resort).
- If multiple meets match (e.g., "Dev State" + "Xcel State"), use the `ask_user` tool with the matches as options so the user can pick. Never silently combine separate meets.

## Step 1: ScoreCat — Algolia Search (headless, fastest)

ScoreCat uses Algolia for meet search. It's a public API, no browser needed.

```javascript
// Node.js — no browser, no auth
const response = await fetch('https://2r102d471d.algolia.net/1/indexes/ff_meets/query', {
  method: 'POST',
  headers: {
    'x-algolia-application-id': '2R102D471D',
    'x-algolia-api-key': 'f6c6022306eb2dace46c6490e7ae9984',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ query: 'Iowa state 2025' })
});
const data = await response.json();
// data.hits = array of meet objects
```

Each hit returns: `meet_id`, `name`, `state`, `startDate`, `endDate`, `hostGym`, `program` (Women/Men), `league`.

- Searches ALL states and ALL seasons at once
- Case-insensitive, partial matching
- If found, extract `meet_id` and load `scorecat_extraction` skill
- See `skills/details/scorecat_schema.md` for full Algolia schema

**Important**: A user's "State Championships" may be split into multiple ScoreCat meets (e.g., "Dev State", "Xcel State", "Men's State"). These are SEPARATE meets — use the `ask_user` tool to present the options and let the user choose.

## Step 2: MSO — Results.All Page (headless or browser)

If ScoreCat didn't find the meet, try MeetScoresOnline.

### Determine the Season
- Season crossover is May/June. If the meet is before ~June, use prior-year season.
- Example: March 2025 meet → season `2024-2025`. October 2025 meet → season `2025-2026`.

### Browser Discovery (Chrome — the only reliable approach)

The MSO Results.All page is large HTML that truncates in headless fetches. Use Chrome with JS extraction:

1. Navigate Chrome to `https://www.meetscoresonline.com/Results.All.{season}`
2. Extract meets directly via JavaScript:

**CRITICAL: MSO uses LOWERCASE state abbreviations** in `data-state` (e.g. `'nc'`, not `'NC'`). Always use `.toLowerCase()` when filtering.

```javascript
// Use chrome_save_to_file or chrome_execute_js
JSON.stringify(
  Array.from(document.querySelectorAll('[data-meetid]')).map(el => ({
    meetId: el.getAttribute('data-meetid'),
    state: el.getAttribute('data-state'),
    filterBy: el.getAttribute('data-filter-by'),
    name: el.querySelector('.card-title, h5, a')?.textContent?.trim() || '',
  })).filter(m => m.state === 'nc')  // LOWERCASE state abbreviation!
)
```

3. Filter results by state abbreviation (LOWERCASE) and meet name keywords
4. Get the `meetId` from the matching entry

### If found on MSO

The meetId from `data-meetid` is what you need. Check if the JSON API has data:

```
POST https://www.meetscoresonline.com/Ajax.ProjectsJson.msoMeet.aspx?_cpn=999999
Body: p_meetid=XXXXX&query_name=lookup_scores
```

- If rows returned → load `mso_html_extraction` skill (which now covers both JSON API and HTML table approaches)
- If 0 rows → the meet may use Report Builder (PDF) format. Load `mso_pdf_extraction` skill.
- See `skills/details/mso_schema.md` for full API documentation

## Step 3: Web Search (last resort)

Only if both ScoreCat and MSO come up empty:

```
web_search: "2025 Alabama State Championships" gymnastics results scores
```

Look for links to known platforms or new sources. If found on an unknown site, load `general_scraping` skill.

## State Abbreviation Map
| State | Abbrev | State | Abbrev |
|-------|--------|-------|--------|
| Alabama | AL | Montana | MT |
| Alaska | AK | Nebraska | NE |
| Arizona | AZ | Nevada | NV |
| Arkansas | AR | New Hampshire | NH |
| California | CA | New Jersey | NJ |
| Colorado | CO | New Mexico | NM |
| Connecticut | CT | New York | NY |
| Delaware | DE | North Carolina | NC |
| Florida | FL | North Dakota | ND |
| Georgia | GA | Ohio | OH |
| Hawaii | HI | Oklahoma | OK |
| Idaho | ID | Oregon | OR |
| Illinois | IL | Pennsylvania | PA |
| Indiana | IN | Rhode Island | RI |
| Iowa | IA | South Carolina | SC |
| Kansas | KS | South Dakota | SD |
| Kentucky | KY | Tennessee | TN |
| Louisiana | LA | Texas | TX |
| Maine | ME | Utah | UT |
| Maryland | MD | Vermont | VT |
| Massachusetts | MA | Virginia | VA |
| Michigan | MI | Washington | WA |
| Minnesota | MN | West Virginia | WV |
| Mississippi | MS | Wisconsin | WI |
| Missouri | MO | Wyoming | WY |

## Identifying the Source
| Indicator | Source | Skill to Load |
|-----------|--------|---------------|
| Algolia returns hits with `meet_id` | ScoreCat | `scorecat_extraction` |
| MSO Results.All has `data-meetid` match | MSO (JSON API) | `mso_html_extraction` |
| MSO page with Report Builder checkboxes only | MSO (PDF) | `mso_pdf_extraction` |
| ScoreKing website | ScoreKing | `scoreking_extraction` |
| Other website (MyMeetScores, etc.) | Unknown | `general_scraping` |
