# ScoreCat Platform - Full Schema & Access Documentation

Last updated: 2026-02-24

## Architecture Overview

ScoreCat (results.scorecatonline.com) is a Flutter/Dart web app that renders to `<canvas>`. Standard DOM scraping does NOT work. Data is stored in Firebase Firestore. Meet search uses **Algolia** (separate from Firestore).

```
User types search  -->  Algolia API (public, no browser needed)
                          |
                          v
                     Returns meetId + metadata
                          |
                          v
Navigate to ScoreCat -->  Firebase SDK loads in browser
                          |
                          v
Query ff_scores      -->  Athlete data by meetId
```

## Meet Discovery: Algolia Search API

**This is the fastest way to find meets on ScoreCat. No browser needed.**

- **App ID**: `2R102D471D`
- **API Key**: `f6c6022306eb2dace46c6490e7ae9984` (public search-only key)
- **Index**: `ff_meets`
- **Endpoint**: `POST https://2r102d471d.algolia.net/1/indexes/ff_meets/query`
- **CORS**: `access-control-allow-origin: *` (callable from anywhere)

### Request Format

```json
{
  "query": "Iowa",
  "facetFilters": [],
  "optionalFilters": [],
  "numericFilters": [],
  "tagFilters": []
}
```

Headers required:
```
x-algolia-application-id: 2R102D471D
x-algolia-api-key: f6c6022306eb2dace46c6490e7ae9984
Content-Type: application/json; charset=utf-8
```

### Response Format

Returns `hits` array. Each hit:
```json
{
  "path": "ff_meets/VQS0J5FI",
  "name": "2025 Iowa Dev State Championships",
  "director": "Windee Weiss",
  "program": "Women",
  "state": "IA",
  "hostGym": "Ruby Gymnastics Academy",
  "startDate": 1742644800000,
  "endDate": 1742731200000,
  "meet_id": "VQS0J5FI",
  "league": "USAG",
  "lastmodified": 1750008035116,
  "objectID": "VQS0J5FI"
}
```

### Algolia Hit Schema

| Field | Type | Description |
|-------|------|-------------|
| path | string | Firestore document path (`ff_meets/{meetId}`) |
| name | string | Meet display name |
| director | string | Meet director name |
| program | string | `"Women"` or `"Men"` |
| state | string | 2-letter US state code (e.g. `"IA"`, `"KY"`) or `"INT"` for international |
| hostGym | string | Host gym name |
| startDate | number | Epoch milliseconds |
| endDate | number | Epoch milliseconds |
| meet_id | string | Firestore document ID (same as objectID) |
| league | string | `"USAG"` typically |
| lastmodified | number | Epoch milliseconds |
| objectID | string | Algolia object ID = Firestore doc ID |
| compSeason | string | Sometimes present, e.g. `"2024-2025"` |

### Search Behavior

- Algolia searches across ALL states, ALL seasons
- Matches on: name, state, hostGym, meet_id, path
- Case-insensitive, partial matching (e.g. "Iowa" matches "Poway" too)
- No authentication beyond the public API key
- The search bar in the ScoreCat UI triggers one Algolia request per keystroke

### Example: Node.js (no browser needed)

```javascript
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

## Firestore Collections

### ff_meets (Meet Catalog)

- **Firebase Project**: `project-balance-66b89`
- **Query pattern**: `state == "XX" AND compSeason == "YYYY-YYYY"`, ordered by `startDate DESC`
- **IMPORTANT**: Firestore queries on ff_meets only return meets for ONE state+season at a time. Use Algolia for cross-state search.

#### ff_meets Document Schema

| Field | Type | Description |
|-------|------|-------------|
| name | string | Meet display name |
| meetId / meet_id | string | Document ID |
| state | string | 2-letter abbreviation (`"KY"`, `"IA"`, etc.) |
| compSeason | string | `"2024-2025"` or `"2025-2026"` |
| league | string | `"USAG"` |
| program | string | `"Women"` or `"Men"` |
| director | string | Meet director |
| hostGym | string | Host gym name |
| city | string | City |
| location | string | Venue name |
| address1, address2 | string | Street address |
| zip | string | Zip code |
| phone, fax | string | Contact info |
| startDate | Timestamp | Firestore timestamp |
| endDate | Timestamp | Firestore timestamp |
| timeStamp | Timestamp | Creation time |
| updatedAt | Timestamp | Last update |
| sanctionId | string | USAG sanction number |
| sessions | array | Session list |
| sessionSchedule | array | Schedule info |
| gymnasts | array | Gymnast IDs (up to ~40 per meet doc) |
| teamSessions | array | Team session info |
| rotationTypes | array | Rotation configuration |
| events2 | array | Event configuration |
| meetLogo | string | Logo thumbnail URL (Firebase Storage) |
| meetLogoLarge | string | Full-size logo URL |
| meetLogoStoragePath | string | Storage path for logo |
| meetLogoLargeStoragePath | string | Storage path for large logo |
| statusText | string | `"In progress"`, `"Completed"`, etc. |
| uploadStatus | string | Upload status |
| approval | string | Approval status |
| isUmbrella | boolean | Part of umbrella meet |
| umbrellaGroupId | string | Umbrella group ID |
| international | boolean | International meet |
| useAgeDiv | boolean | Uses age divisions |
| figMode | boolean | FIG scoring mode |
| bot | boolean | Unknown |
| comp1-comp4 | boolean | Competition flags |

### ff_scores (Athlete Scores)

**This is the main data collection. Contains one document per athlete per meet.**

#### Query Pattern
```javascript
ff.query(
  ff.collection(db, 'ff_scores'),
  ff.where('meetId', '==', 'VQS0J5FI')  // Use meetId from Algolia
)
```

#### Security Rules
- Queries WITHOUT a `where` clause return empty (security rule requires filter)
- Query by `meetId` works
- Query by `meetName` works but meetName must be exact (case-sensitive)

#### ff_scores Document Schema - Common Fields

| Field | Type | Description |
|-------|------|-------------|
| meetId | string | Meet document ID (matches Algolia `meet_id`) |
| meetName | string | Meet display name |
| firstName | string | Athlete first name |
| lastName | string | Athlete last name |
| fullName | string | Full name (lowercase) |
| clubName | string | Gym/club name |
| clubNum | string | Club number |
| level | string | **Prefixed**: `"Level: 3"`, `"Level: XB"`, etc. |
| division | string | **Prefixed**: `"Division: Jr C"`, `"Division: Child B"` |
| description | string | **Prefixed**: `"Session: 6"`, `"Session: P7"` |
| compSeason | string | `"2024-2025"` |
| state | string | 2-letter state code |
| league | string | `"USAG"` |
| gender | string | `"F"` or `"M"` |
| region | string | `"Region 4 WAG"`, `"Region 2 MAG"` |
| country | string | `"USA"` |
| hometown | string | Usually empty |
| athleteId | string | Athlete ID |
| usagId | string | USAG member ID |
| scoreCatId | string | ScoreCat internal ID (Firestore doc ID) |
| compNum | string | Competition number |
| sessionId | string | UUID for the session |
| previousSessions | array | Previous session IDs |
| dob | Timestamp | Date of birth |
| startDate | Timestamp | Meet start date |

#### ff_scores - WAG Event Fields (Women's Artistic Gymnastics)

4 events + All-Around:

| Event | Score | Rank | Place | JudgeScores | CombinedScore | CombinedScoreString | ScoreString |
|-------|-------|------|-------|-------------|---------------|---------------------|-------------|
| Vault | event1Score | event1Rank | event1Place | event1JudgeScores | event1CombinedScore | event1CombinedScoreString | event1ScoreString |
| Bars | event2Score | event2Rank | event2Place | event2JudgeScores | event2CombinedScore | event2CombinedScoreString | event2ScoreString |
| Beam | event3Score | event3Rank | event3Place | event3JudgeScores | event3CombinedScore | event3CombinedScoreString | event3ScoreString |
| Floor | event4Score | event4Rank | event4Place | event4JudgeScores | event4CombinedScore | event4CombinedScoreString | event4ScoreString |
| AA | event7Score | event7Rank | event7Place | - | event7CombinedScore | event7CombinedScoreString | event7ScoreString |

- **Score**: number (e.g. `9.775`)
- **Rank**: number (e.g. `1`)
- **Place**: string, may include ties (e.g. `"1"`, `"2T"`)
- **JudgeScores**: array of `{id, att, score}` objects
- **CombinedScore**: null for most meets (used for combined/multi-vault)
- **ScoreString**: string representation of score

#### ff_scores - MAG Event Fields (Men's Artistic Gymnastics)

6 events + All-Around. Same pattern as WAG plus additional fields per event:

| Event # | Apparatus |
|---------|-----------|
| event1 | Floor Exercise |
| event2 | Pommel Horse |
| event3 | Still Rings |
| event4 | Vault |
| event5 | Parallel Bars |
| event6 | High Bar |
| event7 | All-Around |

Additional per-event fields for MAG:
- `eventN_DBonus`: Difficulty bonus (number)
- `eventN_EBonus`: Execution bonus (number)
- `eventN_EScore`: Execution score (number)
- `eventN_StartVal`: Start value (number)
- `eventN_Nd`: Neutral deductions (number)

#### Data Quirks

- **Prefixed fields**: `level`, `division`, `description` have prefixes like `"Level: "`, `"Division: "`, `"Session: "`. Python adapter strips these.
- **Place strings**: May contain `"T"` suffix for ties (e.g. `"2T"`)
- **CombinedScore**: Usually `null`, `CombinedScoreString` is `"NaN"`
- **Zero/null scores**: Means athlete did not compete in that event
- **fullName**: Always lowercase
- **dob**: Firestore Timestamp with `seconds` and `nanoseconds`

## Iowa State Championships - Meet Structure

The "Iowa State Championships" is split into **3 separate meets** on ScoreCat:

| Meet Name | Meet ID | Athletes | Program | Date | Host |
|-----------|---------|----------|---------|------|------|
| 2025 Iowa Dev State Championships | VQS0J5FI | 413 | Women | Mar 22, 2025 | Ruby Gymnastics Academy |
| 2025 Iowa Xcel State | DAG1YV4U | 1,391 | Women | Mar 28, 2025 | Mid Iowa Gymnastics |
| 2025 Iowa Men's State | G7H887DR | 77 | Men | Mar 15, 2025 | Iowa Men's Gymnastics |

**Total: 1,881 athletes** (previous extraction got 1,804 = likely Dev 413 + Xcel 1,391)

The t-shirt customer likely wants Dev + Xcel combined (both are Women's). Men's State is separate.

## Meet Discovery Strategy for Our App

### Priority 1: Algolia Search (headless, fast, no browser)

```
1. POST to Algolia with meet name keywords
2. Filter results by state code and date range
3. Identify matching meet(s) by name
4. Extract meetId(s)
```

### Priority 2: Navigate to ScoreCat + Firebase Query

If Algolia is down or returns no results:
```
1. Navigate to https://results.scorecatonline.com/
2. Wait for Firebase SDK to load
3. Type search term in search box (or query Firestore directly)
4. Use meetId from ff_meets to query ff_scores
```

### Priority 3: Firestore Direct Query

If you know the exact meetName:
```javascript
ff.query(ff.collection(db, 'ff_scores'), ff.where('meetName', '==', 'EXACT NAME'))
```

## Extraction Flow (Recommended)

1. **Search**: Algolia API call with meet name -> get meetId(s)
2. **Navigate**: Open `https://results.scorecatonline.com/` in Chrome
3. **Wait**: For Firebase SDK (`window.firebase_core && window.firebase_firestore`)
4. **Query**: `ff_scores` by `meetId` using Firebase SDK
5. **Extract**: Map fields to our schema, save to file in chunks of 100
6. **Process**: Run Python adapter with `--source scorecat`

## Security & Rate Limits

- Algolia API key is a **public search-only key** (visible in client-side code)
- No authentication needed beyond the API key for search
- Firestore queries require the Firebase SDK loaded on a ScoreCat page (uses App Check for authorization)
- No known rate limits on the Algolia search endpoint
- Firestore queries work without user authentication (read-only access to ff_scores by meetId)
