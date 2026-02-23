# Skill: Meet Discovery

## Purpose
Find gymnastics meet results online given a meet name and state.

## Primary Sources

### MeetScoresOnline.com (MSO)
- URL: `https://meetscoresonline.com`
- Search: Use the site's search or navigate directly to `meetscoresonline.com/[meet-name-slug]`
- **Two result formats exist**:
  - **Report Builder** (PDF): Page has checkboxes per division under "Report Builder". Load `mso_pdf_extraction` skill.
  - **HTML Table** (live results): URL pattern `/R[meet_id]` (e.g., `/R34472`). Page shows a filterable HTML table with `.td_1` through `.td_N` class cells. Load `mso_html_extraction` skill.
- How to tell which format: If the page has a "Report Builder" section with checkboxes, it's PDF format. If it has a results table with Session/Level/Division filter dropdowns, it's HTML format.

### ScoreCat
- URL: `https://results.scorecatonline.com`
- The page is a Flutter/Dart canvas app — visually renders to `<canvas>`, no scrapable DOM.
- Meet URLs look like: `results.scorecatonline.com/sessionsList?meetId=[MEET_ID]`
- If you see a canvas-rendered page with no HTML tables, it's ScoreCat. Load `scorecat_extraction` skill.

## Discovery Steps
1. Ask the user for the meet name and state (e.g., "2025 Alabama Compulsory State Meet")
2. Navigate to MeetScoresOnline.com and search for the meet name
3. If not found on MSO, navigate to results.scorecatonline.com and look for the meet
4. If not found on either known source, load `general_scraping` skill and ask the user for the URL

## Identifying the Source
| Indicator | Source | Skill to Load |
|-----------|--------|---------------|
| MSO page with "Report Builder" checkboxes | MSO PDF | `mso_pdf_extraction` |
| MSO page with HTML table, URL `/R####` | MSO HTML | `mso_html_extraction` |
| ScoreCat canvas app, URL has `scorecatonline.com` | ScoreCat | `scorecat_extraction` |
| Other website | Unknown | `general_scraping` |
