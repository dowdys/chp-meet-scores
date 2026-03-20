# Plan 005: Phase-Based Architecture & Tool Split

## Goal

Replace the monolithic agent loop (1 system prompt, 30 tools, free-form args) with a phase-based architecture where each phase has its own tools, focused prompt, and completion criteria. Enforce behavior through code instead of prompting.

## Design Decisions (from discussion)

1. **Phase model**: Hard phases with `unlock_tool` escape hatch (Option C)
2. **Output + Finalize**: Combined into one phase (they bounce back and forth)
3. **Phase transitions**: Explicit via `set_phase` tool (agent-driven, loggable)
4. **System prompt**: Phase-specific — brief pipeline overview + detailed instructions only for current phase
5. **run_python split**: Into `build_database`, `regenerate_output`, `import_idml`

## Phases

### Phase 1: DISCOVERY
**Goal**: Find the meet online, identify source/IDs, set output name, get dates.

**Tools**: http_fetch, web_search, chrome_navigate, chrome_execute_js, chrome_screenshot, chrome_click, chrome_network, ask_user, set_output_name

**Prompt content** (~50 lines):
- Brief pipeline overview (what all phases do)
- Meet search priority: MSO Results.All → ScoreCat Algolia → MyMeetScores → web search
- Algolia quick-reference endpoint
- State championship = multiple sub-meets
- Ask for all dates in one ask_user call
- set_output_name before leaving this phase

### Phase 2: EXTRACTION
**Goal**: Extract all athlete data from identified source(s).

**Tools**: mso_extract, scorecat_extract, chrome_navigate, chrome_save_to_file, chrome_execute_js, chrome_screenshot, ask_user, load_skill, load_skill_detail

**Prompt content** (~30 lines):
- Use dedicated tools for MSO/ScoreCat
- For unknown sources: load general_scraping skill
- Verify level distribution matches user request (auto-reported by extraction tools)
- Don't proceed if levels don't match

### Phase 3: DATABASE
**Goal**: Build DB, run quality checks, normalize gyms.

**Tools**: build_database (new), query_db, query_db_to_file, get_meet_summary, run_script, ask_user

**Prompt content** (~40 lines):
- Schema reference
- Winner determination rules
- Gym normalization (auto + manual --gym-map)
- Quality checklist (or auto-load data_quality skill content)
- Don't over-iterate on gym names (3 iterations max)

### Phase 4: OUTPUT & FINALIZE
**Goal**: Generate outputs, review with user, finalize to central DB.

**Tools**: regenerate_output (new), import_idml (new), render_pdf_page, open_file, list_output_files, query_db, run_script, finalize_meet, ask_user

**Prompt content** (~60 lines):
- All layout flags with defaults
- Regeneration workflow (--regenerate is fast, use it for tweaks)
- Visual inspection: render 1-2 pages, don't render every page
- Review cycle: open_file → ask_user → adjust → repeat
- IDML import rules (import_idml tool handles protection)
- Finalize after user approves
- When to stop (don't iterate on cosmetic perfection)

### Always Available (all phases)
set_phase, unlock_tool, save_progress, load_progress, read_file, run_script, list_skills, load_skill, load_skill_detail

## New Tools

### set_phase
```typescript
{
  name: 'set_phase',
  description: 'Advance to the next workflow phase. Each phase has focused tools and instructions. Phases: discovery → extraction → database → output_finalize. You can also go back to an earlier phase if needed (e.g., re-extract after quality issues).',
  input_schema: {
    type: 'object',
    properties: {
      phase: { type: 'string', enum: ['discovery', 'extraction', 'database', 'output_finalize'] },
      reason: { type: 'string', description: 'Brief reason for the transition (logged for debugging)' }
    },
    required: ['phase', 'reason']
  }
}
```

### unlock_tool
```typescript
{
  name: 'unlock_tool',
  description: 'Temporarily make a tool from another phase available in the current phase. Use when you need to go back for a specific action without switching phases entirely (e.g., need mso_extract during database phase because quality check found missing data).',
  input_schema: {
    type: 'object',
    properties: {
      tool_name: { type: 'string', description: 'Name of the tool to unlock' },
      reason: { type: 'string', description: 'Why this tool is needed in the current phase' }
    },
    required: ['tool_name', 'reason']
  }
}
```

### build_database (replaces run_python for full pipeline)
```typescript
{
  name: 'build_database',
  description: 'Parse extracted data and build the SQLite database with winners. The --db and --output flags are auto-injected.',
  input_schema: {
    type: 'object',
    properties: {
      source: { type: 'string', enum: ['scorecat', 'mso_pdf', 'mso_html', 'generic'] },
      data_path: { type: 'string', description: 'Path to the extracted data file' },
      state: { type: 'string', description: 'State name (e.g., Iowa, Maryland)' },
      meet_name: { type: 'string', description: 'Meet name (e.g., 2025 Iowa State Championships)' },
      association: { type: 'string', description: 'USAG or AAU (default: USAG)' },
      year: { type: 'number', description: 'Meet year (auto-detected if omitted)' },
      gym_map: { type: 'string', description: 'Path to gym name mapping JSON file' },
      division_order: { type: 'string', description: 'Comma-separated divisions youngest-to-oldest' }
    },
    required: ['source', 'data_path', 'state', 'meet_name']
  }
}
```

### regenerate_output (replaces run_python --regenerate)
```typescript
{
  name: 'regenerate_output',
  description: 'Regenerate specific output files from existing database. Much faster than full pipeline — use for layout tweaks, date changes, etc.',
  input_schema: {
    type: 'object',
    properties: {
      state: { type: 'string' },
      meet_name: { type: 'string' },
      outputs: { type: 'array', items: { type: 'string', enum: ['shirt', 'idml', 'order_forms', 'gym_highlights', 'summary', 'all'] }, description: 'Which outputs to regenerate' },
      line_spacing: { type: 'number', description: 'Line spacing (default 1.15)' },
      level_gap: { type: 'number', description: 'Gap between level groups (default 6)' },
      max_fill: { type: 'number', description: 'Max page fill ratio (default 0.90)' },
      min_font_size: { type: 'number', description: 'Minimum font size (default 6.5)' },
      max_font_size: { type: 'number', description: 'Maximum font size (default 9)' },
      max_shirt_pages: { type: 'number', description: 'Force fit into N pages' },
      level_groups: { type: 'string', description: 'Semicolon-separated groups: "XSA,XD;10,9,8"' },
      page_size_legal: { type: 'string', description: 'Group name(s) for 8.5x14 version' },
      postmark_date: { type: 'string' },
      online_date: { type: 'string' },
      ship_date: { type: 'string' },
      accent_color: { type: 'string', description: 'Hex color for accents (default #FF0000)' },
      font_family: { type: 'string', enum: ['serif', 'sans-serif'] },
      title1_size: { type: 'number' },
      title2_size: { type: 'number' },
      header_size: { type: 'number' },
      divider_size: { type: 'number' },
      copyright: { type: 'string' },
      sport: { type: 'string' },
      title_prefix: { type: 'string' },
      division_order: { type: 'string' },
      exclude_levels: { type: 'string' },
      gym_map: { type: 'string' },
      force: { type: 'boolean', description: 'Force overwrite of imported outputs' }
    },
    required: ['state', 'meet_name', 'outputs']
  }
}
```

### import_idml (replaces run_python --import-idml)
```typescript
{
  name: 'import_idml',
  description: 'Import a finalized IDML file from InDesign back into the system. Generates back_of_shirt.pdf and all dependent outputs. The IDML contains embedded metadata (meet name, state) used automatically. After import, use regenerate_output for any adjustments — NEVER use build_database (it would destroy the designer edits).',
  input_schema: {
    type: 'object',
    properties: {
      idml_path: { type: 'string', description: 'Path to the IDML file' },
      postmark_date: { type: 'string' },
      online_date: { type: 'string' },
      ship_date: { type: 'string' }
    },
    required: ['idml_path']
  }
}
```

## Implementation Stages

### Stage 1: Quick wins (can be done independently)
- [x] #007: Set PYTHONUTF8=1 in run_script env vars
- [x] #006: Handle "Execution context destroyed" in chrome-controller.ts
- [x] #009: Add level distribution to extraction tool summaries
- [x] #010: Better finalize_meet error when no staging DB
- [x] #012: Minimal query mode system prompt

### Stage 2: Tool split (foundation for phases)
- [x] Create typed tool definitions: build_database, regenerate_output, import_idml
- [x] Implement tool executors that construct args and call process_meet.py
- [x] IDML import sets context.idmlImported flag; build_database checks it (#002)
- [x] build_database checks context.outputName is set (#005)
- [x] Remove old run_python tool definition
- [ ] Test all modes work: full pipeline, regenerate, IDML import

### Stage 3: Phase architecture
- [x] Create src/main/workflow-phases.ts with phase definitions
- [x] Add phase tracking to AgentContext (currentPhase, unlockedTools)
- [x] Implement set_phase tool (explicit transitions with logging)
- [x] Implement unlock_tool tool (temporary cross-phase access)
- [x] Modify agent-loop.ts runLoop() to filter tools by phase
- [x] Add domain warnings to chrome tools (#008)

### Stage 4: Phase-specific prompts
- [x] Split system-prompt.md into phase sections (built into workflow-phases.ts)
- [x] Create phase prompt builder in workflow-phases.ts
- [x] Each phase gets: pipeline overview (10 lines) + phase detail (30-60 lines)
- [x] Phase prompts include relevant domain knowledge (#003 — skills auto-embedded)
- [x] Modify agent-loop.ts buildSystem() to use phase-specific prompt
- [x] Base prompt reduced from 268 lines to ~20 lines (rest is per-phase)

### Stage 5: Test & trim prompts
- [x] Build compiles successfully with zero errors
- [ ] Run a full meet processing end-to-end
- [ ] Verify phase transitions work naturally
- [ ] Verify unlock_tool works for backtracking
- [ ] Audit remaining skills/ docs for redundancy
- [ ] Measure token reduction

## Files Changed

| File | Changes |
|------|---------|
| src/main/workflow-phases.ts | NEW — Phase definitions, tool sets, prompt builder |
| src/main/tool-definitions.ts | Split run_python; add set_phase, unlock_tool |
| src/main/context-tools.ts | Split toolRunPython into 3 typed executors; IDML flag |
| src/main/agent-loop.ts | Phase-aware tool filtering, phase-specific prompts |
| src/main/chrome-controller.ts | Context destroyed handling |
| src/main/tools/browser-tools.ts | Domain warnings for MSO/ScoreCat |
| src/main/tools/extraction-tools.ts | Level distribution in summaries |
| src/main/tools/python-tools.ts | PYTHONUTF8 env var, finalize_meet error |
| skills/system-prompt.md | Restructured into phase sections, heavily trimmed |

## Risks

- **Agent confusion during transition**: If the agent's mental model doesn't match the phase system, it may fight the constraints. Mitigation: clear set_phase descriptions, unlock_tool escape hatch.
- **Phase prompt too lean**: If we trim too aggressively, the agent may lack needed context. Mitigation: keep pipeline overview in all phases; test incrementally.
- **Backward compatibility**: Saved progress files reference the old workflow. Mitigation: clear saved progress when upgrading; add version field to progress files.
