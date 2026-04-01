---
title: "feat: Email relay API + Report Issue + Send to Designer via Postmark"
type: feat
status: active
date: 2026-04-01
---

# Email Relay API + Report Issue + Send to Designer via Postmark

## Overview

Replace the user-configured SMTP email system with a zero-config Postmark relay through the existing Vercel-hosted website. Add a "Report Issue" feature that lets users send process logs with context notes in one click. Both features route through a single new API endpoint, requiring no email configuration from end users.

## Problem Frame

The current "Send to Designer" flow requires each user to configure their own SMTP credentials (host, port, email, app password) in Settings. This is high-friction, error-prone (Gmail app passwords, M365 basic auth blocks), and unnecessary since all emails go to the same two recipients. Users also have no easy way to send process logs when issues occur — they have to manually find the file and email it, which means bug reports rarely happen.

## Requirements Trace

- R1. Send IDML files to designer (chn@netscape.com) from the meet detail view with zero email config
- R2. Send process logs to dowdy@marketdriveauto.com with a required context note
- R3. Report Issue button appears on process_log.md file row in MeetDetailView AND in the Process Meet tab
- R4. Report Issue shows a modal popup with required textarea before send is possible
- R5. All emails sent from sales@thestatechampion.com via Postmark (server-side only)
- R6. API route secured with a shared secret (not user credentials)
- R7. Success/error feedback shown to user after each send

## Scope Boundaries

- No user-facing email configuration (SMTP settings removed from Settings)
- No email templates — plain text body is sufficient for both email types
- No email history/tracking in a database
- No retry logic for failed sends — user can retry manually
- Process log for Report Issue from ProcessTab uses the most recent log from the active or last session

## Context & Research

### Relevant Code and Patterns

- **Postmark lib**: `website/src/lib/postmark.ts` — singleton client via lazy init, `sendBatchEmails()` only. Need to add `sendEmail()` for single messages
- **API route pattern**: `website/src/app/api/admin/email-blast/route.ts` — best example: auth guard → parse body → call service → return JSON
- **IPC handler pattern**: `src/main/main.ts` — `ipcMain.handle('name', async (_event, args) => { try { return { success, data } } catch { return { success, error } } })`
- **Preload bridge**: `src/preload/preload.ts` — `contextBridge.exposeInMainWorld('electronAPI', {...})`
- **Shared types**: `src/shared/types.ts` — `ElectronAPI` interface must match preload exactly
- **Config store**: `src/main/config-store.ts` — singleton, `safeStorage` encryption for sensitive keys
- **Existing SMTP service**: `src/main/smtp-service.ts` — three functions, nodemailer transport, 18MB guard, error classifier
- **Existing Send to Designer UI**: `src/renderer/components/MeetDetailView.tsx` — inline confirm dialog pattern (not a modal overlay)
- **ProcessTab buttons**: `src/renderer/components/ProcessTab.tsx` — button row at lines 348-381 (Process Meet, Stop, Import PDF, Clear)
- **Modal pattern**: `div.ask-user-overlay > div.ask-user-modal` — full-screen overlay with centered box (used by agent ask-user)
- **Path security**: `src/main/paths.ts` — `assertSafeMeetName` / `assertSafeFilename` must be used, never accept raw renderer paths

### Institutional Learnings

- IPC handlers must accept semantic IDs (meetName), reconstruct paths in main process — never forward raw renderer paths (`docs/solutions/security-issues/ipc-handlers-must-not-accept-raw-paths-from-renderer.md`)
- Config store sensitive keys use `enc:` prefix via `encryptValue`/`decryptValue` helpers — never call `safeStorage` directly (`docs/solutions/runtime-errors/electron-safestorage-double-encryption-race.md`)
- IPC handlers return `{ success: boolean, error?: string }` consistently (`docs/solutions/runtime-errors/shell-openpath-returns-error-string-not-throws.md`)

## Key Technical Decisions

- **Postmark over direct SMTP**: Postmark is already integrated in the website with a verified domain. No new service to set up. Attachment limit is 10MB per message (tighter than the old 18MB SMTP guard but sufficient — IDML files are typically 50-200KB)
- **Single API route for both email types**: One `POST /api/send-email` route handles both `type: 'designer'` and `type: 'report'`. The route hardcodes the recipient addresses — the client never specifies who receives the email. This prevents abuse even if the API key leaks.
- **Hardcoded API key in Electron binary**: The relay secret grants access only to send to two hardcoded addresses through a controlled relay. The repo is private, the app is distributed to a small trusted team. Risk is minimal — worst case someone spams those two addresses. The actual Postmark API key stays server-side only.
- **Sender address**: `sales@thestatechampion.com`. The domain `thestatechampion.com` is already verified in Postmark (since `orders@` works). Any address on the domain should work without additional verification. If not, fall back to `orders@`.
- **Base64 attachments in JSON body**: IDML files are small (50-200KB), process logs are tiny (<100KB). Even with 33% base64 overhead, we're well under Vercel's 4.5MB default body limit. No need to raise it or use upload-then-link pattern. Add a client-side pre-flight check at 4MB total payload as a safety net.
- **Delete old SMTP code**: The nodemailer SMTP service, SMTP config fields in Settings, and test-email handler are fully replaced. No fallback path.
- **Overlay modal for Report Issue**: Follow the existing `ask-user-overlay` pattern (full-screen overlay + centered box) rather than inline confirmation. This matches the spec requirement of a "popup modal" and provides a better UX for the required textarea.

## Open Questions

### Resolved During Planning

- **Which Postmark stream?** `outbound` (transactional) — not `broadcasts`. Both email types are transactional one-off messages.
- **Which log file for ProcessTab Report Issue?** The IPC handler checks for an active agent context's `logPath` first; if no active run, scans `data/logs/` for the most recently modified `.md` file. If neither exists, sends the email with only the user's note (no attachment) and notes "No log file available" in the email body.
- **What if process_log.md doesn't exist in MeetDetailView?** The Report Issue button only appears on the process_log.md file row. If the file doesn't exist, the row doesn't exist, so the button doesn't appear. No special handling needed.
- **Should the confirmation dialog list IDML filenames?** Yes — list actual filenames so the user knows exactly what they're sending (especially when both letter and legal variants exist).

### Deferred to Implementation

- **Exact Postmark sender signature status for sales@**: Verify during implementation. If `sales@` bounces, use `orders@` as fallback.
- **ProcessTab log path resolution edge cases**: The exact logic for finding the "current" log file when multiple sessions have run may need refinement during implementation.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```
Electron App                        Vercel Website
─────────────                       ──────────────

[MeetDetailView]                    POST /api/send-email
  "Send to Designer"                  ├─ validate x-api-key header
  → IPC: send-to-designer             ├─ parse body: { type, meetName, note?, attachments[] }
  → read .idml files                  ├─ if type=designer → to: chn@netscape.com
  → base64 encode                     ├─ if type=report  → to: dowdy@marketdriveauto.com
  → fetch(API_URL, { body })   ────►  ├─ call postmark.sendEmail({...})
  ← { success }               ◄────  └─ return { success }
  → show toast

[ProcessTab]                        
  "Report Issue"                    
  → show ReportIssueModal          
  → user writes note               
  → IPC: send-report-issue         
  → read latest log file           
  → base64 encode                  
  → fetch(API_URL, { body })  ────►  (same route)
  ← { success }               ◄────
  → close modal, show toast        

[MeetDetailView / process_log.md row]
  "Report Issue"
  → same modal + IPC flow as ProcessTab
```

## Implementation Units

- [ ] **Unit 1: Add sendEmail to Postmark lib**

  **Goal:** Extend the existing Postmark client with a single-message send function that supports attachments.

  **Requirements:** R5

  **Dependencies:** None

  **Files:**
  - Modify: `website/src/lib/postmark.ts`

  **Approach:**
  - Add `sendEmail({ to, subject, htmlBody, textBody, attachments?, from?, stream? })` alongside existing `sendBatchEmails`
  - Attachments use Postmark's `Attachments` array format: `{ Name, Content (base64), ContentType }`
  - Default `from` to `sales@thestatechampion.com` (new env var `POSTMARK_RELAY_FROM` or hardcoded)
  - Default `stream` to `outbound`

  **Patterns to follow:**
  - Existing `sendBatchEmails` in same file — lazy client init, error handling

  **Test scenarios:**
  - Happy path: sendEmail with text body and one attachment calls Postmark client with correct shape
  - Happy path: sendEmail without attachments omits Attachments field
  - Edge case: missing `to` throws before calling Postmark

  **Verification:** Function exported, TypeScript compiles, matches Postmark SDK's `sendEmail` contract

- [ ] **Unit 2: Create POST /api/send-email route**

  **Goal:** API endpoint that receives email requests from the Electron app and forwards them through Postmark.

  **Requirements:** R1, R2, R5, R6

  **Dependencies:** Unit 1

  **Files:**
  - Create: `website/src/app/api/send-email/route.ts`
  - Modify: `website/.env.local` (add `RELAY_API_SECRET`)
  - Modify: `website/.env.example` (add `RELAY_API_SECRET` placeholder)

  **Approach:**
  - Validate `x-api-key` header against `RELAY_API_SECRET` env var using constant-time comparison
  - Parse JSON body: `{ type: 'designer' | 'report', meetName: string, note?: string, attachments?: Array<{ filename, content, contentType }> }`
  - Route by type: `designer` → `chn@netscape.com`, `report` → `dowdy@marketdriveauto.com`
  - Sanitize meetName (strip CRLF, trim)
  - Build subject line: `[CHP] {meetName} — Designer Files` or `[CHP] Issue Report — {meetName}`
  - For reports: include the user's note in the email body
  - Call `sendEmail` from Unit 1
  - Return `{ success: true }` or `{ success: false, error: string }`
  - Total payload size guard: reject if body exceeds 4MB with a clear error

  **Patterns to follow:**
  - `website/src/app/api/admin/email-blast/route.ts` — auth check → parse → service call → response

  **Test scenarios:**
  - Happy path: designer type with valid key sends to chn@netscape.com with IDML attachments
  - Happy path: report type with valid key sends to dowdy@marketdriveauto.com with log + note in body
  - Error path: missing or wrong x-api-key returns 401
  - Error path: missing `type` field returns 400
  - Error path: body over 4MB returns 413 with descriptive message
  - Edge case: meetName with CRLF characters is sanitized
  - Edge case: report type with no attachments (no log file available) still sends with note only

  **Verification:** Route responds correctly to curl with valid/invalid keys; Postmark receives the email in test mode

- [ ] **Unit 3: Create email-relay service in Electron**

  **Goal:** Replace nodemailer SMTP service with an HTTP client that calls the Vercel API route.

  **Requirements:** R1, R2, R6

  **Dependencies:** Unit 2

  **Files:**
  - Create: `src/main/email-relay.ts`
  - Delete: `src/main/smtp-service.ts`

  **Approach:**
  - Single exported function: `sendViaRelay({ type, meetName, note?, attachments? })` → `Promise<{ success, error? }>`
  - Hardcode `API_URL` (the Vercel website URL + `/api/send-email`) and `API_KEY` (the relay secret)
  - Use Node.js native `fetch` (available in Electron 28 / Node 18+)
  - Pre-flight size check: sum base64 attachment sizes, reject if > 4MB with clear error
  - Timeout: 30 seconds
  - Error classification: network errors, HTTP errors (401/413/500), Postmark errors (from response body)
  - No SMTP config needed, no user credentials needed

  **Patterns to follow:**
  - Existing `smtp-service.ts` for function signature shape and error classification approach
  - Return `{ success, error? }` matching IPC handler convention

  **Test scenarios:**
  - Happy path: sends POST with correct headers and body shape
  - Error path: network failure returns friendly error message
  - Error path: 401 response returns "authentication failed" message
  - Error path: pre-flight size check rejects oversized attachments before making HTTP call
  - Edge case: timeout after 30 seconds returns timeout error

  **Verification:** Function exported, TypeScript compiles, matches expected interface for IPC handlers

- [ ] **Unit 4: Update IPC handlers and preload**

  **Goal:** Wire up the new email relay to the renderer via IPC. Replace old SMTP handler, add new report-issue handler.

  **Requirements:** R1, R2, R3, R7

  **Dependencies:** Unit 3

  **Files:**
  - Modify: `src/main/main.ts` (replace `send-to-designer` handler, add `send-report-issue` handler, remove `test-email` handler)
  - Modify: `src/preload/preload.ts` (update `sendToDesigner`, add `sendReportIssue`, remove `testEmail`)
  - Modify: `src/shared/types.ts` (update `ElectronAPI` interface)

  **Approach:**
  - `send-to-designer` handler: accepts `meetName`, uses `assertSafeMeetName`, finds `.idml` files in meet output dir, reads + base64-encodes each, calls `sendViaRelay({ type: 'designer', meetName, attachments })`
  - `send-report-issue` handler: accepts `{ meetName, note, logSource }`. If `logSource === 'active'`, reads from active agent's log path; if `logSource === 'meet'`, reads `process_log.md` from meet output dir. Base64-encodes log, calls `sendViaRelay({ type: 'report', meetName, note, attachments })`
  - Remove `test-email` handler and `testEmail` from preload
  - `sendReportIssue` preload: `(meetName, note, logSource) => ipcRenderer.invoke('send-report-issue', meetName, note, logSource)`

  **Patterns to follow:**
  - Existing IPC handler shape in `main.ts`: try/catch → `{ success, error? }`
  - `assertSafeMeetName` for path security
  - Lazy import pattern for the relay service

  **Test scenarios:**
  - Happy path: send-to-designer finds IDML files, encodes them, calls relay
  - Happy path: send-report-issue reads log from meet dir, sends with note
  - Happy path: send-report-issue with logSource='active' reads from active agent log path
  - Error path: no IDML files found returns descriptive error
  - Error path: log file not found sends email with note only, no attachment
  - Edge case: meetName with path traversal characters rejected by assertSafeMeetName

  **Verification:** Handlers registered, preload exposes correct API, TypeScript compiles

- [ ] **Unit 5: Report Issue modal component**

  **Goal:** Create a modal overlay with required textarea for issue context.

  **Requirements:** R3, R4, R7

  **Dependencies:** Unit 4

  **Files:**
  - Create: `src/renderer/components/ReportIssueModal.tsx`
  - Modify: `src/renderer/styles/app.css` (modal styles)

  **Approach:**
  - Full-screen overlay following `ask-user-overlay` pattern
  - Props: `meetName: string`, `logSource: 'meet' | 'active'`, `onClose: () => void`
  - Contains: textarea (placeholder "Describe what happened..."), Send button (disabled when textarea empty or sending), Cancel button
  - On send: calls `window.electronAPI.sendReportIssue(meetName, note, logSource)`, shows sending state, on success calls `onClose()` and shows success toast, on error shows error message in modal
  - Escape key closes modal
  - Click on overlay background closes modal

  **Patterns to follow:**
  - `div.ask-user-overlay > div.ask-user-modal` pattern from existing codebase
  - `showMessage` pattern from MeetDetailView for toasts

  **Test scenarios:**
  - Happy path: modal renders with empty textarea, Send disabled
  - Happy path: typing in textarea enables Send button
  - Happy path: clicking Send shows loading state, disables button
  - Happy path: successful send closes modal
  - Error path: failed send shows error in modal, keeps modal open
  - Edge case: pressing Escape closes modal
  - Edge case: clicking overlay background closes modal

  **Verification:** Modal renders, textarea validation works, send triggers IPC call

- [ ] **Unit 6: Add Report Issue buttons to MeetDetailView and ProcessTab**

  **Goal:** Wire the Report Issue modal into both UI locations.

  **Requirements:** R3, R4

  **Dependencies:** Unit 5

  **Files:**
  - Modify: `src/renderer/components/MeetDetailView.tsx`
  - Modify: `src/renderer/components/ProcessTab.tsx`

  **Approach:**
  - **MeetDetailView**: In the file list loop, when filename is `process_log.md`, add a "Report Issue" button (orange/amber color) alongside Open/Show in Folder. Clicking opens ReportIssueModal with `logSource='meet'`.
  - **ProcessTab**: Add a "Report Issue" button in the button row (after Clear Session). Always visible (even during a run — the active log is readable). Clicking opens ReportIssueModal with `logSource='active'` and the current meet name (from `meetName` state in ProcessTab).
  - Both import and conditionally render `<ReportIssueModal>` based on a `showReportModal` state boolean.

  **Patterns to follow:**
  - Existing button styling classes in ProcessTab
  - Conditional rendering pattern from `showSendConfirm` in MeetDetailView

  **Test scenarios:**
  - Happy path: Report Issue button appears on process_log.md row in MeetDetailView
  - Happy path: Report Issue button appears in ProcessTab button row
  - Happy path: clicking either button opens the modal
  - Edge case: in MeetDetailView, button only appears when process_log.md exists in file list
  - Edge case: in ProcessTab, button works even when no run has occurred (sends with no log attachment)

  **Verification:** Both buttons visible in their respective locations, both open the modal, modal sends successfully

- [ ] **Unit 7: Clean up Settings and old SMTP code**

  **Goal:** Remove SMTP configuration UI and related code paths.

  **Requirements:** R1 (zero config)

  **Dependencies:** Units 4, 6

  **Files:**
  - Modify: `src/renderer/components/SettingsTab.tsx` (remove SMTP fields, remove test email button, remove designer email field)
  - Modify: `src/main/config-store.ts` (remove SMTP-related config keys from defaults — keep in AppConfig type for backward compat, just don't show in UI)
  - Modify: `src/shared/types.ts` (clean up AppSettings if SMTP fields are no longer needed)

  **Approach:**
  - Remove the entire "Email Settings (Send to Designer)" section from SettingsTab
  - Keep SMTP keys in config store for backward compatibility (don't crash if old config files have them), but don't expose them in the UI
  - The Settings tab becomes simpler — just model selection, output directory, and any remaining app settings

  **Patterns to follow:**
  - Existing SettingsTab section structure

  **Test scenarios:**
  - Happy path: Settings tab no longer shows SMTP fields
  - Edge case: app starts without error when old config file has SMTP keys

  **Verification:** Settings tab clean, no SMTP UI, app starts normally

- [ ] **Unit 8: Update Send to Designer confirmation dialog**

  **Goal:** Improve the confirmation dialog to list actual IDML filenames and remove SMTP dependency check.

  **Requirements:** R1, R7

  **Dependencies:** Unit 4

  **Files:**
  - Modify: `src/renderer/components/MeetDetailView.tsx`

  **Approach:**
  - The current confirm dialog says "Send N IDML file(s) to designer?" — change to list actual filenames
  - Remove the SMTP config validation check (no longer needed since relay requires no config)
  - Keep the same inline confirm dialog pattern (not a modal — distinct from Report Issue which uses a modal)

  **Patterns to follow:**
  - Existing `showSendConfirm` inline dialog pattern

  **Test scenarios:**
  - Happy path: dialog lists actual IDML filenames (e.g., "back_of_shirt.idml", "back_of_shirt_8.5x14.idml")
  - Happy path: confirming sends without any SMTP config needed

  **Verification:** Dialog shows filenames, send works without SMTP settings

## System-Wide Impact

- **Interaction graph:** MeetDetailView → IPC → email-relay → Vercel API → Postmark. ProcessTab → IPC → same chain. The Vercel route is a new external dependency — app behavior degrades gracefully if the website is down (error toast, no crash).
- **Error propagation:** Relay errors (network, auth, Postmark) propagate as `{ success: false, error: string }` through IPC to the renderer, which shows them as toasts. No silent failures.
- **State lifecycle risks:** None — emails are fire-and-forget with user feedback. No persistent state changes.
- **API surface parity:** The `send-to-designer` IPC channel signature is unchanged (still takes `meetName`). `send-report-issue` is new. `test-email` is removed.
- **Unchanged invariants:** The agent's tool system, process_meet.py, and all data processing are untouched. This is purely a communication/UI feature.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `sales@thestatechampion.com` not verified as Postmark sender | Fall back to `orders@thestatechampion.com` which is already verified. Check during implementation. |
| Vercel API route down → emails fail | Clear error message to user. Emails are not critical-path — user can retry. |
| API key leaked from binary → spam to fixed addresses | Key only allows sending to two hardcoded addresses. Rate limiting on the Vercel route (optional). Low impact. |
| Large IDML files exceed Vercel body limit | Pre-flight 4MB check in Electron before HTTP call. IDML files are typically 50-200KB so this is unlikely. |
| Postmark attachment limit (10MB) | Pre-flight check. Current files are well under this. |

## Sources & References

- Existing Postmark lib: `website/src/lib/postmark.ts`
- API route pattern: `website/src/app/api/admin/email-blast/route.ts`
- IPC security: `docs/solutions/security-issues/ipc-handlers-must-not-accept-raw-paths-from-renderer.md`
- Config encryption: `docs/solutions/runtime-errors/electron-safestorage-double-encryption-race.md`
- SMTP service (being replaced): `src/main/smtp-service.ts`
