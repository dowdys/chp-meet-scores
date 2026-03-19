/**
 * Tool definitions exposed to the LLM.
 * Extracted from agent-loop.ts for maintainability.
 */

import { ToolDefinition } from './llm-client';

export function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: 'http_fetch',
      description: 'Make a headless HTTP request (no browser needed). Use for REST APIs like Algolia search, MSO JSON API, or any URL that returns data. Responses over 5KB are auto-saved to a file and a summary is returned instead.',
      input_schema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL to fetch' },
          method: { type: 'string', description: 'HTTP method (GET, POST, etc.). Defaults to GET.' },
          headers: { type: 'string', description: 'JSON string of headers object, e.g. {"Content-Type": "application/json"}' },
          body: { type: 'string', description: 'Request body (for POST/PUT). Can be JSON string or form-encoded.' },
          max_response_size: { type: 'number', description: 'Max inline response size in chars (default 50000). Responses larger than 5000 chars are always saved to file.' },
        },
        required: ['url'],
      },
    },
    {
      name: 'web_search',
      description: 'Search for meet results pages using Google. Returns search results as text. Only use as a last resort — try http_fetch with Algolia or MSO APIs first.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query to find meet results' },
        },
        required: ['query'],
      },
    },
    {
      name: 'chrome_navigate',
      description: 'Navigate Chrome to a URL. Returns the page title after loading.',
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
      description: 'Run JavaScript in the Chrome page context and return the result. Only use for small results (< 10KB). For bulk data extraction, use chrome_save_to_file instead.',
      input_schema: {
        type: 'object',
        properties: {
          script: { type: 'string', description: 'JavaScript code to execute in the page' },
        },
        required: ['script'],
      },
    },
    {
      name: 'chrome_save_to_file',
      description: 'Run JavaScript in Chrome and save the result directly to a file. The script can be async (returns a Promise) — it will be awaited up to timeout. Use this for bulk data extraction. The result goes to a file, not into context.',
      input_schema: {
        type: 'object',
        properties: {
          script: { type: 'string', description: 'JavaScript code to execute in the page' },
          filename: { type: 'string', description: 'Filename for the output (saved in the data directory)' },
          timeout_ms: { type: 'number', description: 'Timeout in milliseconds (default 60000, max 120000)' },
        },
        required: ['script', 'filename'],
      },
    },
    {
      name: 'chrome_screenshot',
      description: 'Take a screenshot of the current Chrome page for debugging. Returns the file path of the saved screenshot.',
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
    {
      name: 'mso_extract',
      description: 'Extract all athlete data from MeetScoresOnline.com using the proven JSON API method. Handles navigation, same-origin cookies, API calls, HTML entity decoding, name cleaning (strips event annotations), and field mapping. Saves a clean JSON array of athlete objects to data/mso_extract_*.json. Use run_python --source generic on the output file.',
      input_schema: {
        type: 'object',
        properties: {
          meet_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of numeric MSO meet IDs (e.g. ["34670", "34671"])',
          },
        },
        required: ['meet_ids'],
      },
    },
    {
      name: 'scorecat_extract',
      description: 'Extract all athlete data from ScoreCat/Firebase using the proven Firestore SDK method. Handles navigation to ScoreCat (loads Firebase SDK), waits for SDK init, queries ff_scores collection by meetId, and maps all fields. Saves a clean JSON array of athlete objects to data/scorecat_extract_*.json. Use run_python --source scorecat on the output file.',
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
    {
      name: 'save_to_file',
      description: 'Save string data to a file in the meet data directory.',
      input_schema: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'Filename (will be placed in the meet data directory)' },
          content: { type: 'string', description: 'The string content to write to the file' },
        },
        required: ['filename', 'content'],
      },
    },
    {
      name: 'run_python',
      description: 'Run process_meet.py to build the database and generate outputs. The --db and --output are ALWAYS auto-injected (do NOT pass them). Full pipeline: --source {scorecat,mso_pdf,mso_html,generic} --data <path> --state <State> --meet "<Meet Name>" [--association USAG|AAU] [--year YYYY]. SELECTIVE REGENERATION: Use --regenerate to skip parsing/DB build and just regenerate specific outputs from the existing database. Values: shirt, idml, order_forms, gym_highlights, summary, all. MULTIPLE values can be comma-separated: --regenerate order_forms,gym_highlights. Always combine related outputs into ONE --regenerate call. Example: --regenerate shirt (only regenerates back_of_shirt.pdf and dependents). This is MUCH faster than a full run — use it when adjusting layout params like font size or spacing. When using --regenerate, only --state and --meet are required (--source and --data are NOT needed). Example: --state Iowa --meet "2025 Iowa State Championships" --regenerate shirt. PDF layout tuning: --line-spacing <float> (default 1.15), --level-gap <float> (default 6), --max-fill <float> (default 0.90), --min-font-size <float> (default 6.5), --max-font-size <float> (default 9). Order form dates: --postmark-date, --online-date, --ship-date. IDML IMPORT: Use --import-idml <path> to convert a finalized IDML file (edited in InDesign) back into back_of_shirt.pdf, then automatically regenerates gym_highlights.pdf, order_forms.pdf, and meet_summary.txt. The IDML contains embedded metadata (meet name, state, year) which is used automatically — you do NOT need to provide --state or --meet. After --import-idml completes, do NOT call finalize_meet (IDML imports use the central DB directly). IDML IMPORT WITH DATES: You CAN pass date flags with --import-idml. Example: --import-idml <path> --postmark-date "April 4, 2026" --online-date "April 8, 2026" --ship-date "April 20, 2026". ADDING DATES AFTER IMPORT: If you need to change just the order form dates after an import, use --regenerate order_forms with date flags: --state <State> --meet "<Meet Name>" --regenerate order_forms --postmark-date "..." --online-date "..." --ship-date "...". This regenerates ONLY the order forms without touching back_of_shirt. CRITICAL: NEVER run full pipeline (--source generic) after --import-idml — it overwrites the user\'s edited IDML design. Use --regenerate order_forms instead. PAGE SIZE: IMPORTANT - there are TWO different flags. Use --page-size-legal "XCEL" (with group name) to generate an 8.5x14 version of ONLY the specified page group(s). This is what you usually want - it generates back_of_shirt_8.5x14.pdf containing only the named groups at legal size. The standard back_of_shirt.pdf always contains ALL pages at 8.5x11. Do NOT use --page-size legal (without group name) unless you want ALL pages at legal size. Order forms ALWAYS use the 8.5x11 version. When importing an 8.5x14 IDML, the page size is auto-detected. NAME CLEANING: Names are auto-cleaned before going on the shirt (parenthetical annotations, event codes like VT UB BB FX, pronunciation guides are stripped). If the output shows "SUSPICIOUS_NAMES", review each flagged name and fix if needed using query_db to UPDATE the winners table. If "NAME_CLEANUP" appears, verify the auto-cleaned names look correct. DIVISION ORDERING: Names on the shirt are sorted youngest-to-oldest by division (Child < Junior < Senior etc). Common division names are auto-detected. If the output shows "UNKNOWN_DIVISIONS: ...", you MUST determine the youngest-to-oldest order of those divisions based on their names (e.g. "Petite" is younger than "Cadet") and re-run with --division-order "div1,div2,div3,..." listing ALL divisions in youngest-to-oldest order. This overrides auto-detection. FILE LOCKING: If a PDF is open in a viewer, the script saves as <name>_NEW.pdf automatically — it will NOT fail. Windows paths are auto-converted to WSL paths. Expected output files: back_of_shirt.pdf, back_of_shirt.idml, gym_highlights.pdf, order_forms.pdf, meet_summary.txt. When --page-size legal is used, also: back_of_shirt_8.5x14.pdf, back_of_shirt_8.5x14.idml. Do NOT generate order_forms_by_gym.txt or winners_sheet.csv — those are deprecated.',
      input_schema: {
        type: 'object',
        properties: {
          args: { type: 'string', description: 'Full pipeline: --source {scorecat,mso_pdf,mso_html,generic} --data <path> --state <State> --meet "<Meet Name>" [--year YYYY] [layout flags] [date flags]. Selective regeneration (no --source/--data needed): --state <State> --meet "<Meet Name>" --regenerate order_forms,gym_highlights (comma-separated, combine into ONE call). Layout: --line-spacing 1.15 --level-gap 6 --max-fill 0.90 --min-font-size 6.5 --max-font-size 9 --max-shirt-pages N. Dates: --postmark-date "March 15, 2026" --online-date "..." --ship-date "...". Division ordering: --division-order "Petite,Cadet,Junior,Senior" (youngest-to-oldest, use when UNKNOWN_DIVISIONS appears in output). IDML import with dates: --import-idml <path> --postmark-date "..." --online-date "..." --ship-date "..." (self-contained, do NOT finalize_meet after). To change dates after import: --state <State> --meet "<Meet Name>" --regenerate order_forms --postmark-date "..." --online-date "..." --ship-date "..." (does NOT touch back_of_shirt). NEVER use --source after --import-idml. Quote paths with spaces.' },
        },
        required: ['args'],
      },
    },
    {
      name: 'query_db',
      description: 'Run a SQL SELECT query against the meet SQLite database. Returns up to 50 rows as formatted text.',
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
      description: 'Run a SQL query and save results to a CSV file in the meet data directory.',
      input_schema: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'SQL SELECT query to execute' },
          filename: { type: 'string', description: 'Output CSV filename' },
        },
        required: ['sql', 'filename'],
      },
    },
    {
      name: 'list_output_files',
      description: 'List files in the meet output directory. If no meet_name is provided, uses the current meet.',
      input_schema: {
        type: 'object',
        properties: {
          meet_name: { type: 'string', description: 'Optional meet name to list files for (defaults to current meet)' },
        },
      },
    },
    {
      name: 'chrome_network',
      description: 'Monitor network requests in the Chrome page. Returns recent network request URLs and types.',
      input_schema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'list_meets',
      description: 'List all meets in the database with their state, association, and result count.',
      input_schema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'get_meet_summary',
      description: 'Get summary statistics for a specific meet (athlete count, gym count, session/level/division breakdown, winner count).',
      input_schema: {
        type: 'object',
        properties: {
          meet_name: { type: 'string', description: 'The meet name to summarize' },
        },
        required: ['meet_name'],
      },
    },
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
      description: 'Load a skill document into context for detailed instructions. Available skills: meet_discovery, scorecat_extraction, mso_pdf_extraction, mso_html_extraction, database_building, output_generation, data_quality, general_scraping.',
      input_schema: {
        type: 'object',
        properties: {
          skill_name: { type: 'string', description: 'Name of the skill to load (without .md extension)' },
        },
        required: ['skill_name'],
      },
    },
    {
      name: 'load_skill_detail',
      description: 'Load a detail skill document for edge cases and deep dives. Available details: scorecat_edge_cases, pdf_layout_calibration, division_ordering, scraping_network, scraping_dom, scraping_sdk, scraping_download.',
      input_schema: {
        type: 'object',
        properties: {
          detail_name: { type: 'string', description: 'Name of the detail skill (without path prefix or .md extension)' },
        },
        required: ['detail_name'],
      },
    },
    {
      name: 'save_draft_skill',
      description: 'Save a draft skill document for a new meet source platform.',
      input_schema: {
        type: 'object',
        properties: {
          platform_name: { type: 'string', description: 'Name of the platform (used as filename)' },
          content: { type: 'string', description: 'Markdown content of the skill document' },
        },
        required: ['platform_name', 'content'],
      },
    },
    {
      name: 'ask_user',
      description: 'Pause and ask the user to choose from a list of options. Use this when you find multiple meets matching a search and need the user to pick one, or any time you need user input to continue. Returns the text of the option the user clicked.',
      input_schema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question to display to the user' },
          options: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of option strings for the user to choose from',
          },
        },
        required: ['question', 'options'],
      },
    },
    {
      name: 'save_progress',
      description: 'Save current progress state so work can be resumed if context limits are reached.',
      input_schema: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'Summary of what has been accomplished so far' },
          next_steps: { type: 'string', description: 'What needs to be done next' },
          data_files: { type: 'string', description: 'Optional JSON-encoded array of {path, description} for data files produced so far. Example: [{"path":"data/mso_extract_123.json","description":"1804 athletes from MSO meetId 34670"}]' },
        },
        required: ['summary', 'next_steps'],
      },
    },
    {
      name: 'load_progress',
      description: 'Load previously saved progress state to resume work.',
      input_schema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'read_file',
      description: 'Read a local file from the data directory or output directory. Returns file contents with line numbers. Use this instead of Chrome file:// URLs or browser-based file access.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path or filename in the data directory' },
          offset: { type: 'number', description: 'Starting line number (1-based, default 1)' },
          limit: { type: 'number', description: 'Max lines to return (default: all)' },
        },
        required: ['path'],
      },
    },
    {
      name: 'run_script',
      description: 'Execute inline Python code. Environment variables DB_PATH, DATA_DIR, and STAGING_DB_PATH are set. Print results to stdout. Use for data transforms, DB queries, gym name analysis, date conversions, etc. IMPORTANT: The app\'s Python processing code (process_meet.py) is a compiled binary — you CANNOT find or edit its source code on this machine. Do NOT use subprocess/find/os.walk to search for .py source files. If you need a feature the binary doesn\'t support, tell the user it requires a code change.',
      input_schema: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'Python source code to execute' },
          timeout: { type: 'number', description: 'Max execution time in ms (default 30000)' },
        },
        required: ['code'],
      },
    },
    {
      name: 'finalize_meet',
      description: 'Merge staging database into central database. Call this after data quality checks pass. run_python writes to a staging DB — this tool copies the verified data into the permanent central database. IMPORTANT: Do NOT call this after --import-idml — IDML imports use the central DB directly (no staging DB exists). Only call finalize_meet after a full pipeline run (--source ...).',
      input_schema: {
        type: 'object',
        properties: {
          meet_name: { type: 'string', description: 'The meet name to finalize' },
        },
        required: ['meet_name'],
      },
    },
    {
      name: 'set_output_name',
      description: 'Set a clean, short name for the output folder. Call this BEFORE run_python. The user\'s raw input is often a long sentence — use this tool to set a proper folder name like "2025 SC State Championships" instead. Keep it concise: "{year} {state abbreviation} State Championships" or similar.',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Clean folder name, e.g. "2025 SC State Championships"' },
        },
        required: ['name'],
      },
    },
    {
      name: 'render_pdf_page',
      description: 'Render a PDF page as an image so you can visually inspect it. Use this after generating back_of_shirt.pdf to check sizing, spacing, and layout. Returns the rendered page as an image you can see. If the layout needs adjustment, re-run run_python with different --line-spacing, --level-gap, --max-fill, --min-font-size, --max-font-size, or --max-shirt-pages values. Use --max-shirt-pages N to force all levels to fit within N total pages.',
      input_schema: {
        type: 'object',
        properties: {
          pdf_path: { type: 'string', description: 'Absolute path to the PDF file. If omitted, defaults to back_of_shirt.pdf in the output directory.' },
          page_number: { type: 'number', description: 'Page number to render (1-based). Defaults to 1.' },
        },
      },
    },
    {
      name: 'open_file',
      description: 'Open a file on the user\'s computer using their default application (e.g., PDF viewer for .pdf, Excel for .csv). Use this to let the user review output files before asking for feedback. The file opens in a separate window the user can see.',
      input_schema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute path to the file to open. If a relative name like "back_of_shirt.pdf" is given, it will be resolved to the output directory.' },
        },
        required: ['file_path'],
      },
    },
  ];
}
