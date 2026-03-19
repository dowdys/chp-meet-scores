---
title: "Fix partial IDML import workflow and agent behavior for multi-page meets"
type: fix
status: completed
date: 2026-03-19
---

# Fix Partial IDML Import Workflow and Agent Behavior for Multi-Page Meets

## Overview

A user test run (process_log (10).md) revealed that the agent cannot handle a common real-world workflow: the user has a multi-page meet (Xcel on one back, Levels 2-10 on another) and provides a designer-edited IDML for JUST ONE of the pages (levels 2-10). The agent needs to combine this edited page with the existing Xcel page, then regenerate order forms and gym highlights using the correct page-to-level mapping.

## Problems Found

### P1: Agent can't handle partial IDML imports

The user said: "this second file i just gave you is the update back for levels 2-10 for nevada." The agent:
1. Imported the IDML to a generic "IDML Import" folder (no metadata → wrong folder)
2. Manually copied the PDF to the Nevada folder, overwriting the 2-page back_of_shirt.pdf with a 1-page PDF
3. This caused 163 Xcel athletes to have NO back pages on their order forms
4. The agent couldn't figure out how to merge the new 1-page design with the existing Xcel page

**Root cause:** `--import-idml` assumes the IDML replaces the ENTIRE back_of_shirt. There's no way to import a partial design targeting a specific page group.

**Fix:** Add `--import-idml-page` flag (or similar) that imports an IDML as a specific page in a multi-page shirt. OR add system prompt guidance for the agent to manually combine pages using `run_script`.

### P2: Agent loaded ZERO skills

Throughout 12 iterations, the agent never loaded any skill. When handling IDML import + order forms + gym highlights, it should have loaded `output_generation` at minimum. The system prompt says to load skills, but the agent ignored it.

**Fix:** Strengthen system prompt: "When handling IDML imports, ALWAYS load the output_generation skill. When generating ANY output, load the appropriate skill."

### P2: Duplicate meet entries in central database

The `list_meets` output shows:
```
Nevada | 2026 NV State Championships    | 971
Nevada | 2026 Nevada State Championships | 971
```
Two separate entries for the same meet with different names, both with 971 athletes. This happened because two different runs used different `set_output_name` values but extracted the same MSO meetId.

**Fix:** Add a check in `finalize_meet` that warns when a meet with the same state + similar athlete count already exists. Or add a `--meet` flag validation against existing meets.

### P3: Output folder clutter

The Nevada folder has accumulated: `back_of_shirt.pdf`, `back_of_shirt_old.pdf`, `back_of_shirt_8.5x14.pdf`, `back_of_shirt_8.5x14_NEW.pdf`, `back_of_shirt_levels_2-10.pdf`, `back_of_shirt_user.idml`, `gym_highlights.pdf`, `gym_highlights_NEW.pdf`, `gym_highlights_8.5x14.pdf`, `gym_highlights_8.5x14_NEW.pdf`, `gym_highlights_levels_2-10.pdf`, `gym_highlights_xcel.pdf`, `gym_highlights_xcel_8.5x14.pdf`, `order_forms.pdf`, `order_forms_NEW.pdf`.

The `_NEW` suffix pattern (used when a file is locked) creates clutter. The agent also created ad-hoc filenames like `_levels_2-10`, `_xcel`, `_old`.

**Fix:** Add system prompt guidance: "When regenerating outputs, ALWAYS close previously opened files first (tell the user to close them). Don't create ad-hoc filename variants — use the standard names."

### P3: Agent forgot to import `os` in run_script

The agent ran `run_script` with code that used `os.path.exists` without importing `os`, causing a NameError. It then fixed it in the next iteration, wasting a turn.

**Fix:** Already partially addressed by the system prompt note about encoding. Add: "Always import all needed stdlib modules (os, json, sys, etc.) at the top of run_script code blocks."

## Proposed Solution

### 1. System Prompt: IDML Import for Multi-Page Meets

Add detailed guidance to the system prompt for handling partial IDML imports:

```
When a user provides an IDML file for a SPECIFIC page of a multi-page meet:
1. Identify which page group the IDML represents (e.g., "levels 2-10" or "Xcel")
2. Import the IDML to get the PDF: run_python --import-idml <path>
3. The imported PDF becomes ONE page of the multi-page back_of_shirt.pdf
4. Use run_script to combine pages: open the existing multi-page PDF, replace
   the target page with the imported design, save
5. Then regenerate order_forms and gym_highlights from the combined PDF
```

### 2. System Prompt: Always Load Skills

Add a stronger rule about loading skills for every workflow step.

### 3. System Prompt: run_script Best Practices

Add guidance about always importing needed modules.

### 4. System Prompt: File Naming Hygiene

Add guidance about closing files before regenerating, using standard names.

### 5. Duplicate Meet Detection (code change)

In `finalize_meet` (python-tools.ts), before merging to central DB, check if a meet with the same state and similar name already exists. Warn the user.

## Acceptance Criteria

- [ ] System prompt has clear guidance for partial IDML imports
- [ ] System prompt requires loading output_generation skill for any output work
- [ ] System prompt has run_script best practices (imports, encoding)
- [ ] System prompt has file naming hygiene guidance
- [ ] finalize_meet warns about potential duplicate meets

## Files to Modify

- `skills/system-prompt.md` — agent behavior improvements
- `src/main/tools/python-tools.ts` — duplicate meet detection in finalize_meet
