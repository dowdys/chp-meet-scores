---
title: "import_idml must pass --state and --meet to Python when metadata is missing"
category: logic-errors
date: 2026-03-20
tags: [idml-import, metadata, fallback-params]
components: [context-tools, process_meet]
severity: p1
---

# import_idml must pass --state and --meet to Python when metadata is missing

## Problem

User provided an IDML file without embedded CHP_METADATA. The TypeScript `toolImportIdml` function correctly set `context.outputName` from fallback params, but the Python process still used "IDML Import" as the meet name. Output went to the wrong folder, and no order forms or gym highlights were generated (because "IDML Import" has no data in the database).

## Root Cause

The TypeScript code set `context.outputName` from the fallback `meet_name` param and used it for `--output` (the output directory). But it never passed `--state` and `--meet` to the Python CLI. The Python `--import-idml` code path reads embedded metadata, and when that's missing, falls back to `args.state` and `args.meet` — which were empty because TypeScript didn't send them.

The Python code at lines 247-262 already supports this:
```python
if not args.state:
    args.state = 'Unknown'
if not args.meet:
    args.meet = 'IDML Import'
```

If `--state` and `--meet` are passed on CLI, these defaults never trigger.

## Fix

Added `--meet` and `--state` to the argParts in `toolImportIdml`:
```typescript
if (outputMeetName !== 'IDML Import') {
  argParts.push('--meet', outputMeetName);
}
const stateParam = optionalString(args, 'state');
if (stateParam) {
  argParts.push('--state', stateParam);
}
```

## Prevention

When adding fallback/override parameters at the TypeScript tool level, ensure they are passed through to the Python CLI — not just used for directory naming. The TypeScript and Python layers have separate metadata resolution paths that must agree.
