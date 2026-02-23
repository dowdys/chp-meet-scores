# Detail: ScoreCat Edge Cases

## Partial Competitors
Some athletes only competed on certain events. Their `lastName` field in Firestore contains event notes:
- `"Holder- BB, FX"` — competed only on Beam and Floor
- `"Peter- UB"` — competed only on Bars

**Handling**: The adapter strips the dash and everything after from lastNames using: `re.sub(r'\s*-\s*[A-Z, ]+$', '', lastName)`. These athletes will have null/0 scores on events they didn't compete in. This is correct — do not treat missing scores as errors for these athletes.

## Score Anomalies
- **Exactly 0.000**: Means did not compete (DNF/DNS). Treated as null — excluded from winner determination.
- **null/missing**: Same as 0 — did not compete.
- **Very low scores (e.g., 0.1-4.9)**: Rare but legitimate. These are actual scores from falls or major deductions. Do NOT filter these out.

## Place Strings
The rank/place fields from ScoreCat may contain:
- Integer: `1`, `5` — normal placement
- `"T"` suffix: `"1T"`, `"5T"` — tied for that place
- Asterisk: `"7*"` — typically indicates a special circumstance
- The adapter strips T suffixes and asterisks when parsing to integer: `re.sub(r'[Tt*]$', '', place_string)`

## Session Metadata
Additional meet structure can be queried from the `ff_sessions` collection:
```javascript
() => {
  const fc = window.firebase_core;
  const ff = window.firebase_firestore;
  const app = fc.getApp();
  const db = ff.getFirestore(app);
  const q = ff.query(
    ff.collection(db, 'ff_sessions'),
    ff.where('meetName', '==', 'MEET_NAME_HERE')
  );
  return ff.getDocs(q).then(snap => snap.docs.map(d => d.data()));
}
```
This returns session descriptions, levels, and divisions — useful for verifying session+level+division groupings.
