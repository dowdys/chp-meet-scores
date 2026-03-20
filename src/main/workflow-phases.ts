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
1. **DISCOVERY** — Find the meet online, identify source/IDs, set output name, get dates
2. **EXTRACTION** — Extract all athlete data from the identified source(s)
3. **DATABASE** — Build the SQLite database, run quality checks, normalize gym names
4. **OUTPUT & FINALIZE** — Generate output files, review layout with user, finalize to central DB
5. **IMPORT BACKS** — Import designer-edited PDF backs and regenerate order forms/gym highlights (separate workflow, triggered when user provides PDF files)

Use \`set_phase\` to advance. You can also go back if needed. Use \`unlock_tool\` to temporarily access a tool from another phase.`;

const PHASES: Record<WorkflowPhase, PhaseDefinition> = {
  discovery: {
    name: 'discovery',
    description: 'Find the meet online, identify source and IDs, set output name, get dates',
    tools: [
      'search_meets', 'http_fetch', 'web_search', 'chrome_navigate', 'chrome_execute_js',
      'chrome_screenshot', 'chrome_click', 'set_output_name',
    ],
    prompt: `## Current Phase: DISCOVERY
Find the meet results online and prepare for extraction.

### Meet Search
Call \`search_meets\` ONCE. It searches both MSO and ScoreCat. Do NOT browse websites manually.

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

### Before Leaving This Phase
- Call \`set_output_name\` with a clean folder name (e.g., "2025 SC State Championships")
- Use \`ask_user\` to get ALL deadline dates in a single prompt (postmark, online ordering, shipping)
- If multiple meets match, present ALL to the user via \`ask_user\`
- Once you find a meet on MSO, move directly to extraction — do NOT also search ScoreCat/MyMeetScores for the same meet
- ALWAYS verify today's date with \`run_script\` before dismissing meets as "future"
- After MSO extraction, verify levels cover what the user requested — if levels are missing, there may be a separate meet

### Recognizing File Paths (IDML Import)
If the user's input looks like a **file path** (starts with \`/\`, \`C:\\\`, \`~\`, \`/mnt/\`, or contains \`.idml\`), do NOT treat it as a meet name. Instead, use \`set_phase("output_finalize")\` and then use the \`import_idml\` tool.`,
  },

  extraction: {
    name: 'extraction',
    description: 'Extract all athlete data from identified source(s)',
    tools: [
      'mso_extract', 'scorecat_extract', 'chrome_navigate', 'chrome_save_to_file',
      'chrome_execute_js', 'chrome_screenshot', 'chrome_click',
      'save_to_file', 'http_fetch',
    ],
    prompt: `## Current Phase: EXTRACTION
Extract all athlete data from the identified meet source(s).

### Dedicated Extraction Tools
- **\`mso_extract\`** — For MeetScoresOnline. Input: array of numeric meet IDs. Handles API calls, name cleaning, field mapping automatically.
- **\`scorecat_extract\`** — For ScoreCat/Firebase. Input: array of Algolia meet IDs. Handles Firebase SDK, Firestore queries, field mapping automatically.

For MSO and ScoreCat, ALWAYS use the dedicated tools. Do NOT manually script extraction.

### Unknown/New Sources
For other sources, load the \`general_scraping\` skill first, then use \`chrome_save_to_file\` for bulk data extraction.

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

### Quality Checks
After building the database, load the \`data_quality\` skill and run checks. Batch multiple queries into a single \`run_script\` call when possible.

### Passing Dates
When calling \`build_database\`, ALWAYS include the deadline dates if you have them:
- postmark_date, online_date, ship_date
These appear on the order forms. If you don't pass them, they default to "TBD".

### Staging Database
\`build_database\` writes to a staging database. Run quality checks against staging data. When satisfied, advance to output_finalize phase. \`finalize_meet\` (in output_finalize) merges staging → central.

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
