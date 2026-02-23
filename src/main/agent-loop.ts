/**
 * Agent Loop - Orchestrates LLM calls and tool execution for meet processing.
 * Manages conversation history, token tracking, skill loading, and progress save/load.
 */

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { LLMClient, LLMMessage, ContentBlock, ToolDefinition, LLMResponse } from './llm-client';
import { chromeController } from './chrome-controller';
import { pythonManager } from './python-manager';
import { configStore } from './config-store';
import Database from 'better-sqlite3';

// --- Types ---

interface AgentContext {
  meetName: string;
  state?: string;
  systemPrompt: string;
  loadedSkills: string[];
  messages: LLMMessage[];
  totalInputTokens: number;
  totalOutputTokens: number;
  onActivity: (message: string, level: 'info' | 'success' | 'error' | 'warning') => void;
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
}

// --- Tool definitions exposed to the LLM ---

function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: 'web_search',
      description: 'Search for meet results pages. Returns search results as text.',
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
      description: 'Run JavaScript in the Chrome page context and return the result. For large data, save to a window variable and retrieve in chunks.',
      input_schema: {
        type: 'object',
        properties: {
          script: { type: 'string', description: 'JavaScript code to execute in the page' },
        },
        required: ['script'],
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
      description: 'Run process_meet.py with the given arguments. Returns stdout summary.',
      input_schema: {
        type: 'object',
        properties: {
          args: { type: 'string', description: 'Command-line arguments for process_meet.py' },
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
      description: 'List files in the meet output directory.',
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
      name: 'save_progress',
      description: 'Save current progress state so work can be resumed if context limits are reached.',
      input_schema: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'Summary of what has been accomplished so far' },
          next_steps: { type: 'string', description: 'What needs to be done next' },
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
  ];
}

// --- Helper: resolve meet data directory ---

function getMeetDataDir(meetName: string): string {
  const slug = meetName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const dataDir = path.join(app.getAppPath(), 'data', slug);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  return dataDir;
}

function getProgressFilePath(): string {
  const dataDir = path.join(app.getAppPath(), 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  return path.join(dataDir, 'agent_progress.json');
}

function getSkillsDir(): string {
  return path.join(app.getAppPath(), 'skills');
}

// --- Agent Loop ---

export class AgentLoop {
  private llmClient: LLMClient;
  private toolExecutors: ToolExecutor;
  private onActivity: (message: string, level: 'info' | 'success' | 'error' | 'warning') => void;
  private queryConversation: LLMMessage[] = [];

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
   * Process a meet (main entry point for Process tab).
   */
  async processMeet(meetName: string): Promise<{ success: boolean; message: string }> {
    this.onActivity(`Starting agent for meet: ${meetName}`, 'info');

    try {
      // Load system prompt
      const systemPrompt = this.loadSystemPrompt();
      const context: AgentContext = {
        meetName,
        systemPrompt,
        loadedSkills: [],
        messages: [],
        totalInputTokens: 0,
        totalOutputTokens: 0,
        onActivity: this.onActivity,
      };

      // Check for saved progress
      const savedProgress = await this.loadProgress();
      if (savedProgress && savedProgress.meet_name === meetName) {
        this.onActivity('Found saved progress, resuming...', 'info');
        context.loadedSkills = savedProgress.loaded_skills;
        context.messages.push({
          role: 'user',
          content: `You are resuming work on meet "${meetName}". Here is your previous progress:\n\nSummary: ${savedProgress.summary}\n\nNext steps: ${savedProgress.next_steps}\n\nPlease continue from where you left off.`,
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
      return result;
    } catch (err) {
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
    try {
      return fs.readFileSync(promptPath, 'utf-8');
    } catch {
      return 'You are a gymnastics meet scoring assistant. Process meet data and generate outputs.';
    }
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

      // Check token usage against context limit (80% threshold)
      const totalTokens = context.totalInputTokens + context.totalOutputTokens;
      if (totalTokens > contextLimit * 0.8) {
        this.onActivity('Approaching context limit, saving progress...', 'warning');
        await this.autoSaveProgress(context);
        return {
          success: true,
          message: 'Progress saved due to context limit. Run again to continue.',
        };
      }

      this.onActivity('Thinking...', 'info');

      let response: LLMResponse;
      try {
        response = await this.llmClient.sendMessage({
          system: buildSystem(),
          messages: context.messages,
          tools,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.onActivity(`LLM API error: ${message}`, 'error');
        return { success: false, message: `LLM error: ${message}` };
      }

      // Track tokens
      context.totalInputTokens += response.usage.input_tokens;
      context.totalOutputTokens += response.usage.output_tokens;

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
        // Response was truncated — add what we got and continue
        context.messages.push({ role: 'assistant', content: response.content });
        context.messages.push({
          role: 'user',
          content: 'Your response was truncated due to length. Please continue.',
        });
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

    this.onActivity('Agent reached maximum iterations.', 'warning');
    return { success: false, message: 'Agent reached maximum iteration limit.' };
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

      let result: string;
      try {
        result = await this.executeTool(toolName, toolArgs, context);
        // Log a brief summary
        const preview = result.length > 200 ? result.substring(0, 200) + '...' : result;
        this.onActivity(`Tool ${toolName} result: ${preview}`, 'info');
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        result = `Error: ${errMsg}`;
        this.onActivity(`Tool ${toolName} failed: ${errMsg}`, 'error');
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
  ): Promise<string> {
    // Check for external tool executors first
    if (this.toolExecutors[name]) {
      return this.toolExecutors[name](args);
    }

    // Built-in tool implementations
    switch (name) {
      case 'web_search':
        return this.toolWebSearch(args.query as string);

      case 'chrome_navigate':
        return this.toolChromeNavigate(args.url as string);

      case 'chrome_execute_js':
        return this.toolChromeExecuteJS(args.script as string);

      case 'chrome_screenshot':
        return this.toolChromeScreenshot();

      case 'chrome_click':
        return this.toolChromeClick(args.selector as string);

      case 'save_to_file':
        return this.toolSaveToFile(context.meetName, args.filename as string, args.content as string);

      case 'run_python':
        return this.toolRunPython(args.args as string);

      case 'query_db':
        return this.toolQueryDb(context.meetName, args.sql as string);

      case 'query_db_to_file':
        return this.toolQueryDbToFile(context.meetName, args.sql as string, args.filename as string);

      case 'list_output_files':
        return this.toolListOutputFiles(context.meetName);

      case 'load_skill':
        return this.toolLoadSkill(args.skill_name as string, context);

      case 'load_skill_detail':
        return this.toolLoadSkillDetail(args.detail_name as string, context);

      case 'save_draft_skill':
        return this.toolSaveDraftSkill(args.platform_name as string, args.content as string);

      case 'save_progress':
        return this.toolSaveProgress(context, args.summary as string, args.next_steps as string);

      case 'load_progress':
        return this.toolLoadProgress();

      default:
        return `Error: Unknown tool "${name}"`;
    }
  }

  // --- Tool implementations ---

  private async toolWebSearch(query: string): Promise<string> {
    // Use a simple web search via fetch to a search API
    // For now, return a message that the agent should use Chrome to search
    return `Web search is not yet configured. Please use chrome_navigate to go to Google and search manually, or navigate directly to meetscoresonline.com or results.scorecatonline.com to find the meet.`;
  }

  private async toolChromeNavigate(url: string): Promise<string> {
    if (!chromeController.isConnected()) {
      await chromeController.launch();
      await chromeController.connect();
    }
    await chromeController.navigate(url);
    const title = await chromeController.executeJS('document.title') as string;
    return `Navigated to ${url}. Page title: ${title}`;
  }

  private async toolChromeExecuteJS(script: string): Promise<string> {
    if (!chromeController.isConnected()) {
      return 'Error: Chrome is not connected. Use chrome_navigate first.';
    }
    const result = await chromeController.executeJS(script);
    if (result === undefined || result === null) {
      return 'undefined';
    }
    if (typeof result === 'string') {
      return result;
    }
    return JSON.stringify(result, null, 2);
  }

  private async toolChromeScreenshot(): Promise<string> {
    if (!chromeController.isConnected()) {
      return 'Error: Chrome is not connected. Use chrome_navigate first.';
    }
    const filePath = await chromeController.screenshot();
    return `Screenshot saved to: ${filePath}`;
  }

  private async toolChromeClick(selector: string): Promise<string> {
    if (!chromeController.isConnected()) {
      return 'Error: Chrome is not connected. Use chrome_navigate first.';
    }
    await chromeController.executeJS(`document.querySelector(${JSON.stringify(selector)}).click()`);
    return `Clicked element: ${selector}`;
  }

  private async toolSaveToFile(meetName: string, filename: string, content: string): Promise<string> {
    const dir = getMeetDataDir(meetName);
    const filePath = path.join(dir, filename);
    fs.writeFileSync(filePath, content, 'utf-8');
    return `Saved ${content.length} bytes to ${filePath}`;
  }

  private async toolRunPython(args: string): Promise<string> {
    const argParts = args.split(/\s+/).filter((a) => a.length > 0);
    const result = await pythonManager.runScript('process_meet.py', argParts, (line) => {
      this.onActivity(`[python] ${line}`, 'info');
    });

    if (result.exitCode !== 0) {
      return `Python script failed (exit code ${result.exitCode}).\nstdout: ${result.stdout}\nstderr: ${result.stderr}`;
    }
    return result.stdout || 'Script completed successfully (no output).';
  }

  private async toolQueryDb(meetName: string, sql: string): Promise<string> {
    // Validate the query is a SELECT
    const trimmed = sql.trim().toUpperCase();
    if (!trimmed.startsWith('SELECT') && !trimmed.startsWith('WITH') && !trimmed.startsWith('PRAGMA')) {
      return 'Error: Only SELECT/WITH/PRAGMA queries are allowed.';
    }

    const dbPath = path.join(getMeetDataDir(meetName), 'meet.db');
    if (!fs.existsSync(dbPath)) {
      return `Error: Database not found at ${dbPath}. Has the meet been processed yet?`;
    }

    let db: InstanceType<typeof Database> | null = null;
    try {
      db = new Database(dbPath, { readonly: true });
      const rows = db.prepare(sql).all() as Record<string, unknown>[];

      if (rows.length === 0) {
        return 'Query returned 0 rows.';
      }

      // Format as text table (up to 50 rows)
      const limited = rows.slice(0, 50);
      const columns = Object.keys(limited[0]);
      const lines: string[] = [columns.join('\t')];
      for (const row of limited) {
        lines.push(columns.map((c) => String(row[c] ?? '')).join('\t'));
      }

      let result = lines.join('\n');
      if (rows.length > 50) {
        result += `\n\n... (${rows.length - 50} more rows not shown, ${rows.length} total)`;
      }
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `SQL error: ${message}`;
    } finally {
      if (db) {
        db.close();
      }
    }
  }

  private async toolQueryDbToFile(meetName: string, sql: string, filename: string): Promise<string> {
    const trimmed = sql.trim().toUpperCase();
    if (!trimmed.startsWith('SELECT') && !trimmed.startsWith('WITH')) {
      return 'Error: Only SELECT/WITH queries are allowed.';
    }

    const dbPath = path.join(getMeetDataDir(meetName), 'meet.db');
    if (!fs.existsSync(dbPath)) {
      return `Error: Database not found at ${dbPath}.`;
    }

    let db: InstanceType<typeof Database> | null = null;
    try {
      db = new Database(dbPath, { readonly: true });
      const rows = db.prepare(sql).all() as Record<string, unknown>[];

      if (rows.length === 0) {
        return 'Query returned 0 rows. No file written.';
      }

      const columns = Object.keys(rows[0]);
      const csvLines: string[] = [columns.join(',')];
      for (const row of rows) {
        csvLines.push(columns.map((c) => {
          const val = String(row[c] ?? '');
          // Escape CSV values containing commas or quotes
          if (val.includes(',') || val.includes('"') || val.includes('\n')) {
            return `"${val.replace(/"/g, '""')}"`;
          }
          return val;
        }).join(','));
      }

      const dir = getMeetDataDir(meetName);
      const filePath = path.join(dir, filename);
      fs.writeFileSync(filePath, csvLines.join('\n'), 'utf-8');
      return `Saved ${rows.length} rows to ${filePath}`;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `SQL error: ${message}`;
    } finally {
      if (db) {
        db.close();
      }
    }
  }

  private async toolListOutputFiles(meetName: string): Promise<string> {
    const dir = getMeetDataDir(meetName);
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
    nextSteps: string
  ): Promise<string> {
    const progressData: ProgressData = {
      summary,
      next_steps: nextSteps,
      loaded_skills: context.loadedSkills,
      meet_name: context.meetName,
      timestamp: new Date().toISOString(),
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
   */
  private async autoSaveProgress(context: AgentContext): Promise<void> {
    const progressData: ProgressData = {
      summary: 'Auto-saved due to context limit. Check conversation for details.',
      next_steps: 'Resume processing from where the agent left off.',
      loaded_skills: context.loadedSkills,
      meet_name: context.meetName,
      timestamp: new Date().toISOString(),
    };

    const filePath = getProgressFilePath();
    fs.writeFileSync(filePath, JSON.stringify(progressData, null, 2), 'utf-8');
    this.onActivity(`Progress auto-saved to ${filePath}`, 'info');
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
}
