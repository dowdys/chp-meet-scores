# Gymnastics Meet Scoring System — Reference

> **Note**: This file is a reference document. The active system prompt is built dynamically from phase-specific prompts in `workflow-phases.ts`. You do not need to load this skill — the relevant instructions for your current phase are already in your system prompt.

## Architecture

The agent operates in 4 workflow phases, each with its own tools and focused instructions:

1. **DISCOVERY** — Find the meet online, identify source/IDs, set output name, get dates
2. **EXTRACTION** — Extract all athlete data from the identified source(s)
3. **DATABASE** — Build the SQLite database, run quality checks, normalize gym names
4. **OUTPUT & FINALIZE** — Generate outputs, review with user, finalize to central DB

Use `set_phase` to transition between phases. Use `unlock_tool` if you need a tool from another phase without switching.

## Key Tools

| Tool | Phase | Purpose |
|------|-------|---------|
| `build_database` | database | Parse extracted data into SQLite (replaces old run_python --source) |
| `regenerate_output` | output_finalize | Regenerate specific outputs from existing DB (replaces old run_python --regenerate) |
| `import_idml` | output_finalize | Import IDML from InDesign (replaces old run_python --import-idml) |
| `mso_extract` | extraction | Extract from MeetScoresOnline.com |
| `scorecat_extract` | extraction | Extract from ScoreCat/Firebase |
| `set_phase` | always | Transition to a different workflow phase |
| `unlock_tool` | always | Temporarily access a tool from another phase |
| `finalize_meet` | output_finalize | Merge staging DB into central DB |

## Critical Rules

- **After IDML import**: NEVER use `build_database` or `regenerate_output` with `shirt`/`all` — it destroys designer edits
- **Before `build_database`**: Must call `set_output_name` first
- **Winner determination**: Always score-based, never trust source ranks
- **UTF-8**: Enforced automatically via `PYTHONUTF8=1` environment variable

## Available Skills

| Skill | When to Load |
|-------|-------------|
| meet_discovery | Starting a new meet |
| scorecat_extraction | Reference for ScoreCat edge cases |
| mso_pdf_extraction | MSO uses Report Builder (no JSON API) |
| mso_html_extraction | Reference for MSO HTML format |
| database_building | Building SQLite DB |
| output_generation | Generating deliverables |
| data_quality | Validating data before output |
| general_scraping | Unknown/new source websites |
