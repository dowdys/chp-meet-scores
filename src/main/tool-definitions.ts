/**
 * Tool definitions exposed to the LLM.
 *
 * Tools are organized by workflow phase. The agent loop filters these
 * based on the current phase (see workflow-phases.ts).
 */

import { ToolDefinition } from './llm-client';

export function getToolDefinitions(): ToolDefinition[] {
  return [
    // --- Phase management ---
    {
      name: 'set_phase',
      description: 'Advance to a workflow phase. Each phase has focused tools and instructions. Phases: discovery → extraction → database → output_finalize. You can go back to an earlier phase if needed.',
      input_schema: {
        type: 'object',
        properties: {
          phase: { type: 'string', enum: ['discovery', 'extraction', 'database', 'output_finalize'], description: 'The phase to transition to' },
          reason: { type: 'string', description: 'Brief reason for the transition (logged for debugging)' },
        },
        required: ['phase', 'reason'],
      },
    },
    {
      name: 'unlock_tool',
      description: 'Temporarily make a tool from another phase available in the current phase. Use when you need a specific tool without switching phases entirely.',
      input_schema: {
        type: 'object',
        properties: {
          tool_name: { type: 'string', description: 'Name of the tool to unlock' },
          reason: { type: 'string', description: 'Why this tool is needed in the current phase' },
        },
        required: ['tool_name', 'reason'],
      },
    },

    // --- Browser tools (discovery, extraction) ---
    {
      name: 'http_fetch',
      description: 'Make a headless HTTP request. Use for REST APIs (Algolia, MSO). Responses over 5KB are auto-saved to file.',
      input_schema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL to fetch' },
          method: { type: 'string', description: 'HTTP method (default GET)' },
          headers: { type: 'string', description: 'JSON string of headers object' },
          body: { type: 'string', description: 'Request body (for POST/PUT)' },
        },
        required: ['url'],
      },
    },
    {
      name: 'web_search',
      description: 'Search Google for meet results pages. Only use as a last resort — try Algolia or MSO APIs first.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query' },
        },
        required: ['query'],
      },
    },
    {
      name: 'chrome_navigate',
      description: 'Navigate Chrome to a URL.',
      input_schema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL to navigate to' },
        },
        required: ['url'],
      },
    },
    {
      name: 'chrome_execute_js',
      description: 'Run JavaScript in Chrome and return the result. For bulk data extraction, use chrome_save_to_file instead. Results over 10KB are auto-saved to file.',
      input_schema: {
        type: 'object',
        properties: {
          script: { type: 'string', description: 'JavaScript code to execute' },
        },
        required: ['script'],
      },
    },
    {
      name: 'chrome_save_to_file',
      description: 'Run JavaScript in Chrome and save the result to a file. Use for bulk data extraction from unknown sources.',
      input_schema: {
        type: 'object',
        properties: {
          script: { type: 'string', description: 'JavaScript code to execute' },
          filename: { type: 'string', description: 'Output filename (saved in data directory)' },
          timeout_ms: { type: 'number', description: 'Timeout in ms (default 60000, max 120000)' },
        },
        required: ['script', 'filename'],
      },
    },
    {
      name: 'chrome_screenshot',
      description: 'Take a screenshot of the current Chrome page.',
      input_schema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'chrome_click',
      description: 'Click an element on the page by CSS selector.',
      input_schema: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector of the element to click' },
        },
        required: ['selector'],
      },
    },

    // --- Extraction tools ---
    {
      name: 'mso_extract',
      description: 'Extract athlete data from MeetScoresOnline.com via direct API (no Chrome needed). Handles name cleaning, field mapping. Reports level distribution automatically.',
      input_schema: {
        type: 'object',
        properties: {
          meet_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of numeric MSO meet IDs (e.g. ["34670"])',
          },
        },
        required: ['meet_ids'],
      },
    },
    {
      name: 'scorecat_extract',
      description: 'Extract athlete data from ScoreCat/Firebase. Handles Firebase SDK, Firestore queries, field mapping. Reports level distribution automatically.',
      input_schema: {
        type: 'object',
        properties: {
          meet_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of Algolia meet IDs (e.g. ["VQS0J5FI"])',
          },
        },
        required: ['meet_ids'],
      },
    },

    // --- Meet search ---
    {
      name: 'search_meets',
      description: 'Search for gymnastics meets across MSO and ScoreCat. Returns structured results with meet IDs, names, dates, and sources. Use this instead of browsing websites.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query (e.g., "Nevada State 2026")' },
          state: { type: 'string', description: 'Optional state filter (e.g., "NV", "Nevada")' },
        },
        required: ['query'],
      },
    },

    {
      name: 'lookup_meet',
      description: 'Look up a specific meet by its exact source ID. Returns metadata (name, dates, location, athlete count). You must know the exact ID — this is NOT a search tool.',
      input_schema: {
        type: 'object',
        properties: {
          source: { type: 'string', enum: ['mso'], description: 'Data source (currently only "mso" supported)' },
          meet_id: { type: 'string', description: 'The exact meet ID from the source (e.g., "34508" for MSO)' },
        },
        required: ['source', 'meet_id'],
      },
    },

    // --- Database tools ---
    {
      name: 'build_database',
      description: 'Parse extracted data and build the SQLite database with winners. Handles gym normalization, winner determination, and division ordering automatically.',
      input_schema: {
        type: 'object',
        properties: {
          source: { type: 'string', enum: ['scorecat', 'generic'], description: 'Data format: "generic" for mso_extract JSON, "scorecat" for scorecat_extract JSON' },
          data_path: { type: 'string', description: 'Path to extracted data file(s). For multiple sources, pass comma-separated paths: "file1.json,file2.json"' },
          state: { type: 'string', description: 'State name (e.g., Iowa, Maryland)' },
          meet_name: { type: 'string', description: 'Meet name (e.g., 2025 Iowa State Championships)' },
          association: { type: 'string', description: 'USAG or AAU (default: USAG)' },
          year: { type: 'number', description: 'Meet year (auto-detected if omitted)' },
          gym_map: { type: 'string', description: 'Path to gym name mapping JSON file' },
          division_order: { type: 'string', description: 'Comma-separated divisions youngest-to-oldest (use when UNKNOWN_DIVISIONS appears)' },
          postmark_date: { type: 'string', description: 'Postmark deadline date (format: "April 4, 2025" — full month name, day, and year)' },
          online_date: { type: 'string', description: 'Online ordering deadline date (format: "April 4, 2025" — full month name, day, and year)' },
          ship_date: { type: 'string', description: 'Shipping date (format: "April 4, 2025" — full month name, day, and year)' },
          source_id: { type: 'string', description: 'Source meet ID (e.g., MSO meet ID "34508", ScoreCat Algolia ID)' },
          source_name: { type: 'string', description: 'Canonical name from the source (e.g., MSO\'s "2025 Mississippi State Championship")' },
          meet_dates: { type: 'string', description: 'Meet dates for metadata (e.g., "Mar 14-16, 2025")' },
        },
        required: ['source', 'data_path', 'state', 'meet_name'],
      },
    },
    {
      name: 'regenerate_output',
      description: 'Regenerate specific output files from existing database. Much faster than full pipeline — use for layout tweaks, date changes, style adjustments.',
      input_schema: {
        type: 'object',
        properties: {
          state: { type: 'string', description: 'State name' },
          meet_name: { type: 'string', description: 'Meet name' },
          outputs: {
            type: 'array',
            items: { type: 'string' },
            description: 'Which outputs to regenerate. Values: shirt, idml, order_forms, gym_highlights, summary, all',
          },
          line_spacing: { type: 'number', description: 'Line spacing (default 1.15, lower = tighter)' },
          level_gap: { type: 'number', description: 'Gap between level groups (default 6)' },
          max_fill: { type: 'number', description: 'Max page fill ratio (default 0.90)' },
          min_font_size: { type: 'number', description: 'Minimum font size (default 6.5)' },
          max_font_size: { type: 'number', description: 'Maximum font size (default 9)' },
          max_shirt_pages: { type: 'number', description: 'Force fit into N total pages' },
          level_groups: { type: 'string', description: 'Semicolon-separated groups, comma-separated levels: "XSA,XD;10,9,8"' },
          page_size_legal: { type: 'string', description: 'Group name(s) for 8.5x14 version. Generates separate _8.5x14.pdf.' },
          exclude_levels: { type: 'string', description: 'Comma-separated levels to exclude from shirt' },
          postmark_date: { type: 'string', description: 'Postmark deadline date (format: "April 4, 2025" — full month name, day, and year)' },
          online_date: { type: 'string', description: 'Online ordering deadline date (format: "April 4, 2025" — full month name, day, and year)' },
          ship_date: { type: 'string', description: 'Shipping date (format: "April 4, 2025" — full month name, day, and year)' },
          accent_color: { type: 'string', description: 'Hex color for accents (default #FF0000)' },
          font_family: { type: 'string', enum: ['serif', 'sans-serif'], description: 'Font family (serif=Times, sans-serif=Helvetica)' },
          title1_size: { type: 'number', description: 'Title line 1 font size (default 18)' },
          title2_size: { type: 'number', description: 'Title line 2 font size (default 20)' },
          header_size: { type: 'number', description: 'Column header font size (default 11)' },
          divider_size: { type: 'number', description: 'Level divider text size (default 10)' },
          copyright: { type: 'string', description: 'Copyright text' },
          sport: { type: 'string', description: 'Sport name' },
          title_prefix: { type: 'string', description: 'Title prefix text' },
          division_order: { type: 'string', description: 'Comma-separated divisions youngest-to-oldest' },
          name_sort: { type: 'string', enum: ['age', 'alpha'], description: 'Name sort order (default: age)' },
          gym_map: { type: 'string', description: 'Path to gym name mapping JSON file' },
          force: { type: 'boolean', description: 'Force overwrite of imported outputs' },
        },
        required: ['state', 'meet_name', 'outputs'],
      },
    },
    {
      name: 'import_pdf_backs',
      description: 'Import designer-edited back_of_shirt PDFs exported from InDesign. Accepts any number of PDF paths. The system auto-detects page sizes (letter vs legal). For order forms, legal pages are scaled to letter size unless a letter-size version is also provided. Regenerates order_forms and gym_highlights automatically.',
      input_schema: {
        type: 'object',
        properties: {
          pdf_paths: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of PDF file paths. Each PDF is one back page. System detects letter (8.5x11) vs legal (8.5x14) from page dimensions.',
          },
          state: { type: 'string', description: 'State name' },
          meet_name: { type: 'string', description: 'Meet name' },
          postmark_date: { type: 'string', description: 'Postmark deadline date (format: "April 4, 2025" — full month name, day, and year)' },
          online_date: { type: 'string', description: 'Online ordering deadline date (format: "April 4, 2025" — full month name, day, and year)' },
          ship_date: { type: 'string', description: 'Shipping date (format: "April 4, 2025" — full month name, day, and year)' },
        },
        required: ['pdf_paths', 'state', 'meet_name'],
      },
    },
    // --- Data tools ---
    {
      name: 'save_to_file',
      description: 'Save string data to a file in the data directory.',
      input_schema: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'Filename (saved in data directory)' },
          content: { type: 'string', description: 'The string content to write' },
        },
        required: ['filename', 'content'],
      },
    },
    {
      name: 'query_db',
      description: 'Run a SQL SELECT query against the SQLite database. Returns up to 50 rows.',
      input_schema: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'SQL SELECT query to execute' },
        },
        required: ['sql'],
      },
    },
    {
      name: 'query_db_to_file',
      description: 'Run a SQL query and save results to CSV.',
      input_schema: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'SQL SELECT query' },
          filename: { type: 'string', description: 'Output CSV filename' },
        },
        required: ['sql', 'filename'],
      },
    },
    {
      name: 'list_output_files',
      description: 'List files in the meet output directory.',
      input_schema: {
        type: 'object',
        properties: {
          meet_name: { type: 'string', description: 'Optional meet name (defaults to current meet)' },
        },
      },
    },
    {
      name: 'list_meets',
      description: 'List all meets in the database.',
      input_schema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'get_meet_summary',
      description: 'Get summary statistics for a meet (athlete count, gym count, breakdown, winners).',
      input_schema: {
        type: 'object',
        properties: {
          meet_name: { type: 'string', description: 'The meet name to summarize' },
        },
        required: ['meet_name'],
      },
    },

    // --- Skill tools (always available) ---
    {
      name: 'list_skills',
      description: 'List all available skill documents.',
      input_schema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'load_skill',
      description: 'Load a skill document into context for detailed instructions.',
      input_schema: {
        type: 'object',
        properties: {
          skill_name: { type: 'string', description: 'Skill name (without .md extension)' },
        },
        required: ['skill_name'],
      },
    },
    // --- User interaction (always available) ---
    {
      name: 'ask_user',
      description: 'Pause and ask the user a question with selectable options. Returns the text of the chosen option.',
      input_schema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question to display' },
          options: {
            type: 'array',
            items: { type: 'string' },
            description: 'Option strings for the user to choose from',
          },
        },
        required: ['question', 'options'],
      },
    },

    // --- Progress (always available) ---
    {
      name: 'save_progress',
      description: 'Save progress state for resumption if context limits are reached.',
      input_schema: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'Summary of accomplishments' },
          next_steps: { type: 'string', description: 'What needs to be done next' },
          data_files: { type: 'string', description: 'Optional JSON array of {path, description}' },
        },
        required: ['summary', 'next_steps'],
      },
    },
    {
      name: 'load_progress',
      description: 'Load previously saved progress state.',
      input_schema: {
        type: 'object',
        properties: {},
      },
    },

    // --- File tools (always available) ---
    {
      name: 'read_file',
      description: 'Read a local file. Returns contents with line numbers.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path or filename in data directory' },
          offset: { type: 'number', description: 'Starting line (1-based, default 1)' },
          limit: { type: 'number', description: 'Max lines to return' },
        },
        required: ['path'],
      },
    },
    {
      name: 'run_script',
      description: 'Execute inline Python code. Environment variables DB_PATH, DATA_DIR, STAGING_DB_PATH are set. UTF-8 encoding is enforced automatically.',
      input_schema: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'Python source code to execute' },
          timeout: { type: 'number', description: 'Max execution time in ms (default 30000)' },
        },
        required: ['code'],
      },
    },

    // --- Finalization (output_finalize phase) ---
    {
      name: 'finalize_meet',
      description: 'Merge staging database into central database. Call after quality checks pass and user approves outputs.',
      input_schema: {
        type: 'object',
        properties: {
          meet_name: { type: 'string', description: 'The meet name to finalize' },
        },
        required: ['meet_name'],
      },
    },

    // --- Output tools ---
    {
      name: 'set_output_name',
      description: 'Set a clean folder name for outputs. Required before build_database. Example: "2025 SC State Championships".',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Clean folder name' },
        },
        required: ['name'],
      },
    },
    {
      name: 'render_pdf_page',
      description: 'Render a PDF page as an image for visual inspection. Use to check layout quality.',
      input_schema: {
        type: 'object',
        properties: {
          pdf_path: { type: 'string', description: 'Path to PDF (defaults to back_of_shirt.pdf)' },
          page_number: { type: 'number', description: 'Page number (1-based, default 1)' },
        },
      },
    },
    {
      name: 'open_file',
      description: 'Open a file on the user\'s computer in their default application.',
      input_schema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Path to the file to open' },
        },
        required: ['file_path'],
      },
    },
  ];
}
