/**
 * Workflow Phase Architecture
 *
 * The agent operates in distinct phases, each with its own tools and focused
 * system prompt. This replaces the monolithic "all 30 tools + 268-line prompt"
 * approach with phase-specific constraints that enforce correct behavior
 * through architecture rather than prompting.
 *
 * Phases: discovery → extraction → database → output_finalize
 * Transitions: explicit via set_phase tool (agent-driven, logged)
 * Escape hatch: unlock_tool for cross-phase access when needed
 */

import { ToolDefinition } from './llm-client';

// --- Phase types ---

export type WorkflowPhase = 'discovery' | 'extraction' | 'database' | 'output_finalize' | 'import_backs';

export interface PhaseDefinition {
  name: WorkflowPhase;
  description: string;
  /** Tool names available in this phase (in addition to always-available tools) */
  tools: string[];
  /** Phase-specific system prompt section */
  prompt: string;
}

// --- Always-available tools ---

const ALWAYS_AVAILABLE_TOOLS = [
  'set_phase',
  'unlock_tool',
  'ask_user',
  'read_file',
  'run_script',
  'save_progress',
  'load_progress',
];

// --- Phase definitions ---

const PIPELINE_OVERVIEW = `## Pipeline Overview
You process gymnastics meet results through these phases:

### Sequential phases (normal flow):
1. **DISCOVERY** — Find the meet online, identify source/IDs, set output name, get dates
2. **EXTRACTION** — Extract all athlete data from the identified source(s)
3. **DATABASE** — Build the SQLite database, run quality checks, normalize gym names
4. **OUTPUT & FINALIZE** — Generate output files, review layout with user, finalize to central DB

### Reactive phase (activates when user provides PDF file paths):
5. **IMPORT BACKS** — Import designer-edited PDF backs and regenerate order forms/gym highlights

The IMPORT BACKS phase is NOT a step in the sequential flow. It activates **automatically** when the user provides PDF file paths (e.g., in response to an ask_user prompt). The system detects PDF paths and switches you to this phase. You do NOT need to manually call set_phase — it happens for you.

If the auto-switch doesn't trigger, call \`set_phase("import_backs")\` yourself when you see the user providing PDF file paths.

**IMPORTANT**: When in IMPORT BACKS phase, use the \`import_pdf_backs\` tool — do NOT manually copy files with \`run_script\`. The tool handles everything: combining pages, scaling, regenerating order forms and gym highlights.

Use \`set_phase\` to advance between sequential phases. Use \`unlock_tool\` to temporarily access a tool from another phase.`;

const PHASES: Record<WorkflowPhase, PhaseDefinition> = {
  discovery: {
    name: 'discovery',
    description: 'Find the meet online, identify source and IDs, set output name, get dates',
    tools: [
      'search_meets', 'lookup_meet', 'http_fetch', 'web_search', 'chrome_navigate', 'chrome_execute_js',
      'chrome_screenshot', 'chrome_click', 'set_output_name',
    ],
    prompt: `## Current Phase: DISCOVERY
Find the meet results online and prepare for extraction.

### Meet Search
Call \`search_meets\` ONCE. It searches MSO (current + previous season pages automatically), ScoreCat (Algolia), and Perplexity as fallback. Do NOT browse websites manually.
If you know the exact MSO meet ID, use \`lookup_meet\` to verify it and get metadata (canonical name, dates, location).

**CRITICAL: Trust the results.** If \`search_meets\` returns a Women's meet from MSO for the correct state, that is almost certainly the right meet. Do NOT:
- Spend iterations browsing MSO to "confirm" the meet
- Search again with different keywords
- Navigate to the meet page to verify
- Take screenshots of the MSO website

The meet name from MSO may not include the year (e.g., "Arkansas State Meet" instead of "2026 Arkansas State Meet") — this is normal. MSO meet names are often generic. Trust the state, program (Women), and source.

**If search_meets returns the right meet:** Set the output name, ask for dates, and move to extraction. This should take 1-2 iterations total.

**If search_meets returns NO Women's meet for the state:** Try ONE more search with different keywords, then ask the user for help.

### Fallback Search (only if search_meets fails)
If \`search_meets\` returns no results:
1. Try \`http_fetch\` with Algolia API directly
2. Try \`web_search\` (Google) as last resort
Do NOT browse MSO website, take screenshots, or try MyMeetScores unless search_meets completely fails.

### State Championships
A full state championship covers all competitive levels (numbered 1-10 + Xcel Bronze through Sapphire). Most sources split these across **multiple separate meets**. Find and combine all sub-meets.

### Meet Naming Convention
Use this standardized format for meet names:
\`[Association] [Gender Initial] [Sport] - [Year] [State Abbrev] - [Date(s)]\`
Examples:
- "USAG W Gymnastics - 2025 MS - March 14-16"
- "USAG W Gymnastics - 2026 NV - March 14-16"
- "AAU W Gymnastics - 2025 AL - May 2-3"
Use the 2-letter state abbreviation (MS, NV, AL, etc.). Get dates from \`lookup_meet\` or extraction results.

### Before Leaving This Phase
- Call \`set_output_name\` with the standardized meet name (see naming convention above)
- Use \`ask_user\` to get ALL deadline dates in a single prompt (postmark, online ordering, shipping). Request dates with the YEAR included (e.g., "April 4, 2025").
- If multiple meets match, present ALL to the user via \`ask_user\`
- Once you find a meet on MSO, move directly to extraction — do NOT also search ScoreCat/MyMeetScores for the same meet
- After MSO extraction, verify levels cover what the user requested — if levels are missing, there may be a separate meet

### Recognizing File Paths (IDML Import)
If the user's input looks like a **file path** (starts with \`/\`, \`C:\\\`, \`~\`, \`/mnt/\`, or contains \`.idml\`), do NOT treat it as a meet name. Instead, use \`set_phase("output_finalize")\` and then use the \`import_idml\` tool.`,
  },

  extraction: {
    name: 'extraction',
    description: 'Extract all athlete data from identified source(s)',
    tools: [
      'mso_extract', 'scorecat_extract',
      'save_to_file', 'http_fetch',
    ],
    prompt: `## Current Phase: EXTRACTION
Extract all athlete data using the dedicated extraction tools.

### Extraction Tools
- **\`mso_extract\`** — For MeetScoresOnline meets. Input: array of numeric meet IDs. Handles everything automatically.
- **\`scorecat_extract\`** — For ScoreCat meets. Input: array of Algolia meet IDs. Handles everything automatically.

Call the appropriate tool with the meet IDs from discovery. Do NOT browse websites — the tools handle all API calls internally.

### If Dedicated Tools Fail
If \`mso_extract\` or \`scorecat_extract\` return no data, do NOT start browsing. Instead:
1. Use \`run_script\` to call Perplexity and confirm where the meet results are actually hosted
2. If the results are on a site we don't have a dedicated tool for, load the \`unknown_source_extraction\` skill — it will guide you through Chrome-based extraction

### After Extraction
- The extraction tools automatically report **level distribution** — verify it matches the user's request
- If levels don't match (e.g., user wanted L3-5 but got L6-10), STOP and search for the correct meets
- List ALL levels found explicitly when reporting to the user — don't abbreviate
- If any requested levels are missing, explicitly call that out`,
  },

  database: {
    name: 'database',
    description: 'Build the SQLite database, run quality checks, normalize gym names',
    tools: [
      'build_database', 'query_db', 'query_db_to_file', 'get_meet_summary',
      'list_meets', 'list_skills', 'load_skill',
    ],
    prompt: `## Current Phase: DATABASE
Build the database from extracted data and verify quality.

### Database Schema
**results** table: id, state, meet_name, association, name, gym, session, level, division, vault, bars, beam, floor, aa, rank, num
**winners** table: id, state, meet_name, association, name, gym, session, level, division, event, score, is_tie
**meets** table: id, meet_name (UNIQUE), source, source_id, source_name, state, association, year, dates, created_at — tracks where each meet's data came from

### Winner Determination Rules
- **Winner** = highest score per session+level+division per event (always score-based, never trust source ranks)
- **Ties**: All athletes sharing the max score are winners (is_tie=1)
- **Sessions matter**: Same level+division in different sessions = separate competitions
- **Zero/null scores** = did not compete. Excluded even if rank shows 1.
- **Solo session exclusion**: Solo athlete in a session+level+division where the same level+division has multiple athletes elsewhere → "out of session" accommodation, NOT a winner. But if a division legitimately has only one athlete at the entire meet, she IS the champion.

### Gym Normalization
Auto-normalized by \`build_database\` in three phases:
1. **Case normalization** — Title-case dedup, acronyms preserved
2. **Suffix merge** — "All Pro" + "All Pro Gymnastics" → "All Pro Gymnastics"
3. **Fuzzy detection** — Flags >80% similar pairs for review (NOT auto-merged)

If potential duplicates need manual mapping, create a gym-map JSON and re-run with \`gym_map\` parameter. Don't spend more than ~3 iterations on gym normalization.

### Division Ordering
After building the database, \`build_database\` reports the auto-detected division order and flags any UNKNOWN_DIVISIONS. **You must verify the division order is correct** before generating outputs. Divisions should be sorted youngest to oldest.

Every state uses different division formats:
- Age-based: "8 yrs.", "9A", "10B", "15+" (Nebraska)
- Letter-based: "A", "B", "C", "D", "E" (Mississippi)
- Jr/Sr: "Jr A", "Jr B", "Sr A", "Sr B" (Nevada)
- Named: "Child", "Youth", "Junior", "Senior" (various)

**If the auto-detected order looks wrong or has UNKNOWN_DIVISIONS:**
1. Query the database: \`SELECT DISTINCT division FROM results ORDER BY division\`
2. Look at the divisions and determine the correct youngest-to-oldest order based on context
3. Re-run \`build_database\` with the \`division_order\` parameter set to the correct order
4. If you're not sure about the order, ASK the user — show them the divisions and ask which order is correct

**Do NOT spend multiple iterations guessing.** If the format is unfamiliar, ask the user on the first try.

### Quality Checks
After building the database and verifying division order, load the \`data_quality\` skill and run checks. Batch multiple queries into a single \`run_script\` call when possible.

### Passing Dates
When calling \`build_database\`, ALWAYS include the deadline dates if you have them:
- postmark_date: format "April 4, 2025" (full month name, day, and YEAR)
- online_date: same format
- ship_date: same format
These appear on the order forms. If you don't pass them, they default to "TBD".
**IMPORTANT**: Use the MEET YEAR for deadline dates, not the current year. A 2025 meet has 2025 deadlines.
If the user gives dates without a year, use the meet year (from the output name or extraction). Only ask if ambiguous.

### Staging Database
\`build_database\` builds the database ONLY — it does NOT generate output files (PDFs, IDMLs). This is by design: you should run quality checks BEFORE generating outputs.

**Workflow:**
1. Call \`build_database\` → parses data, normalizes gyms, builds results + winners tables
   - Use the SAME name for \`meet_name\` as you set with \`set_output_name\` — they must match
   - Include \`source_id\` (e.g., MSO meet ID "34508"), \`source_name\` (canonical name from MSO), and \`meet_dates\` (e.g., "Mar 14-16, 2025") for the meets metadata table
2. Run quality checks on the staging data (load data_quality skill)
3. Fix any issues found (gym normalization, data cleanup)
4. Advance to output_finalize phase
5. Call \`regenerate_output\` with outputs: ["all"] to generate all files

\`query_db\` automatically queries the staging database during processing.`,
  },

  output_finalize: {
    name: 'output_finalize',
    description: 'Generate output files from DB, review layout with user, iterate, and finalize',
    tools: [
      'regenerate_output', 'render_pdf_page', 'open_file',
      'list_output_files', 'query_db', 'query_db_to_file', 'finalize_meet',
      'get_meet_summary', 'set_output_name', 'list_skills', 'load_skill',
    ],
    prompt: `## Current Phase: OUTPUT & FINALIZE
Generate deliverables from the database, review with user, and finalize.

### Output Generation
Use \`regenerate_output\` to generate or regenerate specific outputs. Available outputs: shirt, idml, order_forms, gym_highlights, summary, all.

If outputs were already generated by \`build_database\`, start by reviewing them. Use \`regenerate_output\` only when you need to adjust layout parameters, change dates, or regenerate specific outputs.

### Layout Parameters (all have sensible defaults)
| Parameter | Default | Description |
|-----------|---------|-------------|
| line_spacing | 1.15 | Line spacing (lower = tighter) |
| level_gap | 6 | Gap between level groups |
| max_fill | 0.90 | Max page fill ratio |
| min_font_size | 6.5 | Minimum font size |
| max_font_size | 9 | Maximum font size |
| max_shirt_pages | (auto) | Force fit into N pages |
| level_groups | (auto) | Semicolon-separated groups: "XSA,XD;10,9,8" |
| page_size_legal | (none) | Group name(s) for 8.5x14 version |
| accent_color | #FF0000 | Hex color for accents |
| font_family | serif | serif (Times) or sans-serif (Helvetica) |
| title1_size | 18 | Title line 1 font size |
| title2_size | 20 | Title line 2 font size |
| header_size | 11 | Column header font size |
| divider_size | 10 | Level divider text size |

### Review Workflow
1. Read \`meet_summary.txt\` to know page count and layout
2. Use \`render_pdf_page\` on 1-2 pages to spot-check (the most crowded page)
3. Use \`open_file\` to show BOTH \`back_of_shirt.pdf\` AND \`meet_summary.txt\` to user
4. Ask with \`ask_user\`: "Are you satisfied with the layout, or would you like changes?"
5. If changes needed: use \`regenerate_output\` with outputs: ["shirt"] and adjusted params
6. Repeat until satisfied. One round of adjustment is usually enough.

### Finalization
- Call \`finalize_meet\` with the meet name to merge staging → central database
- This MUST happen or data will be lost and Query Results tab won't work
- Do this after user approves outputs

### When to Stop
You are done when:
- Output files generated (back_of_shirt.pdf, back_of_shirt.idml, order_forms.pdf, gym_highlights.pdf, meet_summary.txt)
- Winner counts look correct
- Gym names are reasonably clean
Do NOT iterate on cosmetic perfection.

### File Naming
Always use standard output filenames. Do NOT create ad-hoc variants like \`_old\`, \`_NEW\`.
Names are sorted by age division by default. Do NOT change to alphabetical unless user asks.`,
  },

  import_backs: {
    name: 'import_backs',
    description: 'Import designer-edited PDF backs and regenerate dependent outputs',
    tools: [
      'import_pdf_backs', 'list_meets', 'list_output_files',
      'open_file', 'render_pdf_page', 'get_meet_summary',
      'set_output_name', 'query_db',
    ],
    prompt: `## Current Phase: IMPORT BACKS
Import designer-edited back-of-shirt PDFs and regenerate order forms and gym highlights.

### Step 1: Identify the Meet
Use \`list_meets\` to see available meets. Try to match the meet automatically:
- Check if the user mentioned a state or meet name in their message
- Check the PDF filenames for clues (e.g., "NV 2026" → Nevada 2026)
- If exactly ONE meet matches, use it automatically — no need to ask
- Only use \`ask_user\` when there are MULTIPLE plausible matches or ZERO matches

### Step 2: Import the PDFs
Use \`import_pdf_backs\` with:
- \`pdf_paths\`: array of all PDF file paths the user provided
- \`state\`: from the meet data
- \`meet_name\`: the EXACT name from the database (case matters!)

The tool automatically:
- Detects letter vs legal size from page dimensions
- Copies originals to correct locations (back_of_shirt.pdf, back_of_shirt_8.5x14.pdf)
- Creates combined back_of_shirt.pdf with all pages at letter size (legal pages scaled for order forms)
- Regenerates order_forms.pdf (embeds imported PDF pages with red star overlay)
- Regenerates gym_highlights.pdf with correct letter/legal level splits
- Regenerates meet_summary.txt

### Step 3: Show Results
Use \`open_file\` to show the user:
1. back_of_shirt.pdf — verify the backs look right
2. order_forms.pdf — verify the backs appear correctly on order forms
3. gym_highlights.pdf — verify the level splits are correct

### Mixed Sources (Designer + Code-Generated)
If the user provides custom PDFs for SOME page groups but not others, that's fine. The system automatically keeps the existing code-generated pages for any groups the user didn't provide. For example:
- User imports custom Levels 2-10 PDF (letter) + custom Xcel PDF (legal)
- But wants the code-generated Xcel back for ORDER FORMS (because it's already letter-sized)
- Solution: import only the letter PDF → the code-generated Xcel page stays in back_of_shirt.pdf for order forms. Import the legal PDF separately → goes to back_of_shirt_8.5x14.pdf for printing.

### CRITICAL RULES
- NEVER ask the user what changes they made — the PDFs contain all changes
- NEVER manually manipulate PDFs with \`run_script\` — use import_pdf_backs
- NEVER use \`build_database\` or \`regenerate_output\` after import — they destroy designer edits
- If the user provides IDML files, tell them IDML import is no longer supported and ask for PDFs instead

### How Outputs Use the Imported Back
- **order_forms.pdf** — Embeds actual pages from back_of_shirt.pdf with red star overlay. Designer edits ARE preserved.
- **gym_highlights.pdf** — Regenerated from database data. Designer edits are NOT reflected.
- **back_of_shirt.pdf** — Contains ALL pages at letter size (legal pages scaled down for order forms).
- **back_of_shirt_8.5x14.pdf** — Legal pages at native dimensions (for printing).`,
  },
};

// --- Public API ---

const ALL_PHASES: WorkflowPhase[] = ['discovery', 'extraction', 'database', 'output_finalize', 'import_backs'];

export function getAllPhases(): WorkflowPhase[] {
  return ALL_PHASES;
}

export function getPhaseDefinition(phase: WorkflowPhase): PhaseDefinition {
  return PHASES[phase];
}

/**
 * Get the tool names available for a given phase, including always-available tools.
 */
export function getToolsForPhase(phase: WorkflowPhase, unlockedTools: string[] = []): string[] {
  const phaseDef = PHASES[phase];
  const tools = new Set([
    ...ALWAYS_AVAILABLE_TOOLS,
    ...phaseDef.tools,
    ...unlockedTools,
  ]);
  return Array.from(tools);
}

/**
 * Filter tool definitions to only those available in the current phase.
 */
export function filterToolsForPhase(
  allTools: ToolDefinition[],
  phase: WorkflowPhase,
  unlockedTools: string[] = []
): ToolDefinition[] {
  const availableNames = new Set(getToolsForPhase(phase, unlockedTools));
  return allTools.filter(t => availableNames.has(t.name));
}

/**
 * Build the phase-specific system prompt.
 */
export function buildPhasePrompt(phase: WorkflowPhase): string {
  return `${PIPELINE_OVERVIEW}\n\n${PHASES[phase].prompt}`;
}

/**
 * Get which phase a tool belongs to.
 * Returns null if always-available, undefined if nonexistent.
 */
export function getToolHomePhase(toolName: string): WorkflowPhase | null | undefined {
  if (ALWAYS_AVAILABLE_TOOLS.includes(toolName)) return null;
  for (const phase of ALL_PHASES) {
    if (PHASES[phase].tools.includes(toolName)) return phase;
  }
  return undefined; // Tool doesn't exist in any phase
}
