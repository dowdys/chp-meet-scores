# Skill: General Scraping Strategy

## Overview
When a meet's results are on an unknown website (not MeetScoresOnline or ScoreCat), use this systematic approach to extract score data. Try the four approaches in order — each is progressively more manual.

## Approach 1: Network Interception (try first)
Monitor XHR/Fetch requests for API calls returning JSON score data. This is the fastest path when the site uses a REST or GraphQL API.

**When to use**: Site loads data dynamically (scores appear after page load, content changes on filter/pagination).

Load `details/scraping_network` for step-by-step instructions.

## Approach 2: DOM Scraping
Inspect the HTML for tables or structured data elements. Extract via querySelectorAll.

**When to use**: Site renders scores in visible HTML elements (tables, structured divs). No dynamic loading or you've already identified the final DOM state.

Load `details/scraping_dom` for step-by-step instructions.

## Approach 3: JS SDK Piggyback
Detect if the page has loaded a backend SDK (Firebase, Supabase, AWS Amplify) and query the backend directly through the existing initialized client.

**When to use**: Site is a SPA with a canvas/WebGL renderer (like ScoreCat), or network requests are encrypted/opaque, but you can find an initialized SDK in the window scope.

Load `details/scraping_sdk` for step-by-step instructions.

## Approach 4: Document Download
Find download buttons/links for PDF, CSV, or Excel files containing the scores.

**When to use**: Site offers downloadable reports. This is the simplest path when available.

Load `details/scraping_download` for step-by-step instructions.

## Decision Flow
1. Open Chrome DevTools Network tab → navigate to the results page → look at XHR/Fetch requests
   - If you see JSON responses with score-like data → **Approach 1**
   - If no useful network requests → continue
2. Inspect the DOM with `document.querySelectorAll('table')` or look for structured elements
   - If tables or structured data exist → **Approach 2**
   - If page is canvas-rendered or no useful DOM → continue
3. Check for loaded SDKs: `window.firebase_core`, `window.firebase_firestore`, `window.supabase`, etc.
   - If SDK found → **Approach 3**
4. Look for download buttons/links on the page
   - If download available → **Approach 4**
5. If none work → ask the user for guidance or whether they can provide the data in another format

## After Successful Extraction
When you successfully extract data from a new source:
1. Save the extracted data to the meet's data directory
2. Process through the appropriate Python adapter (or write a new one if needed)
3. Document the extraction technique in a draft skill file at `skills/drafts/[source_name]_extraction.md` so it can be reused
