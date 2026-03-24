---
title: "MSO lookup_meet query requires p_eventid=1 or it returns 0 rows"
category: integration-issues
date: 2026-03-23
tags: [mso, meetscoresonline, api, lookup-meet, undocumented]
components: [search-tools, extraction-tools]
severity: p2
---

# MSO lookup_meet query requires p_eventid=1

## Problem

The MSO JSON API has an undocumented `lookup_meet` query that returns canonical meet metadata (name, dates, location, host, director, status). However, calling it with just `p_meetid` and `query_name=lookup_meet` returns 0 rows -- no error, just empty results.

## Root Cause

The `lookup_meet` query requires `p_eventid=1` in the POST body. Without it, the server returns a valid JSON response with an empty `row` array. This parameter is not documented anywhere on MSO's site, and the other commonly-used queries (`lookup_scores`, `lookup_clubs`) do not require it.

## Correct Usage

```
POST https://www.meetscoresonline.com/Ajax.ProjectsJson.msoMeet.aspx?_cpn=999999
Content-Type: application/x-www-form-urlencoded; charset=UTF-8

p_meetid=34508&p_eventid=1&query_name=lookup_meet
```

Returns: meet name, dates, location (city/state), host club, meet director, status (complete/upcoming), and event type.

## Broken Usage (returns 0 rows)

```
p_meetid=34508&query_name=lookup_meet
```

This returns `{"results":[{"result":{"row":[]}}]}` -- valid JSON, no error, but no data.

## Where This Is Used

- `src/main/tools/search-tools.ts` -- the `lookup_meet` tool executor
- `src/main/tools/extraction-tools.ts` -- `mso_extract` fetches canonical meet metadata after extraction

## Why This Isn't in the Schema Doc

`skills/details/mso_schema.md` documents `lookup_scores` and `lookup_clubs` but not `lookup_meet`. The `p_eventid` parameter is not mentioned anywhere in MSO's public interface. This was discovered through empirical testing -- the only way to know is to have tried it both ways.

## Related

- `skills/details/mso_schema.md` -- MSO API documentation (should be updated to include `lookup_meet`)
- `docs/solutions/integration-issues/mso-results-all-structured-html.md` -- MSO discovery via Results.All pages
