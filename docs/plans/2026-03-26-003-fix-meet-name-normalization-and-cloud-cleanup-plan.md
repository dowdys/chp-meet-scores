---
title: "fix: Meet Name Normalization and Cloud Storage Cleanup"
type: fix
status: active
date: 2026-03-26
origin: docs/plans/2026-03-26-002-feat-centralized-supabase-database-plan.md
---

# fix: Meet Name Normalization and Cloud Storage Cleanup

## Overview

The centralized Supabase database keys on `meet_name` as the unique identifier. If the inner agent produces inconsistent names for the same championship (e.g., "2026 KY State Championships" vs "USAG W Gymnastics - 2026 KY - March 14-16"), the system creates duplicate entries instead of overwriting. This plan adds deterministic name normalization so the same meet always produces the same key, regardless of what the agent calls it. It also adds storage blob cleanup on re-publish to prevent orphaned files.

## Problem Statement

Current state of the 5 published meets demonstrates the problem:

| Current Name | Canonical Format |
|---|---|
| `2026 KY State Championships` | `USAG W Gymnastics - 2026 KY - March 14-16` |
| `2026 Louisiana State Championships` | `USAG W Gymnastics - 2026 LA - [dates]` |
| `USAG W Gymnastics - 2026 OR - March 13-21` | Already correct |
| `USAG W Gymnastics - 2026 WI - March 20, 2026` | `USAG W Gymnastics - 2026 WI - March 20` |
| `USAG Women's Gymnastics State Championship - Nebraska - all levels` | `USAG W Gymnastics - 2026 NE - [dates]` |

Only Oregon follows the canonical format defined in `workflow-phases.ts:99-106`:
```
[Association] [Gender Initial] [Sport] - [Year] [State Abbrev] - [Date(s)]
```

The second problem: when a meet is re-published (re-finalized or backs re-imported), the `publish_meet` RPC cascades delete on `meet_files` rows but does NOT delete the actual storage blobs. If a file was present in v1 but absent in v2, the blob persists orphaned in Supabase Storage.

## Proposed Solution

### 1. Deterministic `normalizeMeetName()` Function

A TypeScript function that takes the available metadata (association, gender, sport, year, state, dates) and produces the canonical name. This function is called:

- In `set_output_name` tool -- normalize whatever the agent provides before storing as `context.outputName`
- In `publishMeet()` -- normalize before sending to Supabase (defense-in-depth, in case `set_output_name` was bypassed)
- In `finalize_meet` -- normalize the meet_name used for the local central DB

The function does NOT depend on the agent's chosen name. It derives the canonical name from structured fields that are always available:

```typescript
interface MeetIdentity {
  association: string;   // 'USAG', 'AAU', etc.
  gender: string;        // 'W' or 'M'
  sport: string;         // 'Gymnastics'
  year: string;          // '2026'
  state: string;         // 'KY' (2-letter abbreviation)
  dates?: string;        // 'March 14-16' (optional, from lookup_meet or extraction)
}

function normalizeMeetName(identity: MeetIdentity): string {
  // Format: [Association] [Gender] [Sport] - [Year] [State] - [Date(s)]
  const base = `${identity.association} ${identity.gender} ${identity.sport} - ${identity.year} ${identity.state.toUpperCase()}`;
  if (identity.dates) {
    // Strip year from dates if present (e.g., "March 20, 2026" -> "March 20")
    const cleanDates = identity.dates.replace(/,?\s*\d{4}$/, '').trim();
    return `${base} - ${cleanDates}`;
  }
  return base;
}
```

**Key properties:**
- **Deterministic** -- same inputs always produce the same output
- **Agent-independent** -- doesn't use whatever freeform name the agent invented
- **Forward-compatible** -- handles Men's gymnastics, AAU, other sports by varying the structured fields
- **Date-tolerant** -- works with or without dates; strips trailing year from dates

**State abbreviation handling:** The system already has `context.state` as a 2-letter code. If the agent provides a full state name ("Louisiana", "Nebraska"), normalize it to the abbreviation. Use a simple lookup map.

### 2. Storage Blob Cleanup on Re-publish

Before uploading new files in `uploadMeetFiles()`, list existing blobs at the storage path and delete any that aren't in the new file set:

```typescript
// In uploadMeetFiles(), before the upload loop:
const { data: existingFiles } = await supabase.storage
  .from('meet-documents')
  .list(storagePath);

if (existingFiles?.length) {
  const newFilenames = new Set(UPLOADABLE_FILES.filter(f =>
    fs.existsSync(path.join(outputDir, f))
  ));
  const orphaned = existingFiles
    .filter(f => !newFilenames.has(f.name))
    .map(f => `${storagePath}/${f.name}`);
  if (orphaned.length > 0) {
    await supabase.storage.from('meet-documents').remove(orphaned);
  }
}
```

### 3. Where Normalization Is Enforced

| Location | What happens | File |
|---|---|---|
| `set_output_name` tool | Agent calls this during DISCOVERY. Normalize the name before storing as `context.outputName`. | `src/main/context-tools.ts` or `agent-loop.ts` |
| `build_database` tool | Uses `context.outputName` as the `--meet` arg to Python. Already correct if `set_output_name` normalized. | `src/main/context-tools.ts` |
| `finalize_meet` tool | Uses `meetName` arg from agent. Should validate it matches `context.outputName`. | `src/main/tools/python-tools.ts` |
| `publishMeet()` | Reads `meet_name` from local SQLite. Should be already normalized from `set_output_name`. Defense-in-depth: normalize again before RPC call. | `src/main/supabase-sync.ts` |
| `uploadMeetFiles()` | Derives storage path from meet metadata. Uses `sanitizeMeetName()` for URL-safe slug. No change needed (already deterministic from meet_name). | `src/main/supabase-sync.ts` |
| `import_pdf_backs` tool | Auto-corrects `meetName` to `context.outputName` (line 366-368 of context-tools.ts). Already correct. | `src/main/context-tools.ts` |

### 4. Handling "Replace Backs for Kentucky"

When a user says "replace the backs for Kentucky," the system needs to:

1. **Find the meet** -- The agent should look up the meet by searching the local central DB or Supabase for state='KY' and year='2026'. The normalized name makes this reliable because there's exactly one meet per (association, gender, sport, year, state) tuple.

2. **Set the context** -- `context.outputName` gets set to the normalized name. `context.state` gets set. The output directory is derived from the name.

3. **Import the backs** -- `import_pdf_backs` uses `context.outputName` (already auto-corrected at line 366-368). Python regenerates dependent files. Auto-upload to cloud fires.

The key insight: the agent doesn't need to remember or guess the exact meet name. It looks it up by state+year, and the normalized name is deterministic from the structured fields.

## Acceptance Criteria

- [ ] `normalizeMeetName()` function in `src/main/meet-naming.ts` produces canonical format from structured fields
- [ ] `set_output_name` tool normalizes the name before storing in context
- [ ] State name-to-abbreviation lookup handles full names ("Louisiana" -> "LA")
- [ ] `finalize_meet` validates meetName matches context.outputName
- [ ] `uploadMeetFiles()` cleans up orphaned storage blobs before uploading
- [ ] Re-publishing a meet with the same state+year overwrites, never duplicates
- [ ] Existing 5 meets in Supabase can be renamed to canonical format via a one-time migration

## Context

- Canonical naming format defined at `src/main/workflow-phases.ts:99-106`
- `context.outputName` auto-correction already exists in `import_pdf_backs` at `src/main/context-tools.ts:366-368`
- Learning: `output-name-meet-name-must-match` -- the entire data model hinges on `meet_name` consistency
- The `publish_meet` RPC uses DELETE+INSERT keyed on `meet_name` with CASCADE -- exact match is required
