---
title: run_script and runPython provide different environment variables
category: runtime-errors
date: 2026-03-27
component: src/main/tools/python-tools.ts, src/main/context-tools.ts
severity: medium
tags: [electron, python, environment-variables, agent-tools, run-script]
---

## Problem

Agent Python scripts that work when called via `run_script` fail or behave differently when the same code runs inside `build_database` or `regenerate_output`, because the two execution paths provide different environment variables.

## Root Cause

There are two separate Python execution paths with different env var scopes:

### `run_script` (python-tools.ts)
Passes env vars explicitly to the child process:
```typescript
{
    DB_PATH: dbPath,              // staging or central, context-dependent
    CENTRAL_DB_PATH: centralDbPath,
    DATA_DIR: dataDir,
    STAGING_DB_PATH: currentStagingDbPath || '',
    PYTHONUTF8: '1',
    SUPABASE_URL,
    SUPABASE_KEY: SUPABASE_ANON_KEY,
}
```

### `runPython` (context-tools.ts, used by `build_database` / `regenerate_output`)
Passes only Supabase credentials, plus `PYTHONUTF8` from the base `pythonManager.runScript`:
```typescript
const SUPABASE_ENV = { SUPABASE_URL, SUPABASE_KEY: SUPABASE_ANON_KEY };
// ...
const result = await pythonManager.runScript('process_meet.py', argParts, onLine, SUPABASE_ENV);
```

The `runPython` path does NOT set `DB_PATH`, `CENTRAL_DB_PATH`, `DATA_DIR`, or `STAGING_DB_PATH` as environment variables. Instead, it passes database paths as CLI arguments (`--db`, `--output`, etc.) which `process_meet.py` parses internally.

### Consequence

If agent-authored Python code (written for `run_script`) uses `os.environ['DB_PATH']` or `os.environ['STAGING_DB_PATH']`, it works. But if that same pattern is copy-pasted into `process_meet.py` internals or into code that runs via the `build_database` pipeline, those env vars are absent and the code fails with `KeyError`.

Conversely, both paths DO provide `SUPABASE_URL` and `SUPABASE_KEY`, so Supabase API calls work identically in either context.

## Solution

When writing agent Python scripts intended for `run_script`, rely on the env vars it provides -- they are documented in the tool description. When writing code that runs inside `process_meet.py` (the `build_database` / `regenerate_output` path), use the CLI arguments parsed by argparse, not environment variables.

Summary of what is available where:

| Env Var | `run_script` | `runPython` (build_database) |
|---------|:---:|:---:|
| `DB_PATH` | yes | no (use `--db` CLI arg) |
| `CENTRAL_DB_PATH` | yes | no |
| `DATA_DIR` | yes | no (use `--output` CLI arg) |
| `STAGING_DB_PATH` | yes | no (use `--db` CLI arg) |
| `PYTHONUTF8` | yes | yes |
| `SUPABASE_URL` | yes | yes |
| `SUPABASE_KEY` | yes | yes |

## Prevention

1. **Do not assume env vars are universal** -- check which tool executor will run your code
2. **For `run_script` inline code**: use `os.environ['DB_PATH']` etc. freely; they are guaranteed
3. **For `process_meet.py` internals**: use the argparse-parsed paths; env vars for DB paths are not set
4. **If you need to unify**: add the missing env vars to `runPython`'s `SUPABASE_ENV` dict in `context-tools.ts`, but note that `build_database` intentionally uses CLI args to keep `process_meet.py` invocable from the command line without Electron
