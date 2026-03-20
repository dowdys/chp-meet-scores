---
title: "Stale extraction files accumulate and cause massive data bloat"
category: logic-errors
date: 2026-03-20
tags: [extraction, data-bloat, cleanup, mso-extract, generic-adapter]
components: [extraction-tools, generic_adapter]
severity: p1
---

# Stale extraction files accumulate and cause massive data bloat

## Problem

After multiple runs, `build_database` parsed 17,479 athletes instead of 971. The database had correct winners (dedup caught most duplicates) but the parse step was 18x slower and some cross-state data leaked through.

## Root Cause

Each extraction creates a timestamped JSON file: `mso_extract_1773963653074.json`. These files are NEVER deleted. After 12 runs, the data directory had 12 extract files totaling 10,401 records.

When `generic_adapter.py` receives a directory path (or when the path resolution accidentally picks up the directory), its `_parse_directory` method globs ALL `*.json` files and loads them all. The in-memory dedup catches exact duplicates but can't filter records from different meets/states.

## Solution

Added cleanup at the START of both `mso_extract` and `scorecat_extract` tools:
```typescript
// Clean up old extract files before new extraction
for (const f of fs.readdirSync(dataDir)) {
  if (f.startsWith('mso_extract_') && f.endsWith('.json')) {
    try { fs.unlinkSync(path.join(dataDir, f)); } catch {}
  }
}
```

Also cleaned 13 stale files from the dev data directory.

## Prevention

Any tool that creates timestamped output files should clean up old versions of those files before creating new ones. The pattern "create with timestamp, never delete" is a ticking time bomb for any process that globs the directory.
