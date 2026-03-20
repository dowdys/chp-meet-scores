---
review_agents:
  - kieran-typescript-reviewer
  - code-simplicity-reviewer
  - publishing-pipeline-guardian
  - prompt-enforcement-detector
plan_review_agents:
  - code-simplicity-reviewer
  - publishing-pipeline-guardian
strictness: all
---

# Championship Meet Scores — Review Context

Championship gymnastics publishing pipeline. Electron + React + TypeScript frontend with Python data processing backend. Produces 7+ interdependent output files.

## Key Constraints

- **PDF coordinates**: top-left origin, Y increases downward, 72 points per inch, 612x792 for Letter size.
- **IDML coordinates**: spread-centered origin — different from PDF. Conversion between coordinate systems must be exact.
- **IDML mimetype must be first in ZIP and uncompressed** — InDesign rejects the file otherwise. This is a non-obvious requirement.
- **Round-trip workflow** (app → IDML → InDesign → IDML → app) — running `--regenerate` after `--import-idml` destroys designer edits. The workflow must preserve imported changes.
- **Font names must match exactly** between measurement and rendering calls. Even minor differences (e.g., "Arial" vs "ArialMT") cause layout shifts.
- **PyMuPDF is NOT thread-safe** — all PDF operations must be single-threaded.
- **7+ interdependent output files**: PDF, IDML, ICML, highlights, order forms, summary, winners. Changes to one format can break others.
