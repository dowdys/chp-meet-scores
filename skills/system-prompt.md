# Gymnastics Meet Scoring System — Reference

> **DO NOT LOAD THIS FILE.** It is outdated and will give you incorrect information. The active system prompt is built dynamically from phase-specific prompts in `workflow-phases.ts`. The relevant instructions for your current phase are already in your system prompt.

## Architecture

The agent operates in 4 workflow phases, each with its own tools and focused instructions:

1. **DISCOVERY** — Find the meet online, identify source/IDs, set output name, get dates
2. **EXTRACTION** — Extract all athlete data from the identified source(s)
3. **DATABASE** — Build the SQLite database, run quality checks, normalize gym names
4. **OUTPUT & FINALIZE** — Generate outputs, review with user, finalize to central DB

Plus a reactive phase:
5. **IMPORT BACKS** — Import designer-edited PDF backs (activates when user provides PDF file paths)

Use `set_phase` to transition between phases. Use `unlock_tool` if you need a tool from another phase without switching.

## Key Tools

| Tool | Phase | Purpose |
|------|-------|---------|
| `search_meets` | discovery | Search MSO + ScoreCat + Perplexity for meets (season-aware) |
| `lookup_meet` | discovery | Verify a specific meet by exact MSO ID — returns metadata |
| `mso_extract` | extraction | Extract from MeetScoresOnline.com (direct API, no Chrome) |
| `scorecat_extract` | extraction | Extract from ScoreCat/Firebase |
| `build_database` | database | Parse extracted data into SQLite. Sources: "generic" (MSO JSON) or "scorecat" |
| `regenerate_output` | output_finalize | Regenerate specific outputs from existing DB |
| `import_pdf_backs` | import_backs | Import designer-edited PDF backs, regenerate order forms + gym highlights |
| `finalize_meet` | output_finalize | Merge staging DB into central DB |
| `set_phase` | always | Transition to a different workflow phase |
| `unlock_tool` | always | Temporarily access a tool from another phase |

## Database Schema

- **results**: id, state, meet_name, association, name, gym, session, level, division, vault, bars, beam, floor, aa, rank, num
- **winners**: id, state, meet_name, association, name, gym, session, level, division, event, score, is_tie
- **meets**: id, meet_name (UNIQUE), source, source_id, source_name, state, association, year, dates, created_at

## Critical Rules

- **After PDF import**: NEVER use `build_database` or `regenerate_output` with `shirt`/`all` — it destroys designer edits
- **Before `build_database`**: Must call `set_output_name` first
- **Winner determination**: Always score-based, never trust source ranks
- **Dates**: Use the MEET YEAR for deadline dates, not the current year
- **UTF-8**: Enforced automatically via `PYTHONUTF8=1` environment variable

## Available Skills

| Skill | When to Load |
|-------|-------------|
| meet_discovery | Starting a new meet (reference only — search_meets is primary) |
| scorecat_extraction | Reference for ScoreCat edge cases |
| database_building | Building SQLite DB |
| output_generation | Generating deliverables |
| data_quality | Validating data before output |
| general_scraping | Unknown/new source websites |
