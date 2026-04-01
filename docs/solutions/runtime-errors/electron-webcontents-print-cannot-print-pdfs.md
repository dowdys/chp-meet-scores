---
title: "Electron webContents.print() cannot print PDF files"
category: runtime-errors
tags: [electron, pdf, printing, powershell, file-protocol]
module: src/main/main.ts
symptom: "Silent 0 KB print job when using webContents.print() on a PDF loaded via file:// URL"
root_cause: "Chromium's PDF viewer is an internal extension unreachable by the print API"
date: 2026-04-01
---

# Electron webContents.print() Cannot Print PDF Files

## Problem

Calling `webContents.print()` on a BrowserWindow that has loaded a PDF via `file://` URL produces a 0 KB print job. The printer receives nothing. No error is thrown — the call succeeds silently with an empty result.

## Root Cause

Chromium implements its built-in PDF viewer as an internal extension (`chrome-extension://...`). The `webContents.print()` API cannot reach into that extension context. When invoked, it prints the *hosting page* (which is empty) rather than the PDF content rendered by the extension.

This is a confirmed, unfixed Electron bug:
- [electron/electron#26448](https://github.com/electron/electron/issues/26448)
- [electron/electron#26498](https://github.com/electron/electron/issues/26498)

## Solution

Delegate printing to the OS via PowerShell `Start-Process -Verb Print`. Use `spawn` with an argument array — never string interpolation — to prevent command injection:

```typescript
import { spawn } from 'child_process';

ipcMain.handle('print-file', async (_event, meetName: string, filename: string) => {
  assertSafeMeetName(meetName);
  assertSafeFilename(filename);
  const filePath = path.join(getOutputBase(), meetName, filename);

  const child = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    'Start-Process', '-FilePath', filePath, '-Verb', 'Print',
  ], { detached: true, stdio: 'ignore' });

  child.unref();
  return { success: true };
});
```

## Key Details

- Use `spawn` not `exec` — avoids extra `cmd.exe` wrapper process
- `detached: true` lets the print dialog outlive the Electron process
- PowerShell startup adds 300–800ms latency (acceptable for user-initiated print)
- Edge on Windows 11 may print silently (no dialog) when it's the default PDF app
- For more reliable/controllable printing, bundle SumatraPDF (~10MB) as an `extraResource`

## Prevention

When adding print functionality to an Electron app, never attempt `webContents.print()` for PDF files. Go directly to OS-level print invocation. This applies to `webContents.printToPDF()` as well — that API converts HTML to PDF, it does not print existing PDFs.
