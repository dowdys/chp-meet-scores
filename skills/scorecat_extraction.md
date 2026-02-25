# Skill: ScoreCat / Firebase Data Extraction

## Overview
ScoreCat (results.scorecatonline.com) is a Flutter/Dart web app that renders everything to `<canvas>`. Standard DOM scraping does NOT work. Data is extracted by querying Firebase Firestore through the SDK that the Flutter app loads.

**Discovery uses Algolia (headless, no browser). Extraction uses Firebase (needs Chrome on ScoreCat page).**

## CRITICAL: Execution Context Issues
ScoreCat's Flutter app frequently reloads and destroys the JS execution context. If you get "Execution context was destroyed":
- Do NOT retry immediately — navigate to the page again using `chrome_navigate`
- Wait for the page to load fully (networkidle2 handles this)
- Then try your JS again — but only ONCE per navigation

## Step 1: Get the meetId from Algolia

Discovery should already have the `meet_id` from the Algolia search (see `meet_discovery` skill). If not:

```javascript
// Headless — no browser needed
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
// data.hits[0].meet_id = "VQS0J5FI"
```

## Step 2: Load Firebase SDK via Chrome

Navigate to ScoreCat in Chrome to get the Firebase SDK loaded:

```
chrome_navigate: https://results.scorecatonline.com/
```

Wait for Firebase SDK to initialize (5-10 seconds). The homepage is better than going directly to a results URL — it loads more reliably.

## Step 3: Extract All Athletes by meetId

Query `ff_scores` using the `meetId` from Algolia (more reliable than meetName):

```javascript
(async () => {
  // Wait for Firebase SDK
  for (let i = 0; i < 20; i++) {
    if (window.firebase_core && window.firebase_firestore) break;
    await new Promise(r => setTimeout(r, 500));
  }

  const fc = window.firebase_core;
  const ff = window.firebase_firestore;
  const app = fc.getApp();
  const db = ff.getFirestore(app);

  const q = ff.query(
    ff.collection(db, 'ff_scores'),
    ff.where('meetId', '==', 'VQS0J5FI')  // Use meetId from Algolia
  );

  const snap = await ff.getDocs(q);
  window.__allAthletes = snap.docs.map(d => {
    const data = d.data();
    return {
      firstName: data.firstName,
      lastName: data.lastName,
      clubName: data.clubName,
      level: data.level,
      division: data.division,
      session: data.description,
      vt: data.event1Score, ub: data.event2Score,
      bb: data.event3Score, fx: data.event4Score,
      aa: data.event7Score,
      vtPlace: data.event1Place, ubPlace: data.event2Place,
      bbPlace: data.event3Place, fxPlace: data.event4Place,
      aaPlace: data.event7Place,
      vtRank: data.event1Rank, ubRank: data.event2Rank,
      bbRank: data.event3Rank, fxRank: data.event4Rank,
      aaRank: data.event7Rank
    };
  });

  return JSON.stringify({count: window.__allAthletes.length});
})()
```

**Alternative**: You can also query by `meetName` if needed (must be exact, case-sensitive):
```javascript
ff.where('meetName', '==', '2025 Iowa Dev State Championships')
```

## Step 4: Retrieve Data in Chunks and Save to File

Retrieve in chunks of 100, save each to build a complete JSON array:

```javascript
JSON.stringify(window.__allAthletes.slice(0, 100))
```
```javascript
JSON.stringify(window.__allAthletes.slice(100, 200))
```

Continue until all athletes are retrieved. Concatenate all chunks and save to a file using `save_to_file`.

## Step 5: Process with Python

Run the Python adapter: `run_python --adapter scorecat --input athletes.json --meet-name "MEET NAME" --state "STATE"`

## WAG Event Mapping (Women's Artistic Gymnastics)

| Firestore Field | Event |
|----------------|-------|
| event1Score / event1Place / event1Rank | Vault |
| event2Score / event2Place / event2Rank | Bars |
| event3Score / event3Place / event3Rank | Beam |
| event4Score / event4Place / event4Rank | Floor |
| event7Score / event7Place / event7Rank | All-Around |

## Data Quirks
- **Prefixed fields**: `level="Level: 8"`, `division="Division: Jr A"`, `session/description="Session: 6"` — Python adapter strips these.
- **Zero scores**: 0 or null means did not compete. Exclude from winners.
- **Place strings**: May contain `"T"` for ties (e.g., `"2T"`).
- **Rank-based winners**: Use `rank=1` when available, fall back to max-score.
- **fullName field**: Always lowercase in Firestore — use firstName + lastName for display.

## Firebase Details
- Project: `project-balance-66b89`
- Collections: `ff_scores` (athletes), `ff_meets` (meet catalog)
- `ff_scores` security rules require a `where` clause — queries without a filter return empty
- Query by `meetId` is the most reliable method
- See `skills/details/scorecat_schema.md` for complete schema documentation
