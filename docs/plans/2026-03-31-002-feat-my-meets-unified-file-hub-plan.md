---
title: "feat: My Meets — Unified File Hub Tab"
type: feat
status: completed
date: 2026-03-31
origin: docs/brainstorms/2026-03-31-my-meets-file-hub-brainstorm.md
---

# feat: My Meets — Unified File Hub Tab

## Enhancement Summary

**Deepened on:** 2026-03-31
**Research agents used:** best-practices-researcher (print, email, IPC), architecture-strategist, security-sentinel, kieran-typescript-reviewer, performance-oracle, learnings-researcher

### Key Improvements from Research
1. **Security hardening** — Path traversal prevention via `assertSafeMeetName()`, command injection prevention in PowerShell, IPC path validation
2. **Merge logic moved to main process** — Single `list-unified-meets` IPC handler eliminates dual-loading-state complexity in renderer
3. **Proper discriminated union** — `UnifiedMeet` type uses `never` to prevent contradictory states
4. **Print reliability** — PowerShell with argument arrays (no string interpolation), fallback to `shell.openPath`
5. **Email security** — `requireTLS: true`, SMTP error translation table, attachment size pre-check (~18MB safe limit)
6. **Institutional learnings applied** — Single canonical meet identifier, explicit filename matching (not globs), operation guard persistence

### New Considerations Discovered
- `webContents.print()` cannot print PDF files loaded via `file://` — confirmed Electron bug
- Gmail App Passwords require 2FA enabled first — must provide user instructions
- Microsoft 365 deprecating basic SMTP auth by H2 2027 — app password approach works now
- `shell.openPath()` return value currently discarded in existing `open-path` handler — must fix
- Renderer should never send raw file paths to main — use `{meetName, filename}` tuples

---

## Overview

Replace the "Cloud Meets" tab with a unified **"My Meets"** tab that combines local and cloud meet files into one browsable interface. The primary user is non-tech-savvy, processes ~50 meets/season in batches of ~5/week on Windows, and struggles with finding and acting on output files via Windows File Explorer. This feature eliminates the need to ever open Explorer for GMS-related files.

(See brainstorm: docs/brainstorms/2026-03-31-my-meets-file-hub-brainstorm.md)

## Problem Statement

After the agent generates output files (PDFs, IDML, TXT), the user must:
1. Remember where the output folder is (`Documents/Gymnastics Champions/<meetName>/`)
2. Navigate Windows File Explorer to find the right meet folder
3. Manually open files to review them
4. Manually attach IDML to email, send to designer, wait for reply, download PDF, then import it back
5. Print files by opening them in a viewer first

Each of these steps is friction for a non-tech-savvy user. The app already has an `OutputFiles` component (shows files, no actions) and a `CloudMeetsTab` (browse/download cloud meets). Neither solves the full workflow.

## Proposed Solution

A unified "My Meets" tab that:
- Lists all meets from both local output directory and Supabase cloud
- Shows per-meet status badges: `LOCAL`, `CLOUD`, or both
- Provides one-click file actions: Open, Print, Show in Explorer
- Sends IDML files to the designer via automated email (nodemailer + SMTP)
- Imports the designer's edited PDF back into the app
- Replaces the Cloud Meets tab (same position in tab order)

## Technical Approach

### Architecture

```
┌─────────────────────────────────────────────────┐
│              MyMeetsTab.tsx                      │
│  ┌─────────────┐    ┌────────────────────────┐  │
│  │  Meet List   │    │   MeetDetailView.tsx    │  │
│  │  (unified    │───▶│  - File list            │  │
│  │   from one   │    │  - Actions: Open, Print,│  │
│  │   IPC call)  │    │    Send, Import, Pull DB│  │
│  └─────────────┘    └────────────────────────┘  │
└───────────────┬─────────────────────────────────┘
                │ IPC
┌───────────────▼─────────────────────────────────┐
│                    main.ts                       │
│  NEW: list-unified-meets, print-file,           │
│       send-to-designer, is-agent-running        │
│  CHANGED: open-file (was open-path, now takes   │
│           meetName+filename instead of raw path) │
│  EXISTING: get-output-files, show-in-folder,    │
│            download-cloud-file, pull-cloud-meet  │
└─────────────────────────────────────────────────┘
```

### Research Insights: Architecture

**Move merge logic to main process.** The original plan had the renderer receiving two separate IPC payloads and merging them in React state. This creates two coordinated loading states that can get out of sync. Instead, add a single `list-unified-meets` IPC handler that fetches both sources, merges by exact name, and returns one sorted list. The renderer then has one loading state, and the merge logic is testable in the main process.

**Use IPC query for `is-agent-running`.** The agent loop lives in the main process as `activeAgentLoop`. That is the authoritative source of running state. Lifting `isProcessing` to App.tsx creates two copies of truth (renderer state vs. main process state) that can diverge if the renderer crashes/reloads. Query main directly.

**Extract MeetDetailView.** CloudMeetsTab is 288 lines with both list and detail in one component via early return. MyMeetsTab will be larger (email, print, import actions). Extract `MeetDetailView` as a separate component to keep each file reviewable.

### Data Flow: Unified Meet List

```
┌─────────────────────────────────────────┐
│         list-unified-meets (main.ts)    │
│                                         │
│  1. fs.readdirSync(outputDir)           │
│     → filter by recognized filenames    │
│     → LocalMeet[]                       │
│                                         │
│  2. supabase.from('meets').select()     │
│     → CloudMeet[] (skip if disabled)    │
│                                         │
│  3. Merge by exact meet_name match      │
│     → UnifiedMeet[] sorted by recency   │
│                                         │
│  4. Return single payload to renderer   │
└─────────────────────────────────────────┘
```

**Join key:** Exact string match on meet name (local folder name === Supabase `meet_name`). The app's existing name normalization ensures consistency.

**Institutional learning:** `output-name-meet-name-must-match.md` — Two independent values (`outputName` in context vs `meet_name` argument) silently control the same folder destination. The scanner must use the folder name as the single canonical identifier. Never derive or display-format a name as a key.

**Precedence:** When a meet exists both locally and in cloud, show local files directly (no download needed). Cloud-only files appear with a download button.

### Implementation Phases

---

#### Phase 0: Security Foundation (Pre-requisite)

**Goal:** Establish input validation utilities used by all subsequent phases.

**New utility: `assertSafeMeetName()`** in `src/main/paths.ts`
```typescript
export function assertSafeMeetName(meetName: string): void {
  if (!meetName || typeof meetName !== 'string') throw new Error('Invalid meet name');
  if (meetName.includes('/') || meetName.includes('\\') || meetName.includes('..')) {
    throw new Error('Invalid meet name: path separators not allowed');
  }
  if (!/^[\w\s\-(),.&']+$/.test(meetName)) {
    throw new Error('Invalid meet name: unsupported characters');
  }
}

export function assertSafeFilename(filename: string): void {
  if (!filename || typeof filename !== 'string') throw new Error('Invalid filename');
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
    throw new Error('Invalid filename: path separators not allowed');
  }
  const allowedExtensions = ['.pdf', '.idml', '.txt', '.csv', '.xlsx'];
  const ext = path.extname(filename).toLowerCase();
  if (!allowedExtensions.includes(ext)) {
    throw new Error(`Invalid filename: unsupported extension ${ext}`);
  }
}
```

**Apply `assertSafeMeetName` to all existing IPC handlers** that build paths from `meetName`: `get-output-files`, `open-output-folder`, `download-cloud-file`.

**Change `open-path` to `open-file`** — accept `{meetName, filename}` tuple instead of raw `filePath`. Main process reconstructs and validates the path:
```typescript
ipcMain.handle('open-file', async (_event, meetName: string, filename: string) => {
  assertSafeMeetName(meetName);
  assertSafeFilename(filename);
  const filePath = path.join(getOutputDir(meetName, false), filename);
  // Verify path is inside outputDir
  const outputBase = configStore.get('outputDir');
  if (!filePath.startsWith(path.resolve(outputBase))) {
    return { success: false, error: 'Access denied' };
  }
  const errorMsg = await shell.openPath(filePath);
  return { success: !errorMsg, error: errorMsg || undefined };
});
```

**Files changed:**
- `src/main/paths.ts` — add `assertSafeMeetName`, `assertSafeFilename`
- `src/main/main.ts` — add validation to existing handlers, change `open-path` → `open-file`
- `src/shared/types.ts` — update `ElectronAPI` (`openFile(meetName, filename)` replaces `openPath(filePath)`)
- `src/preload/preload.ts` — update bridge

**Acceptance criteria:**
- [ ] All IPC handlers that accept `meetName` validate with `assertSafeMeetName`
- [ ] `open-file` handler returns `shell.openPath()` result (not discarding it)
- [ ] Path traversal via `meetName` or `filename` is blocked
- [ ] Existing functionality preserved with new validation

---

#### Phase 1: Unified Meet List + Tab Shell

**Goal:** Replace Cloud Meets with My Meets showing both local and cloud meets in one merged list.

**New IPC handler: `list-unified-meets`** in `src/main/main.ts`
- Scan `configStore.get('outputDir')` for subdirectories
- Filter to directories containing recognized output files by **explicit filename match** (not glob)
- Fetch cloud meets from Supabase (if enabled, with error handling)
- Merge by exact `meet_name` match into `UnifiedMeet[]`
- Sort by most recently modified
- Return single payload: `{ success: boolean; meets: UnifiedMeet[]; cloudError?: string }`

**Institutional learning:** `stale-extract-files-cause-data-bloat.md` — Scanner must use explicit filename matching against known output files (`back_of_shirt.pdf`, `order_forms.pdf`, etc.), not a broad glob. Stale files from prior runs would otherwise appear as valid artifacts.

**Recognized output filenames:**
```typescript
const RECOGNIZED_OUTPUT_FILES = [
  'back_of_shirt.pdf', 'back_of_shirt_8.5x14.pdf',
  'back_of_shirt.idml', 'back_of_shirt_8.5x14.idml',
  'order_forms.pdf',
  'gym_highlights.pdf', 'gym_highlights_8.5x14.pdf',
  'meet_summary.txt',
];
```

**New types in `src/shared/types.ts`:**
```typescript
interface LocalMeet {
  meet_name: string;  // aligned with CloudMeet naming
  fileCount: number;
  modified: string;   // ISO date, aligned with OutputFile.modified
}

// Proper discriminated union — prevents contradictory states
type UnifiedMeet =
  | { meet_name: string; source: 'local';  local: LocalMeet; cloud?: never }
  | { meet_name: string; source: 'cloud';  cloud: CloudMeet; local?: never }
  | { meet_name: string; source: 'both';   local: LocalMeet; cloud: CloudMeet };
```

**New component: `MyMeetsTab.tsx`** in `src/renderer/components/`
- Fetch unified list from single IPC call on mount
- Show source badges: `LOCAL` (green), `CLOUD` (blue), `LOCAL + CLOUD` (both)
- State/year filters carry over from CloudMeetsTab for cloud meets
- Show `cloudError` as warning banner when cloud fetch fails but local meets display
- Pass `isActive` prop from App.tsx for tab-visibility-aware refreshing

**New component: `MeetDetailView.tsx`** in `src/renderer/components/`
- Extracted detail view (file list + actions)
- Receives `UnifiedMeet` and renders file list with actions
- Handles both local and cloud files

**Update `src/renderer/App.tsx`:**
- Replace `'cloud'` tab key with `'my-meets'`
- Pass `isActive={activeTab === 'my-meets'}` prop to MyMeetsTab
- Replace "Cloud Meets" label with "My Meets"

**Performance insight:** Fire local scan and cloud fetch in parallel with `Promise.all`. Local scan completes in <100ms for 50 directories. Cloud fetch is async — if it fails, local meets still display immediately.

**Files changed:**
- `src/main/main.ts` — add `list-unified-meets` IPC handler
- `src/shared/types.ts` — add `LocalMeet`, `UnifiedMeet`, update `ElectronAPI`
- `src/preload/preload.ts` — add `listUnifiedMeets` bridge
- `src/renderer/components/MyMeetsTab.tsx` — new file
- `src/renderer/components/MeetDetailView.tsx` — new file
- `src/renderer/App.tsx` — replace cloud tab with my-meets, pass isActive
- `src/renderer/styles/app.css` — rename/extend cloud-meets CSS section
- Delete `src/renderer/components/CloudMeetsTab.tsx`

**Acceptance criteria:**
- [ ] My Meets tab shows all local meets from the output directory
- [ ] My Meets tab shows all cloud meets from Supabase (when enabled)
- [ ] Meets existing in both show a combined badge
- [ ] Empty state shows "Process your first meet" guidance
- [ ] Cloud fetch failure shows warning but still displays local meets
- [ ] List sorted by most recently modified
- [ ] Only directories with recognized output files appear as meets

---

#### Phase 2: Enhanced File Detail View

**Goal:** Make files clickable with per-file actions (Open, Show in Explorer) and human-readable labels.

**Update MeetDetailView component:**
- Local files: click to Open (`openFile(meetName, filename)`), button to Show in Explorer
- Cloud files: download-then-open (port existing `handleOpen`/`handleDownload` from CloudMeetsTab)
- Display human-readable labels alongside filenames:

| Filename | Display Label |
|----------|---------------|
| `back_of_shirt.pdf` | Shirt Back (letter) |
| `back_of_shirt_8.5x14.pdf` | Shirt Back (legal) |
| `back_of_shirt.idml` | Shirt Back — InDesign (letter) |
| `back_of_shirt_8.5x14.idml` | Shirt Back — InDesign (legal) |
| `order_forms.pdf` | Order Forms |
| `gym_highlights.pdf` | Gym Highlights (letter) |
| `gym_highlights_8.5x14.pdf` | Gym Highlights (legal) |
| `meet_summary.txt` | Meet Summary |

**Surface file operation errors:**
- `openFile` now returns `{ success, error }` — show inline error message
- "No app registered for this file type" when `shell.openPath()` returns an error (common for `.idml` on machines without InDesign)
- Download errors rendered as visible inline messages (not silently swallowed like CloudMeetsTab)

**Retain cloud-specific actions:**
- "Pull to Local DB" button — shown only when meet has cloud data
- "Download All Files" button — shown only for cloud meets
- Parallelize downloads with `Promise.all` instead of sequential loop

**Files changed:**
- `src/renderer/components/MeetDetailView.tsx` — per-file actions, labels, error display
- `src/renderer/styles/app.css` — file action button styles

**Acceptance criteria:**
- [ ] Each file in the list is clickable to open in default app
- [ ] "Show in Explorer" button highlights the file in its folder
- [ ] File labels are human-readable (not raw filenames)
- [ ] Open errors show a user-friendly message
- [ ] Cloud-specific actions only appear for cloud meets

---

#### Phase 3: Print Integration

**Goal:** Print PDFs directly from the app via the Windows print dialog.

**New IPC handler: `print-file`** in `src/main/main.ts`
- Accepts `{meetName, filename}` (not raw path — security)
- Validates with `assertSafeMeetName` and `assertSafeFilename`
- Resolves path and verifies it's inside outputDir
- Uses PowerShell with **argument array** (no string interpolation — prevents command injection):

```typescript
import { spawn } from 'child_process';

ipcMain.handle('print-file', async (_event, meetName: string, filename: string) => {
  assertSafeMeetName(meetName);
  assertSafeFilename(filename);
  const filePath = path.join(getOutputDir(meetName, false), filename);
  if (!filePath.endsWith('.pdf')) return { success: false, error: 'Only PDF files can be printed' };
  if (!fs.existsSync(filePath)) return { success: false, error: 'File not found' };

  return new Promise((resolve) => {
    const child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      'Start-Process', '-FilePath', filePath, '-Verb', 'Print'
    ], { detached: true, stdio: 'ignore' });

    child.on('error', (err) => resolve({ success: false, error: 'Print failed. Check your PDF viewer.' }));
    child.unref();
    // Return immediately — print dialog is async
    resolve({ success: true });
  });
});
```

**Research insights:**
- `webContents.print()` **cannot print PDF files** (confirmed Electron bug [#26448](https://github.com/electron/electron/issues/26448))
- PowerShell `Start-Process -Verb Print` behavior varies by PDF viewer: Edge may print silently (no dialog) on Windows 11
- Use `spawn` with `detached: true` (not `exec`) — avoids extra `cmd.exe` wrapper process
- PowerShell startup takes 300-800ms — acceptable for a user-initiated print action
- If more reliable printing is needed later, bundle SumatraPDF as an `extraResource` (~10MB)

**For cloud-only PDFs:** Download first (to local output dir), then print from local path.

**Edge cases:**
- Print dialog cancelled by user → no-op (handled by OS)
- No PDF viewer installed → `spawn` error callback, surface error to user
- File doesn't exist on disk → pre-checked before spawning
- Edge on Windows 11 may skip print dialog → known limitation, acceptable

**Files changed:**
- `src/main/main.ts` — add `print-file` IPC handler
- `src/shared/types.ts` — add `printFile(meetName, filename)` to `ElectronAPI`
- `src/preload/preload.ts` — add `printFile` bridge
- `src/renderer/components/MeetDetailView.tsx` — Print button on PDF rows

**Acceptance criteria:**
- [ ] Print button appears on PDF files only
- [ ] Clicking Print opens Windows print dialog (via PowerShell)
- [ ] Error shown if print fails (no PDF viewer, missing file)
- [ ] Cloud PDFs are downloaded before printing
- [ ] No command injection possible via file path

---

#### Phase 4: Email Integration (Send to Designer)

**Goal:** One-click email of IDML files to the designer via SMTP.

**Install dependency:**
```bash
npm install nodemailer
npm install -D @types/nodemailer
```

**Lazy-load nodemailer** in the IPC handler (consistent with how Supabase is loaded):
```typescript
const nodemailer = await import('nodemailer');
```

**New config fields** in `src/main/config-store.ts` (`AppConfig` interface):
```typescript
smtpHost: string;       // e.g., 'smtp.gmail.com'
smtpPort: number;       // default: 587
smtpUser: string;       // sender email address
smtpPassword: string;   // app password (MUST add to SENSITIVE_KEYS)
designerEmail: string;  // recipient address
```

**Critical checklist for config changes:**
- [ ] Add fields to `AppConfig` interface
- [ ] Add fields to `AppSettings` interface (must stay in sync)
- [ ] Add defaults to `DEFAULTS` object (smtpPort: 587, etc.)
- [ ] Add `smtpPassword` to `SENSITIVE_KEYS` for encryption at rest
- [ ] Add all new fields to `setAll()` whitelist (hardcoded array)
- [ ] Update `getAll()` to include new fields

**Settings UI** in `src/renderer/components/SettingsTab.tsx`:
- New "Email Settings" section with fields for all SMTP config + designer email
- **Provider auto-detect:** When user enters their email in `smtpUser`, auto-fill host/port:
  - `@gmail.com` / `@googlemail.com` → `smtp.gmail.com:587`
  - `@outlook.com` / `@hotmail.com` / `@live.com` → `smtp-mail.outlook.com:587`
- **Setup instructions** (plain English):
  > For Gmail, use smtp.gmail.com port 587. You'll need an App Password:
  > 1. Go to myaccount.google.com → Security → 2-Step Verification (turn on if off)
  > 2. Go to myaccount.google.com → Security → App Passwords
  > 3. Generate a password for "Mail" — copy the 16-character code
  > 4. Paste that code here (not your regular Gmail password)
- **"Test Connection" button** — uses `transporter.verify()` for quick check
- **"Send Test Email" button** — sends a test message to the designer email
- **Warning if safeStorage unavailable:** "Encryption not available on this system. Password cannot be stored securely."

**New file: `src/main/smtp-service.ts`** — Isolate all SMTP logic:
```typescript
import type { Transporter } from 'nodemailer';

interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  password: string;
}

// Create transport with secure defaults
function createTransport(config: SmtpConfig): Transporter {
  const nodemailer = require('nodemailer');
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: false,          // STARTTLS on port 587
    requireTLS: true,       // FAIL if TLS upgrade refused — never send cleartext
    auth: { user: config.user, pass: config.password },
    connectionTimeout: 30_000,
    greetingTimeout: 15_000,
    socketTimeout: 120_000, // generous for large IDML attachments
  });
}

// Map SMTP errors to user-friendly messages — NEVER forward raw err.message
function classifySmtpError(err: Error): string {
  const msg = err.message.toLowerCase();
  if (msg.includes('auth') || msg.includes('535') || msg.includes('username'))
    return 'Email login failed. Check your password in Settings.';
  if (msg.includes('534') || msg.includes('application-specific'))
    return 'Gmail requires an App Password, not your regular password. See setup instructions.';
  if (msg.includes('550 5.7.30'))
    return 'Microsoft 365 has disabled basic SMTP auth. Contact your IT administrator.';
  if (msg.includes('timeout') || msg.includes('econnrefused') || msg.includes('enotfound'))
    return 'Could not connect to email server. Check your internet and SMTP settings.';
  if (msg.includes('starttls'))
    return 'TLS upgrade failed. The server may require a different port.';
  return 'Email send failed. Check your SMTP settings.';
}
```

**Attachment handling:**
- Use `path:` property (streamed from disk, never buffered in memory)
- Pre-check total attachment size: safe limit is ~18MB (Gmail's 25MB minus base64 overhead)
- Content type: `application/octet-stream` (IDML has no standard MIME type)

**New IPC handler: `send-to-designer`** in `src/main/main.ts`
- Accepts `meetName: string`
- Validates with `assertSafeMeetName`
- Finds all IDML files in the meet's output directory
- Strips CRLF from meetName before using in email subject (header injection prevention)
- Sends email with all IDML files attached
- **Subject:** `"Shirt back files: {meetName}"`
- **Body:** `"Attached are the InDesign files for {meetName}. Please edit and return the finished PDF."`
- Returns `{ success, error? }` — error is always a translated user-friendly message

**New IPC handler: `test-email`** in `src/main/main.ts`
- Uses `transporter.verify()` for connection test
- Sends brief test email to designer address for full test

**UI in MeetDetailView:**
- "Send to Designer" button at the meet level (not per-file)
- Only shown when the meet has IDML files locally
- Disabled with message if email not configured: "Set up email in Settings first"
- **Confirmation dialog** before sending: "Send {n} IDML file(s) to {designerEmail}?"
- Success toast after send
- Error message on failure (translated, non-technical)
- Button disabled during send (prevents double-send)

**Research insight — Outlook deprecation:** Microsoft 365 is deprecating basic SMTP auth by H2 2027. App passwords work now, but plan for OAuth2 later if corporate Outlook users need support.

**Files changed:**
- `package.json` — add nodemailer dependency
- `src/main/smtp-service.ts` — new file (SMTP logic isolated)
- `src/main/config-store.ts` — add SMTP + designer email fields
- `src/shared/types.ts` — update `AppConfig`, `AppSettings`, `ElectronAPI`
- `src/main/main.ts` — add `send-to-designer` and `test-email` IPC handlers
- `src/preload/preload.ts` — add `sendToDesigner`, `testEmail` bridges
- `src/renderer/components/SettingsTab.tsx` — email settings section
- `src/renderer/components/MeetDetailView.tsx` — Send to Designer button + confirmation

**Acceptance criteria:**
- [ ] Email settings configurable in Settings tab with provider auto-detect
- [ ] Test connection and test email buttons verify configuration
- [ ] SMTP password encrypted at rest (safeStorage)
- [ ] App refuses to save password if encryption unavailable (with warning)
- [ ] Send to Designer attaches all IDML files for the meet
- [ ] Attachment size pre-checked against 18MB safe limit
- [ ] Confirmation dialog prevents accidental sends
- [ ] Success/failure feedback is clear and non-technical (never raw SMTP errors)
- [ ] Button disabled when email not configured or no IDML files
- [ ] `requireTLS: true` prevents cleartext email transmission

---

#### Phase 5: Import PDF Back + Auto-Refresh + Polish

**Goal:** Complete the workflow with import and quality-of-life improvements.

**Import PDF Back in MeetDetailView:**
- "Import Designer's PDF" button in the detail view for each meet
- Opens file picker (multi-select PDFs, reusing existing `browseFiles` API)
- Calls `window.electronAPI.processMeet(filePath)` directly — **does not delegate to ProcessTab**
- Must query `is-agent-running` IPC before starting (defense in depth: main process also guards)
- After import, refresh the file list for that meet

**IPC query: `is-agent-running`** in `src/main/main.ts`
- Returns `{ success: boolean; running: boolean }` (consistent envelope pattern)
- Queries `activeAgentLoop` state directly — the authoritative source
- Main process `process-meet` handler also guards: `if (activeAgentLoop?.isRunning()) return { success: false, error: 'Agent is currently running' }`

**Auto-refresh on processing completion:**
- Emit `meet-processed` IPC push event from `main.ts` after agent completion
- **Include meet name in payload:** `mainWindow.webContents.send('meet-processed', { meetName })`
- MyMeetsTab subscribes in `useEffect` with proper cleanup:
```typescript
const cleanupRef = useRef<(() => void) | null>(null);
useEffect(() => {
  cleanupRef.current = window.electronAPI.onMeetProcessed(({ meetName }) => {
    loadMeets(); // full refresh, or targeted if detail view is showing this meet
  });
  return () => { cleanupRef.current?.(); };
}, []);
```

**Tab-aware refreshing:**
- App.tsx passes `isActive` prop to MyMeetsTab
- MyMeetsTab re-fetches on tab activation if data is stale (>60s):
```typescript
const lastFetchRef = useRef<number>(0);
useEffect(() => {
  if (!isActive) return;
  if (Date.now() - lastFetchRef.current > 60_000) {
    loadMeets().then(() => { lastFetchRef.current = Date.now(); });
  }
}, [isActive]);
```

**Post-process navigation hint:**
- After agent completes in ProcessTab, show "View files in My Meets →" link
- App.tsx passes `setActiveTab` callback as prop to ProcessTab
- Clicking the link calls `setActiveTab('my-meets')`

**OutputFiles component update:**
- Add "View all in My Meets →" link alongside existing "Open Folder" button

**Files changed:**
- `src/renderer/components/MeetDetailView.tsx` — Import button, guard check
- `src/renderer/components/MyMeetsTab.tsx` — auto-refresh listener, stale check
- `src/main/main.ts` — `is-agent-running` handler, `meet-processed` event emission
- `src/shared/types.ts` — update `ElectronAPI` with new methods
- `src/preload/preload.ts` — add bridges for new IPC, `onMeetProcessed` with cleanup return
- `src/renderer/App.tsx` — pass `isActive` and `setActiveTab` callback props
- `src/renderer/components/ProcessTab.tsx` — "View in My Meets" link after processing
- `src/renderer/components/OutputFiles.tsx` — add "View all in My Meets" link

**Acceptance criteria:**
- [ ] Import PDF Back button opens file picker for PDFs
- [ ] Import blocked while agent is already running (both client + server guard)
- [ ] File list refreshes after successful import
- [ ] My Meets list auto-refreshes when a meet finishes processing
- [ ] Tab re-fetches data on activation if stale (>60s)
- [ ] ProcessTab shows "View in My Meets" link after completion
- [ ] IPC listener cleanup prevents memory leaks

---

## System-Wide Impact

### Interaction Graph

- **MyMeetsTab** calls IPC handlers: `list-unified-meets`, `get-output-files`, `open-file`, `show-in-folder`, `print-file`, `send-to-designer`, `download-cloud-file`, `pull-cloud-meet`, `is-agent-running`
- **Settings changes** to email config affect `send-to-designer` handler behavior
- **Process completion** in `main.ts` triggers `meet-processed` event → MyMeetsTab refresh
- **Import PDF Back** from MeetDetailView triggers the same `process-meet` IPC handler as ProcessTab

### Error Propagation

- IPC errors surface as `{ success: false, error: string }` → rendered as inline messages
- SMTP errors caught by nodemailer → translated via `classifySmtpError()` → never raw to renderer
- `shell.openPath()` errors returned as strings → rendered as inline message
- Supabase fetch errors → `cloudError` in unified response, local meets still displayed
- Path traversal attempts → blocked by `assertSafeMeetName` before reaching filesystem

### State Lifecycle Risks

- **Stale file list:** If files are deleted externally while viewing, Open/Print will fail. Mitigated by showing error message.
- **Concurrent agent runs:** Import from My Meets while Process tab is running could corrupt state. Mitigated by `is-agent-running` guard in both renderer (pre-check) and main process (authoritative guard).
- **Partial SMTP config:** User saves some but not all email fields. Mitigated by validating all required fields before enabling Send button.
- **Listener leaks:** IPC listeners registered in `useEffect` without cleanup accumulate during hot-reload. Mitigated by cleanup-return pattern with `cleanupRef`.

### API Surface Parity

- `ElectronAPI` interface in `src/shared/types.ts` must be updated with all new methods
- `AppConfig` and `AppSettings` must stay in sync with new email fields
- `setAll()` whitelist must include all new config keys
- `SENSITIVE_KEYS` must include `smtpPassword`
- Preload bridge must expose all new IPC channels

## Alternative Approaches Considered

1. **Separate Files tab (keep Cloud Meets as-is):** Rejected because it adds a 5th tab and creates two similar-but-different file browsing experiences. (See brainstorm)

2. **Embedded PDF viewer:** Rejected for v1. `webContents.print()` cannot print PDFs (Chromium bug), and building a pdf.js viewer adds bundle complexity. Default Windows PDF viewer works fine. (See brainstorm + research)

3. **Cloud-based designer portal:** Rejected. Over-engineered for a single-designer workflow. (See brainstorm)

4. **Pre-filled email client (mailto:):** Rejected. `mailto:` doesn't support attachments reliably on Windows. (See brainstorm)

5. **Merge logic in renderer:** Rejected after architecture review. Two loading states create complexity; single IPC handler is simpler and testable.

6. **Lift `isProcessing` to App.tsx:** Rejected after architecture review. Agent loop in main process is authoritative source; renderer state can diverge on crash/reload. IPC query is more reliable.

7. **Bundle SumatraPDF for printing:** Deferred. PowerShell approach is simpler for v1. SumatraPDF (~10MB binary) can be added later for more reliable cross-viewer printing.

## Acceptance Criteria

### Functional Requirements

- [ ] My Meets tab replaces Cloud Meets in the tab bar
- [ ] Local meets from output directory are listed (recognized files only)
- [ ] Cloud meets from Supabase are listed (when enabled)
- [ ] Meets in both local and cloud show combined indicator
- [ ] Clicking a meet shows its files with human-readable labels
- [ ] Files can be opened in the default OS app
- [ ] Files can be revealed in Windows Explorer
- [ ] PDF files can be printed via Windows print dialog
- [ ] IDML files can be emailed to the designer with one click
- [ ] Designer's edited PDF can be imported back for a specific meet
- [ ] Email settings configurable in Settings tab with test button
- [ ] File list refreshes automatically after processing completes
- [ ] Error messages are clear and non-technical

### Non-Functional Requirements

- [ ] Local meet scanning completes in <1 second for 50 meets
- [ ] Cloud fetch failure does not block local meet display
- [ ] SMTP password encrypted at rest in config store
- [ ] Path traversal blocked on all IPC handlers accepting meetName/filename
- [ ] No command injection possible via PowerShell print handler
- [ ] SMTP errors never forwarded raw to renderer
- [ ] Email transmission requires TLS (requireTLS: true)
- [ ] Email send timeout of 30 seconds with user feedback

## Dependencies & Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| PowerShell `Start-Process -Verb Print` behavior varies by PDF viewer | Medium | Print dialog may not appear on Edge/Win11 | Document limitation; bundle SumatraPDF later if needed |
| Gmail/Outlook SMTP requires App Passwords or OAuth | Medium | Email setup friction for user | Provider auto-detect + clear setup instructions in Settings UI |
| IDML files exceed 18MB safe attachment limit | Low | Email send fails | Pre-check file size, warn user before sending |
| Local folder name doesn't match cloud meet name | Low | Meet appears as two entries | Rely on existing name normalization; single canonical identifier |
| Agent state not properly shared between tabs | Medium | Double-run or blocked import | IPC query to main process + server-side guard (defense in depth) |
| Microsoft 365 deprecates basic SMTP auth | Medium (H2 2027) | Outlook users can't send email | Plan OAuth2 support before deprecation date |
| safeStorage unavailable on some systems | Low | Can't store SMTP password | Refuse save + show warning; user must re-enter each session |

## Sources & References

### Origin

- **Brainstorm document:** [docs/brainstorms/2026-03-31-my-meets-file-hub-brainstorm.md](docs/brainstorms/2026-03-31-my-meets-file-hub-brainstorm.md) — Key decisions: combine Cloud+Local into unified tab, fully automated email, print with dialog, no file deletion, exact name matching

### Institutional Learnings Applied

- `docs/solutions/logic-errors/output-name-meet-name-must-match.md` — Single canonical meet identifier prevents path divergence
- `docs/solutions/logic-errors/stale-extract-files-cause-data-bloat.md` — Explicit filename matching prevents stale file contamination
- `docs/solutions/logic-errors/persist-destructive-operation-guards.md` — New flags that gate operations must be persisted

### Internal References

- CloudMeetsTab (foundation): `src/renderer/components/CloudMeetsTab.tsx`
- OutputFiles component: `src/renderer/components/OutputFiles.tsx`
- IPC file handlers: `src/main/main.ts:351-462`
- Output directory logic: `src/main/paths.ts:30-37`
- Config store: `src/main/config-store.ts:6-17` (AppConfig), `33` (SENSITIVE_KEYS)
- Preload bridge: `src/preload/preload.ts:61-127`
- Shared types: `src/shared/types.ts:12-88`
- Tab structure: `src/renderer/App.tsx:7-58`
- CSS (Cloud Meets section): `src/renderer/styles/app.css:1020-1299`

### External References

- Electron `shell.openPath` does not return errors: [electron/electron#26448](https://github.com/electron/electron/issues/26448)
- Electron `webContents.print()` cannot print PDF files: [electron/electron#26498](https://github.com/electron/electron/issues/26498)
- nodemailer SMTP configuration: https://nodemailer.com/smtp/
- Gmail App Passwords: https://support.google.com/accounts/answer/185833
- Microsoft SMTP deprecation timeline: Microsoft Tech Community, January 2026
