---
title: "run_script and runPython have separate env var scopes"
category: runtime-errors
date: 2026-03-27
tags: [electron, python, env-vars, run-script, silent-failure]
modules: [src/main/tools/python-tools.ts, src/main/context-tools.ts, skills]
---

## Problem

Skill documents that instruct the inner agent to use `os.environ.get('SUPABASE_URL')` in `run_script` silently fail because that env var is only passed by `runPython`, not by `run_script`.

## Symptom

No error. The Python code in the skill uses a guard like `if supabase_url and supabase_key:` — when the vars are missing, the entire block is silently skipped. The agent reports success but the action (e.g., persisting gym aliases to Supabase) never actually happens.

## Root Cause

Two separate code paths invoke `pythonManager.runScript()` with different `extraEnv` dicts:

**`runPython` in `context-tools.ts`** (used by `build_database`, `regenerate_output`):
```typescript
const SUPABASE_ENV = { SUPABASE_URL, SUPABASE_KEY: SUPABASE_ANON_KEY };
// ...
await pythonManager.runScript('process_meet.py', argParts, onLine, SUPABASE_ENV);
```

**`run_script` in `python-tools.ts`** (used by the agent's `run_script` tool):
```typescript
await pythonManager.runScript('process_meet.py', ['--exec-script', tempFile], undefined, {
    DB_PATH: dbPath,
    CENTRAL_DB_PATH: centralDbPath,
    DATA_DIR: dataDir,
    STAGING_DB_PATH: currentStagingDbPath || '',
    // SUPABASE_URL and SUPABASE_KEY were NOT here until fixed
});
```

Adding an env var to one path does not add it to the other. If a skill assumes an env var is available in `run_script` because it works in `build_database`, it will silently fail.

## Solution

When adding new env vars needed by Python code:
1. Check **both** `context-tools.ts:runPython` and `python-tools.ts:run_script`
2. Add the var to both `extraEnv` dicts
3. Import from a single source (e.g., `supabase-client.ts`) to avoid duplication

## Prevention

- When writing skill documents that use `os.environ` in `run_script` code, verify the var is actually passed by checking `python-tools.ts` line ~120
- Prefer dedicated tools over `run_script` for operations that need specific credentials — tools have direct access to `configStore` and imported modules
- If a `run_script` code block silently does nothing, check env var availability first
