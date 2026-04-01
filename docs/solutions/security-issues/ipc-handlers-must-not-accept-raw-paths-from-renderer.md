---
title: "IPC handlers must validate and reconstruct file paths, never accept raw paths from renderer"
category: security-issues
tags: [electron, ipc, path-traversal, input-validation, security]
module: src/main/main.ts, src/main/paths.ts
symptom: "Potential path traversal via crafted meetName or filename in IPC handler"
root_cause: "IPC handler accepted raw filePath string from renderer and passed directly to shell.openPath()"
date: 2026-04-01
---

# IPC Handlers Must Not Accept Raw File Paths from the Renderer

## Problem

The `open-path` IPC handler accepted an arbitrary `filePath` string from the renderer and called `shell.openPath(filePath)` directly. A renderer-side bug or XSS could pass paths like `../../etc/passwd` or `C:\Windows\System32\cmd.exe`, causing the main process to open or execute arbitrary files.

The same pattern existed in `show-in-folder` and could appear in any handler that touches the filesystem based on renderer input.

## Root Cause

The renderer was treated as a trusted caller. In Electron's security model, the renderer has the same threat model as a web page — it can be compromised by XSS, prototype pollution, or malicious npm packages. Forwarding its input directly to OS shell APIs is equivalent to letting a web page open files on the user's machine.

## Solution

Replace raw-path handlers with ones that accept semantic identifiers (`meetName` + `filename`), validate both, and reconstruct paths in the main process:

```typescript
// src/main/paths.ts — validation utilities
export function assertSafeMeetName(name: string): void {
  if (!name || typeof name !== 'string') throw new Error('Invalid meet name');
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new Error('Invalid meet name: path separators not allowed');
  }
}

export function assertSafeFilename(name: string): void {
  if (!name || typeof name !== 'string') throw new Error('Invalid filename');
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new Error('Invalid filename: path separators not allowed');
  }
  const allowedExtensions = ['.pdf', '.idml', '.txt', '.csv', '.xlsx'];
  if (!allowedExtensions.includes(path.extname(name).toLowerCase())) {
    throw new Error('Invalid filename: unsupported extension');
  }
}

// src/main/main.ts — safe IPC handler
ipcMain.handle('open-file', async (_event, meetName: string, filename: string) => {
  assertSafeMeetName(meetName);
  assertSafeFilename(filename);
  const filePath = path.join(getOutputBase(), meetName, filename);
  const errorMsg = await shell.openPath(filePath);
  return { success: !errorMsg, error: errorMsg || undefined };
});
```

## Invariant

**The main process owns path construction.** The renderer supplies only semantic identifiers that describe *which* file within a known directory — never a filesystem path. This makes path traversal structurally impossible regardless of renderer state.

## Applied To

All IPC handlers that build file paths from renderer input were hardened:
- `open-file` (was `open-path`)
- `show-in-folder`
- `get-output-files`
- `open-output-folder`
- `download-cloud-file`
- `print-file`
- `send-to-designer`

## Prevention

When adding a new IPC handler that touches the filesystem:
1. Never accept a file path from the renderer
2. Accept semantic identifiers (meet name, filename, record ID)
3. Validate inputs with `assertSafeMeetName` / `assertSafeFilename`
4. Reconstruct the full path in the main process from trusted base paths
