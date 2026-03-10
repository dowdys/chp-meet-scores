# Skill: Meet Discovery

## Purpose
Find gymnastics meet results online given a meet name.

## CRITICAL: Budget & Efficiency
- You have limited iterations. Spend AT MOST 10 iterations total on discovery.
- **Search data sources DIRECTLY first** — do NOT start with web search.
- Priority order: ScoreCat (Algolia) → MSO (Results.All) → MyMeetScores → Web search (last resort).
- If multiple meets match (e.g., "Dev State" + "Xcel State"), use the `ask_user` tool with the matches as options so the user can pick. Never silently combine separate meets.

## BEFORE YOU START: Establish Context

Before searching, determine the following. If the user's request is ambiguous, use `ask_user` to clarify:

1. **Today's date**: Use `run_script` to check: `import datetime; print(datetime.date.today())`. Do NOT assume you know the date — verify it. This prevents mistakes with "future" meets that have already happened.
2. **Approximate meet date**: If you're unsure when the meet took place, ask the user. They often know the month/year even if not the exact date. This helps filter search results.
3. **State**: Usually in the meet name, but confirm if ambiguous.
4. **Levels/programs**: The user may want only certain levels (e.g., "L3-5 and Xcel Bronze-Silver"). Note this for later verification.

## IMPORTANT: Avoid Redundant Searches

When a state championship is split across multiple sub-meets (e.g., "Dev State" + "Xcel State"), you will typically find ALL of them in a single Algolia search. Do NOT re-search ScoreCat for each sub-meet after the user selects them — you already have their `meet_id` values from the initial search results. Extract each selected meet directly using its `meet_id`.

Similarly, if one search finds a meet on ScoreCat, do NOT also search MSO or MyMeetScores for the same meet. Move directly to extraction.

**When ScoreCat returns no match for the requested year** (e.g., only returns a 2024 meet when you searched for 2025), do NOT repeat the Algolia search with query variations — the meet simply isn't on ScoreCat. Move immediately to MSO (Step 2). Algolia's fuzzy matching means if it didn't find a 2025 meet on the first try, rephrasing won't help.

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

### CRITICAL: Handling Multiple ScoreCat Results

When Algolia returns multiple hits:

1. **Convert ALL `startDate` timestamps to human-readable dates** using `run_script`:
   ```python
   import datetime
   ts = 1765540800000 / 1000
   dt = datetime.datetime.fromtimestamp(ts, tz=datetime.timezone.utc)
   print(f"{dt.strftime('%B %d, %Y')}")
   ```
2. **Never dismiss a meet as "future" without checking today's date first.**
3. **Group related meets** — state championships are almost always split into color-coded sessions (BLUE, RED, WHITE) or by level range. Same director + same dates = same championship.
4. **Present ALL plausible matches to the user** via `ask_user`. Include the date, director, host gym, and meet name for each. Let the user pick.

**Important**: A state championship is almost always split across multiple meets on every data source (e.g., "Dev State" for levels 1-5, "Levels 6-10 State", "Xcel State"). A complete championship should cover Levels 1-10 and Xcel Bronze/Silver/Gold/Platinum/Diamond/Sapphire (some states skip lower levels). Present ALL matching meets to the user via `ask_user` so they can select which ones to combine. Each selected meet gets extracted separately but feeds into the same database.

### After Extraction: Verify Levels

After `scorecat_extract` returns data, **immediately verify** that the levels match what the user requested. Use `run_script` to check levels in the extracted JSON:
```python
import json
with open('<extract_file>') as f:
    data = json.load(f)
from collections import Counter
levels = Counter(a.get('level', '') for a in data)
print("Levels found:", dict(levels))
```

If the levels don't match the user's request (e.g., user wanted L3-5 but you got L6-10), **stop and search for the correct meets** before building the database. Do NOT build a database from the wrong meets.

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

## Step 3: MyMeetScores (headless)

If ScoreCat and MSO came up empty, try MyMeetScores.com. Use `http_fetch` — no browser needed.

**Completed meets by state and year:**
```
https://www.mymeetscores.com/gym.pl?list=2&year=2025&state=MI
```
- `list=2` = completed meets
- `year=YYYY` = competition year
- `state=XX` = two-letter state abbreviation (UPPERCASE)

The page returns an HTML table with all completed meets for that state/year. Parse it to find matching meet names and extract the `meetid` from links like `/meet.pl?meetid=92680`.

**Important**: Check if the MyMeetScores meet actually has scores loaded. Navigate to the meet page and check — some meets are listed but have "We have not yet received scores from this meet." If that's the case, look for a link to where scores are posted (often links back to ScoreCat or MSO).

If found with scores, load `mymeetscores_extraction` skill. The meetid is what you need.

## Step 4: Web Search (last resort)

Only if ScoreCat, MSO, and MyMeetScores all come up empty:

```
web_search: "2025 Alabama State Championships" gymnastics results scores
```

Look for links to known platforms or new sources. If found on an unknown site, load `general_scraping` skill.

## Asking the User for Help

If after 2-3 search attempts you haven't found the meet, **use `ask_user`**:
```
"I'm having trouble finding the results for [meet name]. Could you help with any of the following?"
Options:
- "I have a direct URL to the results"
- "The meet was on [date] — try searching for that"
- "Try searching for [alternative name]"
- "Let me look it up and get back to you"
```

The user often has the meet URL bookmarked or knows exactly where to find it. Don't burn 10+ iterations searching blindly.

## Asking for Dates (All at Once)

When you need deadline dates for order forms, ask for ALL dates in a single `ask_user` call:

```
"I need the order form deadline dates. What are they?"
Options:
- "Postmark: [date], Online: [date], Ship: [date]"
- "I'll enter them — give me a moment"
- "Use placeholder dates for now"
```

Do NOT ask for dates one at a time across multiple ask_user calls.

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
| MyMeetScores gym.pl has matching meetid | MyMeetScores | `mymeetscores_extraction` |
| ScoreKing website | ScoreKing | `scoreking_extraction` |
| Other unknown website | Unknown | `general_scraping` |
