---
title: "MSO Results.All has structured HTML with data-meetid attributes for programmatic search"
category: integration-issues
date: 2026-03-20
tags: [mso, meetscoresonline, api, scraping, search-meets]
components: [search-tools]
severity: p3
---

# MSO Results.All has structured HTML for programmatic meet search

## Discovery

MSO's website search (`/search?q=...`) is client-side JavaScript — `http_fetch` returns the homepage HTML with no search results. But `https://www.meetscoresonline.com/Results.All` returns a 1.3MB HTML page containing ALL meets with structured data attributes:

```html
<div class="meet-container clear status-3"
     data-meetid="34775"
     data-state="nv"
     data-filter-by="2026 nevada state championships henderson nv wom">
```

These attributes make it trivial to search programmatically:
- `data-meetid` → the numeric meet ID for `mso_extract`
- `data-state` → two-letter state code
- `data-filter-by` → searchable text containing meet name, city, state, and program (wom/men)

## Usage

The `search_meets` tool fetches this page and parses it with regex:
```
/data-meetid="(\d+)"\s+data-state="([^"]+)"\s+data-filter-by="([^"]+)"/g
```

Combined with the ScoreCat Algolia API, this provides comprehensive meet search across both data sources in a single tool call.

## Why This Matters

Previously, agents spent 10-20 iterations browsing MSO's website trying to find meet IDs. The `search_meets` tool reduces this to a single API call that returns structured results.
