# Detail: JavaScript SDK Piggyback Approach

## Concept
Some web apps load a backend SDK (Firebase, Supabase, AWS Amplify) that initializes a client connection. You can access that initialized client directly from the browser console to query the backend, bypassing the UI entirely.

## Detection
Check for common SDKs via `evaluate_script`:
```javascript
() => ({
  firebase_core: !!window.firebase_core,
  firebase_firestore: !!window.firebase_firestore,
  firebase: !!window.firebase,
  supabase: !!window.supabase,
  amplify: !!window.Amplify
})
```

## Firebase Pattern (used by ScoreCat)
```javascript
() => {
  const fc = window.firebase_core;
  const ff = window.firebase_firestore;
  const app = fc.getApp();
  const db = ff.getFirestore(app);
  const q = ff.query(
    ff.collection(db, 'COLLECTION_NAME'),
    ff.where('FIELD', '==', 'VALUE')
  );
  return ff.getDocs(q).then(snap => snap.docs.map(d => d.data()));
}
```
Key Firestore operations: `collection()`, `query()`, `where()`, `getDocs()`, `getDoc()`, `doc()`.

## Supabase Pattern
```javascript
() => {
  const sb = window.supabase;
  return sb.from('scores').select('*').eq('meet_id', 'VALUE').then(r => r.data);
}
```

## Discovery Steps
1. Detect which SDK is loaded (see Detection above)
2. Find the collection/table names — check network requests, source code, or try common names
3. Find the filter field — look at existing queries in network tab or try `meetId`, `meetName`, `meet_id`
4. Query the collection and inspect the returned data structure
5. Save results to a window variable, retrieve in chunks, save to file

## This is how ScoreCat extraction works
ScoreCat is a Flutter/Dart canvas app with no DOM. Data is accessed via the Firebase Firestore SDK loaded at `window.firebase_core` and `window.firebase_firestore`. See `scorecat_extraction` skill for the full technique.
