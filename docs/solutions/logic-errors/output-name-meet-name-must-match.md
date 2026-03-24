---
title: "outputName and build_database meet_name must match or files split across folders"
category: logic-errors
date: 2026-03-23
tags: [output-name, meet-name, folder-mismatch, build-database, set-output-name]
components: [context-tools, workflow-phases]
severity: p1
---

# outputName and build_database meet_name must match

## Problem

If `set_output_name` and `build_database` receive different name strings, the system silently splits output files across two different folders. The database stores results under one name, output files land in a different directory, and the "Open Folder" button points to the wrong location.

## Root Cause

Two independent values control file destinations, and nothing validates they are the same:

1. **`set_output_name`** stores a string in `context.outputName`, which determines the output directory path via `getOutputDir(context.outputName)` in `context-tools.ts:194`.
2. **`build_database`** takes a `meet_name` argument that gets passed to Python as the DB key and is used for folder-level output generation.

These two values flow through different code paths:
- `set_output_name` is called during the discovery phase (user-facing folder name)
- `build_database` is called during the database phase (DB record key)

If the agent uses slightly different strings (e.g., "2025 MS State Championships" vs "2025 Mississippi State Championships"), the system creates two folders and splits work between them.

## Symptoms

- Output folder has some files but not others
- "Open Folder" opens an empty or incomplete folder
- DB queries return results but generated files reference a different meet name
- The `finalize_meet` step copies data to central DB under the `meet_name` key, which may not match the folder that `outputName` created

## Where the Coupling Lives

- `src/main/context-tools.ts:153-155` -- `toolBuildDatabase` requires `context.outputName` to be set
- `src/main/context-tools.ts:194` -- uses `context.outputName` for the `--output` directory
- `src/main/context-tools.ts:326` -- `import_pdf_backs` sets `context.outputName` from `meet_name`
- `src/main/process-logger.ts:150` -- log copy uses `context.outputName || context.meetName`

## Prevention

The agent must use the exact same string for both `set_output_name` and `build_database meet_name`. The standardized format is:

```
[Association] [Gender] [Sport] - [Year] [State] - [Dates]
Example: "USAG W Gymnastics - 2025 MS - March 14-16"
```

The `set_output_name` check at `context-tools.ts:153` prevents `build_database` from running without an output name set, but it does NOT verify the names match. A structural fix would be to have `build_database` automatically use `context.outputName` as the meet_name instead of accepting it as a separate argument.

## Related

- `src/main/workflow-phases.ts:99-106` -- meet naming convention documentation
- `docs/solutions/logic-errors/persist-destructive-operation-guards.md` -- another context state coupling issue
