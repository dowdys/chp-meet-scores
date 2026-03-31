# Brainstorm: My Meets — Unified File Hub

**Date:** 2026-03-31
**Status:** Brainstorm complete

## What We're Building

A unified **"My Meets"** tab that replaces the current "Cloud Meets" tab, combining local and cloud meet files into one browsable interface. The goal is to eliminate the need for users to ever open Windows File Explorer to find, open, print, or share their output files.

### The Problem

The primary user (non-tech-savvy, processes ~50 meets/season in batches of ~5/week on Windows) struggles with:
- **Finding files**: Doesn't know where the output folder is or how to navigate to it
- **Acting on files**: Can't easily open, print, or share files once found
- **Managing across meets**: Loses track of which files belong to which meet
- **IDML round-trip friction**: Must manually email IDML to designer, wait for edited PDF back, then import it — all through email and file explorer

### What It Replaces

- The current **Cloud Meets** tab (which already has meet browsing + file open/download/show-in-folder)
- The post-processing **OutputFiles** component (which shows files but only has an "Open Folder" button)
- All need to open Windows File Explorer for GMS-related files

## Why This Approach

We explored three approaches:

1. **File Hub Tab** (chosen) — Meet browser + clickable files + print/email/designer actions
2. **File Hub + Embedded PDF Preview** — Adds in-app PDF viewer. Rejected for now: adds complexity, may not render complex IDML-generated PDFs well, and the default Windows PDF viewer works fine
3. **File Hub + Cloud IDML Sharing** — Adds cloud-based designer portal. Over-engineered for a one-designer workflow

**Approach 1 wins** because it solves all pain points with minimal complexity. The existing Cloud Meets tab provides ~80% of the needed UI patterns (meet list → file list → actions). This is an extension, not a rewrite.

We also decided to **combine Cloud + Local** into one tab rather than adding a separate Files tab because:
- Cloud Meets already shows meets and their files — same concept, different data source
- One unified view is simpler for a non-tech-savvy user
- Reduces tab count (4 tabs instead of 5)

## Key Decisions

### Tab Structure
- **Name**: "My Meets"
- **Position**: Replaces "Cloud Meets" in the tab order (Process → Query → My Meets → Settings)
- **Data sources**: Local filesystem (output directory) + Supabase cloud — merged into one list

### Meet List View
- Simple flat list, sorted by most recently modified
- Each meet card shows status badges: `LOCAL` | `CLOUD` | `LOCAL + CLOUD`
- Existing state/year filters carry over from Cloud Meets
- Meet metadata: state, year, athlete count, winner count, dates

### File Detail View (click a meet)
- Lists all files for that meet with icons, sizes, modification dates
- **Local files**: Available immediately
- **Cloud-only files**: Download on demand (existing Cloud Meets behavior)

### File Actions
| Action | Applies to | Behavior |
|--------|-----------|----------|
| **Open** | All files | Opens in default OS app (PDF viewer, text editor, etc.) |
| **Print** | PDFs | Sends directly to default printer |
| **Show in Explorer** | Local files | Opens containing folder with file highlighted |
| **Send to Designer** | IDML files | Sends email automatically via configured email provider |
| **Import PDF Back** | Meet-level | Triggers file picker for designer's edited PDF, feeds into existing import flow |
| **Pull to Local DB** | Cloud meets | Existing Cloud Meets behavior |
| **Download** | Cloud files | Downloads to local output directory |

### Email Integration (Send to Designer)
- **Fully automated**: App sends email directly (no manual compose)
- **One-time setup in Settings**: Email provider credentials (SMTP or OAuth)
- **Designer email in Settings**: Single designer address stored in config
- **Implementation**: nodemailer with SMTP, or Gmail/Outlook OAuth
- **UX**: Click "Send to Designer" on IDML → confirmation toast → email sent

### Output Files Integration
- After the agent processes a meet, the existing OutputFiles component should link to the new My Meets tab (or auto-navigate there)
- The current "Open Folder" button in OutputFiles becomes less prominent / replaced by "View in My Meets"

## Resolved Questions

1. **Print workflow**: Show the standard Windows print dialog (choose printer, copies, etc.) — safer and more flexible than direct-to-default-printer.

2. **File deletion**: No — keep it simple. Files can only be deleted via File Explorer. The app is for viewing and using files, not managing them.

## Resolved Questions (continued)

3. **Designer PDF import**: Manual import (user clicks "Import PDF Back" and picks file) is fine for v1. No auto-detect needed.

4. **Meet name matching (local vs cloud)**: Match by exact name. The app's name normalization should ensure consistency, so this shouldn't be a problem.

## Out of Scope (for now)

- Embedded PDF viewer (can add later if default viewer isn't enough)
- Cloud-based designer portal (email works for one designer)
- Drag-and-drop to external apps (complex and platform-dependent)
- File versioning or history
- Batch operations across multiple meets
