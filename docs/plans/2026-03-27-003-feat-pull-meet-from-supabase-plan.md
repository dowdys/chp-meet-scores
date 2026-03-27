---
title: "feat: Pull published meet data from Supabase for local regeneration"
type: feat
status: completed
date: 2026-03-27
---

# Pull Meet from Supabase

## Overview

Add the ability to download a published meet's data (results, winners, metadata) from Supabase into the local SQLite database, enabling output regeneration without re-running the full extraction pipeline. Accessible from both the Cloud Meets tab UI and the inner agent as a tool.

## Problem Statement

After a meet is published to Supabase, corrections may be made to the cloud data (e.g., gym name fixes via `correct_gym_names`). The local SQLite DB may be empty (staging DBs are cleaned up) or the user may be on a different machine entirely. Currently there's no way to get the corrected data back locally — the only option is to re-run the full extraction pipeline from scratch, which is slow and may not reproduce the same corrections.

## Proposed Solution

Add a `pullMeetData()` function in `supabase-sync.ts` (the inverse of `publishMeetData()`) that queries Supabase for a meet's results + winners + metadata and writes them into `chp_results.db`. Expose this via:

1. **IPC handler** (`pull-cloud-meet`) — called from the Cloud Meets tab
2. **Inner agent tool** (`pull_meet`) — available in `output_finalize` and `import_backs` phases
3. **UI button** — "Pull to Local" in CloudMeetsTab detail view

After pull completes, the user can run `regenerate_output` to create fresh docs from the corrected data.

## Technical Approach

### Core Function: `pullMeetData()`

**File:** `src/main/supabase-sync.ts`

```typescript
export async function pullMeetData(meetName: string): Promise<PullResult> {
  const supabase = await getSupabaseClient();
  // 1. Fetch meets metadata
  // 2. Fetch all results (paginated — avoid 1000-row PostgREST truncation)
  // 3. Fetch all winners (paginated)
  // 4. Write to local central DB in a transaction (delete-then-insert pattern from finalize_meet)
  // 5. Return counts for confirmation
}
```

Key details:
- **Pagination**: PostgREST defaults to 1000 rows. Use `.range(offset, offset + 999)` in a loop until fewer rows returned. MN has 1679 results — without pagination, 679 would be silently lost.
- **Score conversion**: Supabase `NUMERIC` → SQLite `REAL`. No rounding needed (read direction).
- **Boolean conversion**: Supabase `is_tie: true/false` → SQLite `INTEGER 0/1`.
- **Transaction**: Use better-sqlite3's `db.transaction()` for atomicity, same as `finalize_meet`.
- **Central DB path**: Use existing `getCentralDbPath()` from `paths.ts`.

### File Downloads (Optional)

`pullMeetData()` handles data only. File downloads already work via `download-cloud-file` IPC handler. The UI can offer "Pull Data + Files" which calls both.

### IPC Handler

**File:** `src/main/main.ts` (in `setupIPC()`, after existing cloud handlers)

```typescript
ipcMain.handle('pull-cloud-meet', async (_event, meetName: string) => {
  const result = await pullMeetData(meetName);
  return result;
});
```

### Inner Agent Tool

**File:** `src/main/tool-definitions.ts`

```typescript
{
  name: 'pull_meet',
  description: 'Download a published meet from Supabase into the local database for output regeneration.',
  input_schema: {
    type: 'object',
    properties: {
      meet_name: { type: 'string', description: 'The meet name as published in Supabase' },
    },
    required: ['meet_name'],
  },
}
```

**Tool executor** in `src/main/tools/python-tools.ts` (alongside `finalize_meet`):
```typescript
pull_meet: async (args) => {
  const meetName = requireString(args, 'meet_name');
  const result = await pullMeetData(meetName);
  if (!result.success) return `Error: ${result.reason}`;
  return `Pulled "${meetName}" from Supabase: ${result.resultsCount} results, ${result.winnersCount} winners. Use regenerate_output to create fresh docs.`;
},
```

**Phase gating:** Add `pull_meet` to `output_finalize` and `import_backs` phases in `workflow-phases.ts`.

### UI Button

**File:** `src/renderer/components/CloudMeetsTab.tsx`

Add a "Pull to Local" button in the meet detail view header (alongside existing Download All button). On click:

```typescript
const handlePullMeet = async () => {
  setPulling(true);
  const result = await window.electronAPI.pullCloudMeet(selectedMeet.meet_name);
  setPulling(false);
  if (result.success) {
    // Show success toast with counts
  }
};
```

**Preload bridge** (`src/preload/preload.ts`):
```typescript
pullCloudMeet: (meetName: string) => ipcRenderer.invoke('pull-cloud-meet', meetName),
```

**Type** (`src/shared/types.ts`):
```typescript
pullCloudMeet: (meetName: string) => Promise<{ success: boolean; reason?: string; resultsCount?: number; winnersCount?: number }>;
```

## Acceptance Criteria

- [x] `pullMeetData()` fetches all results and winners for a meet (handles pagination for >1000 rows)
- [x] Data written to `chp_results.db` in a transaction (delete-then-insert, same as finalize_meet)
- [x] Boolean `is_tie` correctly converted from Supabase boolean to SQLite integer
- [x] `regenerate_output` produces correct docs after pull (gym_highlights, order_forms, meet_summary)
- [x] CloudMeetsTab shows "Pull to Local" button with loading state and success/error feedback
- [x] `pull_meet` agent tool available in output_finalize and import_backs phases
- [x] Pulling a meet that doesn't exist in Supabase returns a clear error message
- [x] Pulling a meet that already exists locally overwrites cleanly (no duplicate data)

## Files to Modify

| File | Change |
|------|--------|
| `src/main/supabase-sync.ts` | Add `pullMeetData()` function |
| `src/main/main.ts` | Add `pull-cloud-meet` IPC handler |
| `src/main/tools/python-tools.ts` | Add `pull_meet` tool executor |
| `src/main/tool-definitions.ts` | Add `pull_meet` tool definition |
| `src/main/workflow-phases.ts` | Add `pull_meet` to output_finalize + import_backs phases |
| `src/shared/types.ts` | Add `pullCloudMeet` to ElectronAPI interface |
| `src/preload/preload.ts` | Add `pullCloudMeet` preload binding |
| `src/renderer/components/CloudMeetsTab.tsx` | Add "Pull to Local" button in detail view |

## Dependencies & Risks

**Pagination is critical.** The learnings research flagged "1000-row silent truncation" as a known issue. Any meet with >1000 athletes will have partial data without proper pagination. Use `.range()` loops.

**Phase management.** Per documented solution `switch-phase-helper-invariant.md`: the `pull_meet` tool writes to the central DB, not staging. It should NOT be in `ALWAYS_AVAILABLE_TOOLS` to avoid violating staging isolation during active processing.

**Idempotent pulls.** Delete-then-insert within a transaction ensures pulling the same meet twice produces the same result.
