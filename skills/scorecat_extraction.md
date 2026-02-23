# Skill: ScoreCat / Firebase Data Extraction

## Overview
ScoreCat (results.scorecatonline.com) is a Flutter/Dart web app that renders everything to `<canvas>`. Standard DOM scraping and XHR interception do not work. Data is extracted by accessing the Firebase Firestore SDK that the Flutter app loads into the browser.

## Prerequisites
- Chrome with remote debugging connected via Chrome DevTools MCP
- Navigate to the meet's sessions list page first: `https://results.scorecatonline.com/sessionsList?meetId=[MEET_ID]`
- Wait for the page to fully load (the Flutter app must initialize Firebase)

## Extraction Steps

### Step 1: Query Firestore for all athlete scores
Run this JavaScript via `evaluate_script`. Replace the meetName value with the actual meet name:

```javascript
() => {
  const fc = window.firebase_core;
  const ff = window.firebase_firestore;
  const app = fc.getApp();
  const db = ff.getFirestore(app);
  const q = ff.query(
    ff.collection(db, 'ff_scores'),
    ff.where('meetName', '==', 'MEET_NAME_HERE')
  );
  return ff.getDocs(q).then(snap => {
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
        vtRank: data.event1Rank, ubRank: data.event2Rank,
        bbRank: data.event3Rank, fxRank: data.event4Rank,
        aaPlace: data.event7Place
      };
    });
    return { count: window.__allAthletes.length };
  });
}
```

### Step 2: Retrieve data in chunks
The result set can be hundreds of athletes. Retrieve in chunks of 100:
```javascript
() => JSON.stringify(window.__allAthletes.slice(0, 100))
```
```javascript
() => JSON.stringify(window.__allAthletes.slice(100, 200))
```
Continue until all athletes are retrieved. Save all chunks to a JSON file (e.g., `athletes.json`).

### Step 3: Pass to database builder
The JSON file is processed by the Python adapter which handles both Firestore-style field names (event1Score) and the short names (vt, ub, bb, fx, aa) used in the extraction query above.

## Event Mapping
| Firestore Field | Event |
|----------------|-------|
| event1 / event1Score | Vault |
| event2 / event2Score | Bars (Uneven Bars) |
| event3 / event3Score | Beam (Balance Beam) |
| event4 / event4Score | Floor |
| event7 / event7Score | All-Around |

## Data Quirks
- **Prefixed fields**: level="Level: 8", division="Division: Jr A", session="Session: 1" — the Python adapter strips these prefixes automatically.
- **Event notes in lastNames**: Some lastNames contain notes like "Holder- BB, FX" or "Peter- UB" indicating partial competitors. The adapter strips the dash and everything after.
- **Zero scores**: A score of 0 or null means the athlete did not compete on that event. Exclude from winner determination even if rank=1.
- **Place strings**: May contain "T" suffix for ties (e.g., "5T") or asterisks (e.g., "7*").

## Firebase Details
- Project: `project-balance-66b89`
- Collections: `ff_scores` (athletes), `ff_sessions` (session metadata), `ff_meets` (meet info)
- The meet name in `ff_scores.meetName` must match exactly (case-sensitive)

## Edge Cases
For partial competitors, score anomalies, or session metadata queries, load `details/scorecat_edge_cases`.
