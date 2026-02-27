/**
 * Agent Loop - Orchestrates LLM calls and tool execution for meet processing.
 * Manages conversation history, token tracking, skill loading, and progress save/load.
 */

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { LLMClient, LLMMessage, ContentBlock, ToolDefinition, LLMResponse, ToolResultContent, ImageContentPart, TextContentPart } from './llm-client';
import { pythonManager } from './python-manager';
import { configStore } from './config-store';
import { getStagingDbPath, resetStagingDb } from './tools/python-tools';
import { getProjectRoot as sharedGetProjectRoot, getDataDir as sharedGetDataDir } from './paths';

/** Extract the text portion of a tool result content (ignoring images). */
function toolResultText(content: ToolResultContent | undefined): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  return content.filter((p): p is TextContentPart => p.type === 'text').map(p => p.text).join('\n');
}

// --- Types ---

interface AgentContext {
  meetName: string;
  outputName?: string; // Clean folder name set by set_output_name tool
  state?: string;
  systemPrompt: string;
  loadedSkills: string[];
  messages: LLMMessage[];
  totalInputTokens: number;
  totalOutputTokens: number;
  onActivity: (message: string, level: 'info' | 'success' | 'error' | 'warning') => void;
  abortRequested: boolean;
}

interface ToolExecutor {
  [toolName: string]: (args: Record<string, unknown>) => Promise<string>;
}

interface ProgressData {
  summary: string;
  next_steps: string;
  loaded_skills: string[];
  meet_name: string;
  timestamp: string;
  data_files?: Array<{ path: string; description: string }>;
}

// --- Tool definitions exposed to the LLM ---

function getToolDefinitions(): ToolDefinition[] {
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
      description: 'Run process_meet.py to build the database and generate outputs. The --db (central database path) and --output (output directory) are ALWAYS auto-injected (do NOT pass them). You only need: --source {scorecat,mso_pdf,mso_html,generic} --data <path> --state <State> --meet "<Meet Name>" [--association USAG|AAU] [--year YYYY]. Back-of-shirt PDF and order forms PDF are always generated (title auto-derived from --state and --year). The --year defaults to the current year. For --data: can be a single file, a directory of JSON files, or a glob pattern (e.g. /path/to/data/js_result_*.json). Use --source generic for JSON/TSV data from any source. PDF layout tuning: --line-spacing <float> (line height ratio, default 1.15, lower=tighter), --level-gap <float> (gap before each level section, default 6), --max-fill <float> (max page fill 0-1, default 0.90), --min-font-size <float> (minimum name font size in pt, default 6.5), --max-font-size <float> (maximum/starting name font size in pt, default 9; raise to 11-12 for meets with few winners). Use render_pdf_page after generating to visually inspect and tune these values.',
      input_schema: {
        type: 'object',
        properties: {
          args: { type: 'string', description: 'Command-line arguments: --source {scorecat,mso_pdf,mso_html,generic} --data <path_to_data_file> --state <State> --meet "<Meet Name>" [--association USAG|AAU] [--year YYYY] [--line-spacing 1.15] [--level-gap 6] [--max-fill 0.90] [--min-font-size 6.5] [--max-font-size 9]. The --year sets championship year for PDF titles (defaults to current year). Use "generic" for JSON or TSV data from any source (auto-detects format, maps column names flexibly). Layout params let you tune the back-of-shirt PDF spacing and sizing. Raise --max-font-size (e.g. 12) for meets with few winners so names appear larger.' },
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
      description: 'Execute inline Python code. Environment variables DB_PATH, DATA_DIR, and STAGING_DB_PATH are set. Print results to stdout. Use this for data transforms, DB queries with pandas, gym name analysis, etc.',
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
      description: 'Merge staging database into central database. Call this after data quality checks pass. run_python writes to a staging DB — this tool copies the verified data into the permanent central database.',
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
      description: 'Render a PDF page as an image so you can visually inspect it. Use this after generating back_of_shirt.pdf to check sizing, spacing, and layout. Returns the rendered page as an image you can see. If the layout needs adjustment, re-run run_python with different --line-spacing, --level-gap, --max-fill, --min-font-size, or --max-font-size values.',
      input_schema: {
        type: 'object',
        properties: {
          pdf_path: { type: 'string', description: 'Absolute path to the PDF file. If omitted, defaults to back_of_shirt.pdf in the output directory.' },
          page_number: { type: 'number', description: 'Page number to render (1-based). Defaults to 1.' },
        },
      },
    },
  ];
}

// --- Helper: resolve directories ---

function getProjectRoot(): string {
  return sharedGetProjectRoot();
}

function getOutputDir(meetName: string): string {
  const outputBase = configStore.get('outputDir') || path.join(app.getPath('documents'), 'Gymnastics Champions');
  const meetDir = path.join(outputBase, meetName);
  if (!fs.existsSync(meetDir)) {
    fs.mkdirSync(meetDir, { recursive: true });
  }
  return meetDir;
}

function getDataDir(): string {
  return sharedGetDataDir();
}

function getDbPath(): string {
  return path.join(getDataDir(), 'chp_results.db');
}

function getProgressFilePath(): string {
  return path.join(getDataDir(), 'agent_progress.json');
}

function getSkillsDir(): string {
  return path.join(getProjectRoot(), 'skills');
}

// --- Agent Loop ---

export class AgentLoop {
  private llmClient: LLMClient;
  private toolExecutors: ToolExecutor;
  private onActivity: (message: string, level: 'info' | 'success' | 'error' | 'warning') => void;
  private queryConversation: LLMMessage[] = [];
  private activeContext: AgentContext | null = null;

  constructor(
    llmClient: LLMClient,
    toolExecutor: ToolExecutor,
    onActivity: (message: string, level: 'info' | 'success' | 'error' | 'warning') => void
  ) {
    this.llmClient = llmClient;
    this.toolExecutors = toolExecutor;
    this.onActivity = onActivity;
  }

  /**
   * Request the agent loop to stop gracefully.
   * The loop checks this flag at the top of each iteration.
   */
  requestStop(): void {
    if (this.activeContext) {
      this.activeContext.abortRequested = true;
      this.onActivity('Stop requested — finishing current step...', 'warning');
    }
  }

  /**
   * Process a meet (main entry point for Process tab).
   */
  async processMeet(meetName: string): Promise<{ success: boolean; message: string }> {
    this.onActivity(`Starting agent for meet: ${meetName}`, 'info');

    try {
      // Load system prompt
      const systemPrompt = this.loadSystemPrompt();
      // Reset staging DB for a fresh meet
      resetStagingDb();

      const context: AgentContext = {
        meetName,
        systemPrompt,
        loadedSkills: [],
        messages: [],
        totalInputTokens: 0,
        totalOutputTokens: 0,
        onActivity: this.onActivity,
        abortRequested: false,
      };

      // Store context ref for external abort
      this.activeContext = context;

      // Check for saved progress
      const savedProgress = await this.loadProgress();
      if (savedProgress && savedProgress.meet_name === meetName) {
        this.onActivity('Found saved progress, resuming...', 'info');
        context.loadedSkills = savedProgress.loaded_skills;

        // Build file inventory from data/ directory
        const dataDir = getDataDir();
        let fileInventory = '';
        try {
          const allFiles = fs.readdirSync(dataDir)
            .filter(f => f.endsWith('.json') && f !== 'agent_progress.json');
          if (allFiles.length > 0) {
            const fileLines = allFiles.map(f => {
              const stats = fs.statSync(path.join(dataDir, f));
              const sizeKB = (stats.size / 1024).toFixed(1);
              return `  ${path.join(dataDir, f)} (${sizeKB} KB)`;
            });
            fileInventory = `\n\nData directory: ${dataDir}\nData files:\n${fileLines.join('\n')}`;
          }
        } catch {
          // data dir might not exist yet
        }

        // Verify tracked data files if any
        let trackedFileStatus = '';
        if (savedProgress.data_files && savedProgress.data_files.length > 0) {
          const statusLines = savedProgress.data_files.map(df => {
            const exists = fs.existsSync(df.path);
            const marker = exists ? '[EXISTS]' : '[MISSING]';
            return `  ${marker} ${df.path} — ${df.description}`;
          });
          trackedFileStatus = `\n\nTracked data files:\n${statusLines.join('\n')}`;
        }

        context.messages.push({
          role: 'user',
          content: `You are resuming work on meet "${meetName}". Here is your previous progress:\n\nSummary: ${savedProgress.summary}\n\nNext steps: ${savedProgress.next_steps}${fileInventory}${trackedFileStatus}\n\nPlease continue from where you left off.`,
        });
      } else {
        // Fresh start
        context.messages.push({
          role: 'user',
          content: `Please process the gymnastics meet: "${meetName}"\n\nFind the meet results online, extract all athlete scores, build the database, check data quality, and generate the output files (back-of-shirt names, per-gym order forms, winners CSV). Use the load_skill tool to get detailed instructions for each step.`,
        });
      }

      // Build tool executors with context bound to this meet
      this.buildToolExecutors(context);

      // Run the agent loop
      const result = await this.runLoop(context);

      // Save the full process log for review
      this.saveProcessLog(context, result);
      this.activeContext = null;

      return result;
    } catch (err) {
      this.activeContext = null;
      const message = err instanceof Error ? err.message : String(err);
      this.onActivity(`Agent error: ${message}`, 'error');
      return { success: false, message };
    }
  }

  /**
   * Query results (entry point for Query tab - maintains conversation).
   */
  async queryResults(question: string): Promise<{ success: boolean; answer: string }> {
    try {
      const systemPrompt = this.loadSystemPrompt();

      // Build query-specific system prompt
      const querySystem = systemPrompt + '\n\n## Query Mode\nYou are answering questions about previously processed meet data. Use the query_db tool to look up data in the SQLite database. Give clear, concise answers.';

      // Add user question to ongoing conversation
      this.queryConversation.push({
        role: 'user',
        content: question,
      });

      // Build minimal tool set for queries
      const queryTools = getToolDefinitions().filter((t) =>
        ['query_db', 'query_db_to_file', 'list_output_files'].includes(t.name)
      );

      // Create a temporary context for the query
      const dummyContext: AgentContext = {
        meetName: '_query',
        systemPrompt: querySystem,
        loadedSkills: [],
        messages: this.queryConversation,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        onActivity: this.onActivity,
        abortRequested: false,
      };
      this.buildToolExecutors(dummyContext);

      // Single LLM call (possibly with tool use)
      let answer = '';
      let iterations = 0;
      const maxIterations = 10;

      while (iterations < maxIterations) {
        iterations++;

        const response = await this.llmClient.sendMessage({
          system: querySystem,
          messages: this.queryConversation,
          tools: queryTools,
        });

        if (response.stop_reason === 'end_turn' || response.stop_reason === 'max_tokens') {
          // Extract text answer
          const textBlocks = response.content.filter((b) => b.type === 'text');
          answer = textBlocks.map((b) => b.text ?? '').join('\n');
          this.queryConversation.push({ role: 'assistant', content: response.content });
          break;
        }

        if (response.stop_reason === 'tool_use') {
          // Add assistant message with tool calls
          this.queryConversation.push({ role: 'assistant', content: response.content });

          // Execute tool calls and collect results
          const toolResults = await this.executeToolCalls(response.content, dummyContext);
          this.queryConversation.push({ role: 'user', content: toolResults });
        }
      }

      return { success: true, answer };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.onActivity(`Query error: ${message}`, 'error');
      return { success: false, answer: message };
    }
  }

  // --- Private methods ---

  /**
   * Load the system prompt from skills/system-prompt.md.
   */
  private loadSystemPrompt(): string {
    const promptPath = path.join(getSkillsDir(), 'system-prompt.md');
    const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    let prompt: string;
    try {
      prompt = fs.readFileSync(promptPath, 'utf-8');
    } catch {
      prompt = 'You are a gymnastics meet scoring assistant. Process meet data and generate outputs.';
    }
    return `Today's date is ${today}.\n\n${prompt}`;
  }

  /**
   * Main agent loop: send messages, handle tool use, repeat until done.
   */
  private async runLoop(context: AgentContext): Promise<{ success: boolean; message: string }> {
    const tools = getToolDefinitions();
    const contextLimit = this.llmClient.getContextLimit();
    const maxIterations = 100;
    let iterations = 0;

    // Build the system prompt including any loaded skills
    const buildSystem = (): string => {
      let system = context.systemPrompt;
      if (context.loadedSkills.length > 0) {
        system += '\n\n## Loaded Skills\nThe following skill documents have been loaded into context: ' +
          context.loadedSkills.join(', ');
      }
      return system;
    };

    while (iterations < maxIterations) {
      iterations++;

      // Check if abort was requested
      if (context.abortRequested) {
        this.onActivity('Stop requested by user. Saving progress...', 'warning');
        await this.autoSaveProgress(context);
        this.saveProcessLog(context, { success: true, message: 'Run stopped by user.' });
        return { success: true, message: 'Run stopped by user. Progress has been saved.' };
      }

      // Check context usage: input_tokens from last call reflects the full conversation size.
      // When the last request took >80% of the context window, save progress before the next
      // call (which will be even larger after we add the response + tool results).
      if (context.totalInputTokens > contextLimit * 0.8) {
        const pct = Math.round((context.totalInputTokens / contextLimit) * 100);
        this.onActivity(
          `Context is ${pct}% full (${context.totalInputTokens.toLocaleString()} of ${contextLimit.toLocaleString()} tokens). The agent's memory is almost full and needs to pause.`,
          'warning'
        );
        this.onActivity(
          `Iteration ${iterations}: saving progress so you can continue where you left off...`,
          'warning'
        );
        await this.autoSaveProgress(context);
        this.onActivity(
          `Progress saved! To continue, click "Process Meet" again with the same meet name — it will offer to resume.`,
          'success'
        );
        return {
          success: true,
          message: `Paused at ${pct}% context usage after ${iterations} iterations. Progress saved — run again to continue.`,
        };
      }

      this.onActivity('Thinking...', 'info');
      console.log(`[AGENT] Iteration ${iterations}/${maxIterations}, tokens: in=${context.totalInputTokens} out=${context.totalOutputTokens}`);

      // Defensive: validate message sequence before sending
      this.validateMessageSequence(context.messages);

      let response: LLMResponse;
      try {
        console.log(`[AGENT] Sending LLM request...`);
        response = await this.llmClient.sendMessage({
          system: buildSystem(),
          messages: context.messages,
          tools,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.onActivity(`LLM API error: ${message}`, 'error');
        await this.autoSaveProgress(context);
        this.onActivity('Progress auto-saved before error return.', 'warning');
        return { success: false, message: `LLM error: ${message}` };
      }

      // Track tokens: input_tokens from last call = actual current context size
      // (because the API receives the full message history each time)
      context.totalInputTokens = response.usage.input_tokens;
      context.totalOutputTokens += response.usage.output_tokens;
      console.log(`[AGENT] LLM responded: stop_reason=${response.stop_reason}, in=${response.usage.input_tokens}, out=${response.usage.output_tokens}, blocks=${response.content.length}`);

      // Log any text blocks from the response
      for (const block of response.content) {
        if (block.type === 'text' && block.text) {
          this.onActivity(block.text, 'info');
        }
      }

      if (response.stop_reason === 'end_turn') {
        // Agent is done
        const textBlocks = response.content.filter((b) => b.type === 'text');
        const finalMessage = textBlocks.map((b) => b.text ?? '').join('\n');
        context.messages.push({ role: 'assistant', content: response.content });
        this.onActivity('Agent completed processing.', 'success');
        return { success: true, message: finalMessage || 'Processing complete.' };
      }

      if (response.stop_reason === 'max_tokens') {
        // Response was truncated — add what we got
        context.messages.push({ role: 'assistant', content: response.content });

        // If the truncated response contains tool_use blocks, we must add
        // matching tool_result blocks or the next API call will fail
        const orphanedToolUses = response.content.filter(b => b.type === 'tool_use');
        if (orphanedToolUses.length > 0) {
          const dummyResults: ContentBlock[] = orphanedToolUses.map(tu => ({
            type: 'tool_result' as const,
            tool_use_id: tu.id,
            content: 'Error: Response was truncated before this tool could be executed. Please try again.',
          }));
          context.messages.push({ role: 'user', content: dummyResults });
        } else {
          context.messages.push({
            role: 'user',
            content: 'Your response was truncated due to length. Please continue.',
          });
        }
        continue;
      }

      if (response.stop_reason === 'tool_use') {
        // Add assistant message with tool calls
        context.messages.push({ role: 'assistant', content: response.content });

        // Execute tool calls and collect results
        const toolResults = await this.executeToolCalls(response.content, context);
        context.messages.push({ role: 'user', content: toolResults });
      }
    }

    // Instead of hard-failing, ask the agent to summarize what's wrong
    // and whether it needs system changes or is close to finishing
    this.onActivity('Reached iteration limit — asking agent for status summary...', 'warning');
    const totalTokens = context.totalInputTokens + context.totalOutputTokens;
    context.messages.push({
      role: 'user',
      content: `You have reached the iteration limit (${maxIterations} iterations). Token usage: ${context.totalInputTokens.toLocaleString()} input + ${context.totalOutputTokens.toLocaleString()} output = ${totalTokens.toLocaleString()} total (context limit: ${this.llmClient.getContextLimit().toLocaleString()}).\n\nInstead of stopping, please provide a brief summary for the user:\n1. What have you accomplished so far?\n2. What is blocking you or taking so many iterations?\n3. Do you think this is a system/tool limitation that needs a code fix, or are you close to finishing and just need more iterations?\n4. What would you recommend as next steps?\n\nKeep it concise — the user will see this directly.`,
    });

    try {
      const summaryResponse = await this.llmClient.sendMessage({
        system: buildSystem(),
        messages: context.messages,
        tools: [], // No tools — just want a text summary
      });

      const summaryText = summaryResponse.content
        .filter(b => b.type === 'text')
        .map(b => b.text ?? '')
        .join('\n');

      context.messages.push({ role: 'assistant', content: summaryResponse.content });
      await this.autoSaveProgress(context);

      this.onActivity(summaryText || 'Agent could not provide a summary.', 'warning');
      return {
        success: false,
        message: summaryText || 'Agent reached iteration limit. Progress has been saved.',
      };
    } catch {
      await this.autoSaveProgress(context);
      return { success: false, message: 'Agent reached iteration limit. Progress has been saved.' };
    }
  }

  /**
   * Validate that every tool_use in the message history has a matching tool_result.
   * Fixes orphaned tool_use blocks by injecting dummy tool_result blocks.
   */
  private validateMessageSequence(messages: LLMMessage[]): void {
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role !== 'assistant' || typeof msg.content === 'string') continue;

      const toolUseIds = msg.content
        .filter(b => b.type === 'tool_use' && b.id)
        .map(b => b.id!);

      if (toolUseIds.length === 0) continue;

      // Check the next message for matching tool_result blocks
      const nextMsg = messages[i + 1];
      if (!nextMsg || nextMsg.role !== 'user' || typeof nextMsg.content === 'string') {
        // Missing tool_result — inject dummy results
        const dummyResults: ContentBlock[] = toolUseIds.map(id => ({
          type: 'tool_result' as const,
          tool_use_id: id,
          content: 'Error: Tool result was lost. Please retry this action.',
        }));

        // Insert after the assistant message
        messages.splice(i + 1, 0, { role: 'user', content: dummyResults });
        continue;
      }

      // Check that ALL tool_use ids have matching tool_result blocks
      if (Array.isArray(nextMsg.content)) {
        const resultIds = new Set(
          nextMsg.content.filter(b => b.type === 'tool_result').map(b => b.tool_use_id)
        );
        const missingIds = toolUseIds.filter(id => !resultIds.has(id));
        if (missingIds.length > 0) {
          // Add missing tool_results
          const dummyResults: ContentBlock[] = missingIds.map(id => ({
            type: 'tool_result' as const,
            tool_use_id: id,
            content: 'Error: Tool result was lost. Please retry this action.',
          }));
          (nextMsg.content as ContentBlock[]).push(...dummyResults);
        }
      }
    }
  }

  /**
   * Execute all tool_use blocks from a response and return ContentBlock[] of tool_results.
   */
  private async executeToolCalls(
    content: ContentBlock[],
    context: AgentContext
  ): Promise<ContentBlock[]> {
    const toolCalls = content.filter((b) => b.type === 'tool_use');
    const results: ContentBlock[] = [];

    for (const call of toolCalls) {
      const toolName = call.name!;
      const toolArgs = (call.input ?? {}) as Record<string, unknown>;
      const toolId = call.id!;

      this.onActivity(`Running tool: ${toolName}...`, 'info');
      console.log(`[AGENT] Running tool: ${toolName} args=${JSON.stringify(toolArgs).substring(0, 200)}`);

      let result: ToolResultContent;
      try {
        result = await this.executeTool(toolName, toolArgs, context);
        // Log a brief summary
        const textPreview = toolResultText(result);
        const preview = textPreview.length > 200 ? textPreview.substring(0, 200) + '...' : textPreview;
        this.onActivity(`Tool ${toolName} result: ${preview}`, 'info');
        console.log(`[AGENT] Tool ${toolName} completed, result length: ${textPreview.length}`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        result = `Error: ${errMsg}`;
        this.onActivity(`Tool ${toolName} failed: ${errMsg}`, 'error');
        console.log(`[AGENT] Tool ${toolName} FAILED: ${errMsg}`);
      }

      results.push({
        type: 'tool_result',
        tool_use_id: toolId,
        content: result,
      });
    }

    return results;
  }

  /**
   * Execute a single tool call by name.
   */
  private async executeTool(
    name: string,
    args: Record<string, unknown>,
    context: AgentContext
  ): Promise<ToolResultContent> {
    // Check for external tool executors first
    if (this.toolExecutors[name]) {
      return this.toolExecutors[name](args);
    }

    // Context-aware tools (need meetName, loadedSkills, etc.)
    // Tools handled by external executors (browser-tools, search-tools, db-tools, python-tools)
    // are NOT listed here — they run via this.toolExecutors above.
    switch (name) {
      case 'run_python':
        return this.toolRunPython(context.outputName || context.meetName, args.args as string);

      case 'set_output_name':
        context.outputName = args.name as string;
        return `Output folder name set to: "${context.outputName}"`;

      case 'render_pdf_page':
        return this.toolRenderPdfPage(
          args.pdf_path as string | undefined,
          args.page_number as number | undefined,
          context.outputName || context.meetName
        );

      case 'list_output_files':
        return this.toolListOutputFiles((args.meet_name as string) || context.outputName || context.meetName);

      case 'list_skills':
        return this.toolListSkills();

      case 'load_skill':
        return this.toolLoadSkill(args.skill_name as string, context);

      case 'load_skill_detail':
        return this.toolLoadSkillDetail(args.detail_name as string, context);

      case 'save_draft_skill':
        return this.toolSaveDraftSkill(args.platform_name as string, args.content as string);

      case 'save_progress':
        return this.toolSaveProgress(context, args.summary as string, args.next_steps as string, args.data_files as string | undefined);

      case 'load_progress':
        return this.toolLoadProgress();

      default:
        return `Error: Unknown tool "${name}"`;
    }
  }

  // --- Tool implementations (context-aware, inline only) ---

  private async toolRunPython(meetName: string, args: string): Promise<string> {
    // Split args respecting quoted strings (e.g. --meet "2025 Iowa State Championships")
    const argParts = (args.match(/(?:[^\s"]+|"[^"]*")+/g) || [])
      .map(a => a.replace(/^"(.*)"$/, '$1'));

    // ALWAYS enforce --db and --output to the correct paths.
    // Strip any agent-provided values first, then inject ours.
    const stripFlags = ['--db', '--output'];
    for (const flag of stripFlags) {
      const idx = argParts.indexOf(flag);
      if (idx !== -1) {
        argParts.splice(idx, 2); // remove flag and its value
      }
    }
    // Write to staging DB instead of central — use finalize_meet to merge later
    argParts.push('--db', getStagingDbPath());
    argParts.push('--output', getOutputDir(meetName));

    const result = await pythonManager.runScript('process_meet.py', argParts, (line) => {
      this.onActivity(`[python] ${line}`, 'info');
    });

    if (result.exitCode !== 0) {
      return `Python script failed (exit code ${result.exitCode}).\nstdout: ${result.stdout}\nstderr: ${result.stderr}`;
    }
    return result.stdout || 'Script completed successfully (no output).';
  }

  private async toolRenderPdfPage(
    pdfPath: string | undefined,
    pageNumber: number | undefined,
    meetName: string
  ): Promise<ToolResultContent> {
    const page = pageNumber ?? 1;

    // Default to back_of_shirt.pdf in the output directory
    const resolvedPath = pdfPath || path.join(getOutputDir(meetName), 'back_of_shirt.pdf');

    if (!fs.existsSync(resolvedPath)) {
      return `Error: PDF file not found at ${resolvedPath}. Generate the PDF first with run_python.`;
    }

    // Use PyMuPDF to render the page to a PNG, base64-encoded
    const pythonCode = `
import sys, fitz, base64
doc = fitz.open(${JSON.stringify(resolvedPath)})
page_idx = ${page - 1}
if page_idx < 0 or page_idx >= len(doc):
    print(f"Error: Page {${page}} out of range (PDF has {len(doc)} pages)")
    sys.exit(1)
page = doc[page_idx]
# Render at 2x resolution for clarity
pix = page.get_pixmap(dpi=200)
png_bytes = pix.tobytes("png")
print(base64.b64encode(png_bytes).decode('ascii'))
doc.close()
`;

    // Spawn python directly with inline code
    const { spawn: spawnProc, spawnSync } = require('child_process') as typeof import('child_process');

    // Find python command
    let pythonCmd = 'python3';
    for (const cmd of ['python', 'python3']) {
      try {
        const check = spawnSync(cmd, ['--version'], { timeout: 5000, stdio: 'pipe' });
        if (check.status === 0) { pythonCmd = cmd; break; }
      } catch { /* try next */ }
    }

    return new Promise<ToolResultContent>((resolve) => {
      const proc = spawnProc(pythonCmd, ['-c', pythonCode], {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 30000,
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
      proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

      proc.on('close', (exitCode: number | null) => {
        if (exitCode !== 0 || !stdout.trim()) {
          resolve(`Error rendering PDF page: ${stderr || 'No output from Python'}`);
          return;
        }

        const base64Data = stdout.trim();
        const textPart: TextContentPart = {
          type: 'text',
          text: `Rendered page ${page} of ${resolvedPath} (200 DPI). Inspect the layout — if names are too small, spacing too tight/loose, or the page is too full/empty, re-run run_python with adjusted --line-spacing, --level-gap, --max-fill, or --min-font-size values.`,
        };
        const imagePart: ImageContentPart = {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: base64Data,
          },
        };

        resolve([textPart, imagePart]);
      });

      proc.on('error', (err: Error) => {
        resolve(`Error spawning Python: ${err.message}`);
      });
    });
  }

  private async toolListOutputFiles(meetName: string): Promise<string> {
    const dir = getOutputDir(meetName);
    if (!fs.existsSync(dir)) {
      return 'Output directory does not exist yet.';
    }

    const files = fs.readdirSync(dir);
    if (files.length === 0) {
      return 'Output directory is empty.';
    }

    const lines = files.map((f) => {
      const stats = fs.statSync(path.join(dir, f));
      const sizeKB = (stats.size / 1024).toFixed(1);
      return `  ${f} (${sizeKB} KB)`;
    });
    return `Files in ${dir}:\n${lines.join('\n')}`;
  }

  private async toolListSkills(): Promise<string> {
    const skillsDir = getSkillsDir();
    if (!fs.existsSync(skillsDir)) {
      return 'No skills directory found.';
    }

    const files = fs.readdirSync(skillsDir)
      .filter(f => f.endsWith('.md') && fs.statSync(path.join(skillsDir, f)).isFile())
      .map(f => f.replace(/\.md$/, ''));

    if (files.length === 0) return 'No skills available.';
    return `Available skills: ${files.join(', ')}`;
  }

  private async toolLoadSkill(skillName: string, context: AgentContext): Promise<string> {
    if (context.loadedSkills.includes(skillName)) {
      return `Skill "${skillName}" is already loaded.`;
    }

    const skillPath = path.join(getSkillsDir(), `${skillName}.md`);
    if (!fs.existsSync(skillPath)) {
      return `Error: Skill "${skillName}" not found at ${skillPath}. Available skills can be found in the skills/ directory.`;
    }

    const content = fs.readFileSync(skillPath, 'utf-8');
    context.loadedSkills.push(skillName);

    // Return the skill content so the LLM receives it as a tool result
    return `--- Skill: ${skillName} ---\n\n${content}`;
  }

  private async toolLoadSkillDetail(detailName: string, context: AgentContext): Promise<string> {
    const detailKey = `details/${detailName}`;
    if (context.loadedSkills.includes(detailKey)) {
      return `Detail skill "${detailName}" is already loaded.`;
    }

    const detailPath = path.join(getSkillsDir(), 'details', `${detailName}.md`);
    if (!fs.existsSync(detailPath)) {
      return `Error: Detail skill "${detailName}" not found at ${detailPath}.`;
    }

    const content = fs.readFileSync(detailPath, 'utf-8');
    context.loadedSkills.push(detailKey);

    return `--- Detail Skill: ${detailName} ---\n\n${content}`;
  }

  private async toolSaveDraftSkill(platformName: string, content: string): Promise<string> {
    const draftsDir = path.join(getSkillsDir(), 'drafts');
    if (!fs.existsSync(draftsDir)) {
      fs.mkdirSync(draftsDir, { recursive: true });
    }

    const filePath = path.join(draftsDir, `${platformName}.md`);
    fs.writeFileSync(filePath, content, 'utf-8');
    return `Draft skill saved to ${filePath}`;
  }

  private async toolSaveProgress(
    context: AgentContext,
    summary: string,
    nextSteps: string,
    dataFilesJson?: string
  ): Promise<string> {
    let dataFiles: Array<{ path: string; description: string }> | undefined;
    if (dataFilesJson) {
      try {
        dataFiles = JSON.parse(dataFilesJson);
      } catch {
        // Ignore parse errors — data_files is optional
      }
    }

    const progressData: ProgressData = {
      summary,
      next_steps: nextSteps,
      loaded_skills: context.loadedSkills,
      meet_name: context.meetName,
      timestamp: new Date().toISOString(),
      data_files: dataFiles,
    };

    const filePath = getProgressFilePath();
    fs.writeFileSync(filePath, JSON.stringify(progressData, null, 2), 'utf-8');
    return `Progress saved to ${filePath}`;
  }

  private async toolLoadProgress(): Promise<string> {
    const filePath = getProgressFilePath();
    if (!fs.existsSync(filePath)) {
      return 'No saved progress found.';
    }

    const data = fs.readFileSync(filePath, 'utf-8');
    return `Saved progress:\n${data}`;
  }

  /**
   * Auto-save progress when approaching context limit.
   * Extracts real context from the conversation history instead of saving generic boilerplate.
   */
  private async autoSaveProgress(context: AgentContext): Promise<void> {
    // Extract meaningful summary from the conversation history
    const summary = this.extractProgressSummary(context);
    const nextSteps = this.extractNextSteps(context);

    const progressData: ProgressData = {
      summary,
      next_steps: nextSteps,
      loaded_skills: context.loadedSkills,
      meet_name: context.meetName,
      timestamp: new Date().toISOString(),
    };

    const filePath = getProgressFilePath();
    fs.writeFileSync(filePath, JSON.stringify(progressData, null, 2), 'utf-8');
    this.onActivity(`Progress auto-saved to ${filePath}`, 'info');
  }

  /**
   * Extract a meaningful summary from the conversation messages.
   * Focuses on tool results and agent reasoning from the last several turns.
   */
  private extractProgressSummary(context: AgentContext): string {
    const parts: string[] = [];

    for (const msg of context.messages) {
      if (typeof msg.content === 'string') continue;

      for (const block of msg.content) {
        // Collect agent text (reasoning about what it's doing)
        if (block.type === 'text' && block.text && msg.role === 'assistant') {
          parts.push(`Agent: ${block.text.substring(0, 300)}`);
        }
        // Collect tool call names and their results
        if (block.type === 'tool_use' && block.name) {
          const argsPreview = block.input ? JSON.stringify(block.input).substring(0, 100) : '';
          parts.push(`Called ${block.name}(${argsPreview})`);
        }
        if (block.type === 'tool_result' && block.content) {
          const preview = toolResultText(block.content).substring(0, 200);
          parts.push(`  -> ${preview}`);
        }
      }
    }

    // Keep the last ~2000 chars of context (most recent actions are most relevant)
    const combined = parts.join('\n');
    if (combined.length > 2000) {
      return '...\n' + combined.substring(combined.length - 2000);
    }
    return combined || 'Auto-saved with no meaningful progress captured.';
  }

  /**
   * Extract next steps by looking at the agent's last text message.
   */
  private extractNextSteps(context: AgentContext): string {
    // Walk backward through messages to find the last agent text
    for (let i = context.messages.length - 1; i >= 0; i--) {
      const msg = context.messages[i];
      if (msg.role !== 'assistant' || typeof msg.content === 'string') continue;

      for (const block of msg.content) {
        if (block.type === 'text' && block.text) {
          return `Continue from agent's last action: ${block.text.substring(0, 500)}`;
        }
      }
    }
    return 'Resume processing from the beginning of the current step.';
  }

  /**
   * Load progress from a previous invocation.
   */
  private async loadProgress(): Promise<ProgressData | null> {
    const filePath = getProgressFilePath();
    if (!fs.existsSync(filePath)) {
      return null;
    }

    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(raw) as ProgressData;
    } catch {
      return null;
    }
  }

  /**
   * Build tool executors with meet-specific context.
   * External executors (passed via constructor) take precedence.
   */
  private buildToolExecutors(_context: AgentContext): void {
    // Tool executors are handled via the executeTool switch + this.toolExecutors.
    // No extra setup needed here; the constructor-provided executors are already stored.
  }

  /**
   * Save the full process log as a readable markdown file.
   * Saved to data/logs/[meetName]_[timestamp].md
   */
  private saveProcessLog(
    context: AgentContext,
    result: { success: boolean; message: string }
  ): void {
    try {
      const logsDir = path.join(getDataDir(), 'logs');
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
      const safeName = context.meetName.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
      const logPath = path.join(logsDir, `${safeName}_${timestamp}.md`);

      const lines: string[] = [];
      lines.push(`# Process Log: ${context.meetName}`);
      lines.push(`**Date**: ${new Date().toISOString()}`);
      lines.push(`**Result**: ${result.success ? 'SUCCESS' : 'FAILED'} — ${result.message}`);
      lines.push(`**Tokens**: ${context.totalInputTokens.toLocaleString()} input, ${context.totalOutputTokens.toLocaleString()} output`);
      lines.push(`**Skills loaded**: ${context.loadedSkills.join(', ') || 'none'}`);
      lines.push('');
      lines.push('---');
      lines.push('');

      let iterationNum = 0;

      for (const msg of context.messages) {
        if (typeof msg.content === 'string') {
          lines.push(`## ${msg.role === 'user' ? 'User' : 'Agent'}`);
          lines.push('');
          lines.push(msg.content);
          lines.push('');
          continue;
        }

        // ContentBlock array
        for (const block of msg.content) {
          if (block.type === 'text' && block.text) {
            if (msg.role === 'assistant') {
              lines.push(`## Agent (iteration ${++iterationNum})`);
            }
            lines.push('');
            lines.push(block.text);
            lines.push('');
          }

          if (block.type === 'tool_use') {
            lines.push(`### Tool Call: \`${block.name}\``);
            lines.push('```json');
            lines.push(JSON.stringify(block.input, null, 2).substring(0, 2000));
            lines.push('```');
            lines.push('');
          }

          if (block.type === 'tool_result') {
            lines.push(`### Tool Result`);
            lines.push('```');
            // Truncate very long results to keep the log file manageable
            const content = toolResultText(block.content);
            lines.push(content.length > 3000 ? content.substring(0, 3000) + '\n... (truncated)' : content);
            lines.push('```');
            lines.push('');
          }
        }
      }

      fs.writeFileSync(logPath, lines.join('\n'), 'utf-8');
      this.onActivity(`Process log saved: ${logPath}`, 'info');
    } catch (err) {
      // Don't let log saving failure crash the process
      const errMsg = err instanceof Error ? err.message : String(err);
      this.onActivity(`Warning: Could not save process log: ${errMsg}`, 'warning');
    }
  }
}
