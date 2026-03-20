---
title: "MSO JSON API works without browser cookies — Chrome not needed for extraction"
category: integration-issues
date: 2026-03-20
tags: [mso, meetscoresonline, api, chrome, extraction, performance]
components: [extraction-tools]
severity: p2
---

# MSO JSON API works without browser cookies

## Problem

The `mso_extract` tool launched Chrome, navigated to meetscoresonline.com to establish same-origin cookies, then ran JavaScript inside Chrome to call the MSO JSON API. This meant every MSO extraction required a full Chrome browser session — slow to start, resource-heavy, and a common failure point (Chrome disconnects, execution context destroyed, etc.).

## Discovery

Tested calling the API directly from Node.js without any browser:

```python
url = "https://www.meetscoresonline.com/Ajax.ProjectsJson.msoMeet.aspx?_cpn=999999"
data = b"p_meetid=34775&query_name=lookup_scores"
headers = {"Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"}
# Direct HTTP call — no cookies, no browser
resp = urllib.request.urlopen(Request(url, data=data, headers=headers))
result = json.loads(resp.read())
# Returns 971 athlete rows — works perfectly
```

The API requires NO authentication, NO cookies, NO same-origin context. The Chrome-based approach was unnecessary overhead inherited from early development when we assumed the API needed browser cookies.

## Solution

Rewrote `mso_extract` in `extraction-tools.ts` to use Node.js `fetch()` directly:
- Removed `chromeController.ensureConnected()` and `chromeController.navigate()`
- Removed the entire Chrome JavaScript extraction script
- Replaced with direct `fetch()` calls with TypeScript type safety
- HTML entity decoding done in TypeScript (not via DOM textarea trick)
- Result: faster, more reliable, no Chrome dependency for MSO meets

Chrome is still needed for ScoreCat extraction (Firebase SDK requires browser context).

## Impact

- **Speed**: Extraction starts immediately instead of waiting for Chrome to launch + navigate
- **Reliability**: No more "Execution context destroyed" or Chrome disconnection errors during MSO extraction
- **Resource usage**: No Chrome process needed for MSO-only meets
- **Combined with `search_meets`**: Discovery + extraction for MSO meets can now happen entirely without Chrome
