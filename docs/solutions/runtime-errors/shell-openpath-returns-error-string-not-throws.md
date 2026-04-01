---
title: "shell.openPath() returns error string instead of throwing — must capture return value"
category: runtime-errors
tags: [electron, shell, error-handling, silent-failure]
module: src/main/main.ts
symptom: "User clicks Open File, nothing happens, no error shown"
root_cause: "shell.openPath() returns Promise<string> (empty=success, non-empty=error) but return value was discarded"
date: 2026-04-01
---

# shell.openPath() Returns Error String — Don't Discard It

## Problem

The `open-path` IPC handler called `await shell.openPath(filePath)` without capturing the return value. When opening failed (no associated application for `.idml`, file missing, permission denied), the handler returned `undefined` to the renderer. The user saw no error — just nothing happening.

## Root Cause

`shell.openPath()` does **not throw** on failure. It returns `Promise<string>` where:
- Empty string `""` = success
- Non-empty string = error message (e.g., `"The system cannot find the file specified"`)

This is non-standard compared to most Node.js APIs that reject on error. The pattern is easy to miss in code review — `await shell.openPath(filePath)` looks complete and correct at a glance.

## Solution

Capture the return value and convert to a typed result:

```typescript
// BEFORE — error silently swallowed:
ipcMain.handle('open-path', async (_event, filePath: string) => {
  await shell.openPath(filePath);
  // returns undefined to renderer regardless of outcome
});

// AFTER — error captured and surfaced:
ipcMain.handle('open-file', async (_event, meetName: string, filename: string) => {
  assertSafeMeetName(meetName);
  assertSafeFilename(filename);
  const filePath = path.join(getOutputBase(), meetName, filename);
  const errorMsg = await shell.openPath(filePath);
  return { success: !errorMsg, error: errorMsg || undefined };
});
```

## Key Insight

Several Electron shell APIs use this "empty string = success, non-empty = error" contract instead of throwing:
- `shell.openPath()`
- `shell.openExternal()` (older versions)

Treat every call to these APIs like a C-style return code: **always capture and check the return value**. A small wrapper can enforce this:

```typescript
async function safeOpenPath(filePath: string): Promise<{ success: boolean; error?: string }> {
  const errorMsg = await shell.openPath(filePath);
  return { success: !errorMsg, error: errorMsg || undefined };
}
```

## Prevention

When using any Electron `shell.*` API, check the TypeScript signature. If it returns `Promise<string>` or `string`, it's using the error-string pattern. Always capture and surface the result.
