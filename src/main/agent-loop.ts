/**
 * Agent Loop - Orchestrates LLM calls and tool execution for meet processing.
 * Uses a phase-based architecture where each phase has its own tools and prompt.
 */

import * as fs from 'fs';
import * as path from 'path';
import { LLMClient, LLMMessage, ContentBlock, LLMResponse, ToolResultContent } from './llm-client';
import { resetStagingDb } from './tools/python-tools';
import { setDbToolsPhase } from './tools/db-tools';
import { getDataDir, getOutputDir } from './paths';
import { getToolDefinitions } from './tool-definitions';
import {
  AgentContext,
  toolBuildDatabase,
  toolRegenerateOutput,
  toolImportPdfBacks,
  toolSetPhase,
  toolUnlockTool,
  toolRenderPdfPage,
  toolOpenFile,
  toolListOutputFiles,
  toolListSkills,
  toolLoadSkill,
  toolSaveProgress,
  toolLoadProgress,
  loadProgressData,
  autoSaveProgress,
} from './context-tools';
import {
  toolResultText,
  saveProcessLog,
  extractProgressSummary,
  extractNextSteps,
} from './process-logger';
import { requireString, optionalString } from './tools/validation';
import { WorkflowPhase, filterToolsForPhase, buildPhasePrompt } from './workflow-phases';

// Re-export AgentContext for consumers
export type { AgentContext };

/**
 * Switch the agent's phase and keep db-tools in sync.
 * Every phase change MUST go through this helper — never set context.currentPhase directly.
 */
function switchPhase(context: AgentContext, phase: WorkflowPhase): void {
  context.currentPhase = phase;
  context.unlockedTools = [];
  setDbToolsPhase(phase);
}

/**
 * Detect whether text contains a user-provided PDF file path (not system-generated).
 * Used by both runAgentLoop (tool results) and continueConversation (user message).
 */
function containsUserPdfPath(text: string): boolean {
  if (!text.includes('.pdf')) return false;
  // Must have a path-like prefix (drive letter, home dir, Downloads, Desktop, quoted path)
  const hasPathContext = /[A-Za-z]:\\|\/home\/|~\/|\/mnt\/|Downloads|Desktop/.test(text) || text.includes('"');
  if (!hasPathContext) return false;
  // Exclude system-generated paths (e.g., "Generated C:\...\back_of_shirt.pdf")
  if (text.includes('Generated ') && text.includes('back_of_shirt')) return false;
  return true;
}

// --- Types ---

interface ToolExecutor {
  [toolName: string]: (args: Record<string, unknown>) => Promise<string>;
}

// --- Agent Loop ---

export class AgentLoop {
  private llmClient: LLMClient;
  private toolExecutors: ToolExecutor;
  private onActivity: (message: string, level: 'info' | 'success' | 'error' | 'warning') => void;
  // Query conversation removed — queryResults() now uses query-engine.ts directly
  private activeContext: AgentContext | null = null;
  private lastContext: AgentContext | null = null;

  /** Get the log file path for the most recent (or active) run. */
  getLogPath(): string | null {
    return this.activeContext?.logPath || this.lastContext?.logPath || null;
  }

  constructor(
    llmClient: LLMClient,
    toolExecutor: ToolExecutor,
    onActivity: (message: string, level: 'info' | 'success' | 'error' | 'warning') => void
  ) {
    this.llmClient = llmClient;
    this.toolExecutors = toolExecutor;
    this.onActivity = onActivity;
  }

  requestStop(): void {
    if (this.activeContext) {
      this.activeContext.abortRequested = true;
      this.onActivity('Stop requested — finishing current step...', 'warning');
    }
  }

  async processMeet(meetName: string): Promise<{ success: boolean; message: string; outputName?: string }> {
    // Prevent ghost context from previous runs
    if (this.lastContext && this.lastContext.meetName !== meetName) {
      console.log(`[AGENT] Clearing stale lastContext from "${this.lastContext.meetName}" (new run: "${meetName}")`);
    }
    this.lastContext = null;

    this.onActivity(`Starting agent for meet: ${meetName}`, 'info');
    let context: AgentContext | null = null;

    try {
      const basePrompt = this.loadBasePrompt();

      const logsDir = path.join(getDataDir(), 'logs');
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
      }
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
      const safeName = meetName.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
      const logPath = path.join(logsDir, `${safeName}_${timestamp}.md`);

      context = {
        meetName,
        systemPrompt: basePrompt,
        loadedSkills: [],
        messages: [],
        totalInputTokens: 0,
        totalOutputTokens: 0,
        onActivity: this.onActivity,
        abortRequested: false,
        logPath,
        iterationCount: 0,
        currentPhase: 'discovery',
        unlockedTools: [],
      };

      this.activeContext = context;

      // Check for saved progress
      const savedProgress = await loadProgressData();
        if (savedProgress && savedProgress.meet_name === meetName) {
          this.onActivity('Found saved progress, resuming...', 'info');
          context.loadedSkills = savedProgress.loaded_skills;
          if (savedProgress.current_phase) {
            switchPhase(context, savedProgress.current_phase);
          }
          if (savedProgress.idml_imported) {
            context.idmlImported = true;
          }
          if (savedProgress.output_name) {
            context.outputName = savedProgress.output_name;
          }
          if (savedProgress.state) {
            context.state = savedProgress.state;
          }
          if (savedProgress.postmark_date) context.postmarkDate = savedProgress.postmark_date;
          if (savedProgress.online_date) context.onlineDate = savedProgress.online_date;
          if (savedProgress.ship_date) context.shipDate = savedProgress.ship_date;
          if (savedProgress.build_database_failed) context.buildDatabaseFailed = true;
          if (savedProgress.suspicious_names?.length) context.suspiciousNames = savedProgress.suspicious_names;
          if (savedProgress.discovered_meet_ids?.length) context.discoveredMeetIds = savedProgress.discovered_meet_ids;

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
          } catch { /* data dir might not exist yet */ }

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
            content: `You are resuming work on meet "${meetName}". Current phase: ${context.currentPhase}.\n\nHere is your previous progress:\n\nSummary: ${savedProgress.summary}\n\nNext steps: ${savedProgress.next_steps}${fileInventory}${trackedFileStatus}\n\nPlease continue from where you left off. Use set_phase if you need to change phases.`,
          });
        } else {
          // Fresh start — reset staging DB and initialize phase
          resetStagingDb();
          setDbToolsPhase('discovery');

          // Detect mode from input prefix
          const editMatch = meetName.match(/^edit:\s*(.+)/i);
          const isFilePath = /^(\/|[A-Za-z]:\\|~|\/mnt\/)/.test(meetName.trim()) || meetName.includes('.idml') || meetName.includes('.pdf');

          if (editMatch) {
            // Edit mode — data already in central DB, skip to database phase
            const actualMeetName = editMatch[1].trim();
            context.meetName = actualMeetName;
            switchPhase(context, 'database');
            context.messages.push({
              role: 'user',
              content: `You are editing meet "${actualMeetName}". The meet data is already in the central database.\n\nThe user wants to make changes. Ask what they'd like to do. Available actions: fix gym names (rename_gym), check data (query_db), regenerate outputs (regenerate_output), view summary (get_meet_summary), re-publish changes (finalize_meet).`,
            });
          } else if (isFilePath) {
            const hasPdf = meetName.includes('.pdf');
            if (hasPdf) {
              // PDF import gets its own dedicated phase
              switchPhase(context, 'import_backs');
              context.messages.push({
                role: 'user',
                content: `The user provided PDF file path(s): "${meetName}"\n\nYou are in the IMPORT BACKS phase. Follow the steps in order:\n1. Use list_meets to find available meets\n2. Match the meet from context (filenames, user message) — only ask if ambiguous\n3. Use import_pdf_backs with the correct meet_name and state\n4. Open the generated files for user review`,
              });
            } else {
              // IDML files — redirect to import_backs phase, tell agent to request PDFs
              switchPhase(context, 'import_backs');
              context.messages.push({
                role: 'user',
                content: `The user provided IDML file path(s): "${meetName}"\n\nIDML import is no longer supported. Ask the user to export PDFs from InDesign instead (File → Export → PDF). Then use import_pdf_backs with the PDF file paths.`,
              });
            }
          } else {
            context.messages.push({
              role: 'user',
              content: `Please process the gymnastics meet: "${meetName}"\n\nYou are in the DISCOVERY phase. Find the meet results online, identify the data source, set a clean output name, and get deadline dates from the user. Use set_phase to advance when ready.`,
            });
          }
        }

      const result = await this.runLoop(context);
      saveProcessLog(context, result);
      this.activeContext = null;
      this.lastContext = context;
      return { ...result, outputName: context.outputName };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.onActivity(`Agent error: ${message}`, 'error');
      if (context) {
        saveProcessLog(context, { success: false, message: `CRASHED: ${message}` });
      }
      this.activeContext = null;
      return { success: false, message };
    }
  }

  async continueConversation(message: string): Promise<{ success: boolean; message: string }> {
    const context = this.lastContext;
    if (!context) {
      return { success: false, message: 'No previous conversation to continue. Process a meet first.' };
    }

    this.onActivity(`Follow-up: ${message}`, 'info');

    try {
      // Auto-switch to import_backs phase if user provides PDF file paths
      if (context.currentPhase !== 'import_backs' && containsUserPdfPath(message)) {
        switchPhase(context, 'import_backs');
        this.onActivity('Detected PDF file paths — switching to import_backs phase', 'info');
      }

      // Auto-trust ScoreCat meet IDs from user-provided URLs
      const scorecatUrlPattern = /scorecatonline\.com\/.*[?&]meetId=([A-Z0-9]+)/gi;
      let scorecatMatch;
      while ((scorecatMatch = scorecatUrlPattern.exec(message)) !== null) {
        if (!context.discoveredMeetIds) context.discoveredMeetIds = [];
        const id = scorecatMatch[1];
        if (!context.discoveredMeetIds.includes(id)) {
          context.discoveredMeetIds.push(id);
          this.onActivity(`Discovered meet ID from user-provided URL: ${id}`, 'info');
        }
      }

      context.messages.push({ role: 'user', content: message });
      context.abortRequested = false;
      this.activeContext = context;

      const result = await this.runLoop(context);
      saveProcessLog(context, result);
      this.activeContext = null;
      this.lastContext = context;
      return result;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.onActivity(`Agent error: ${errMsg}`, 'error');
      this.activeContext = null;
      return { success: false, message: errMsg };
    }
  }

  async queryResults(question: string): Promise<{ success: boolean; answer: string }> {
    try {
      // Use the fast query engine (keyword match → Supabase RPC, no LLM for common questions)
      const { answerQuery } = require('./query-engine');
      const answer = await answerQuery(question);
      return { success: true, answer };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.onActivity(`Query error: ${message}`, 'error');
      return { success: false, answer: message };
    }
  }

  // --- Private methods ---

  private loadBasePrompt(): string {
    const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    return `Today's date is ${today}.

# Gymnastics Meet Scoring System

You process gymnastics meet results from online sources into championship t-shirt outputs. You extract athlete scores, build a normalized SQLite database, and generate deliverables: back-of-shirt PDF + IDML, per-athlete order forms PDF, gym highlights PDF, and a meet summary.

## Data Directory
All tool outputs are saved to the data/ directory. Use read_file to read files. Do NOT try Chrome file:// URLs.

## Tool Usage Rules
- Use ask_user whenever you need user input or confirmation
- Use save_progress before approaching context limits
- File paths in tool results are authoritative — always use the exact path returned
- run_script provides DB_PATH, DATA_DIR, STAGING_DB_PATH as environment variables
- The Python processing code is a compiled binary — you cannot find or edit its source

## Gymnastics Domain Knowledge
- USAG (USA Gymnastics) has two programs: Competitive (Levels 1-10) and Xcel (Bronze, Silver, Gold, Platinum, Diamond, Sapphire)
- "All levels" for a USAG meet means BOTH numbered levels AND Xcel divisions
- AAU meets do NOT have Xcel — they have their own level structure
- A state championship typically covers all competitive levels; most sources split these across multiple separate meets
- Not all states offer every level — some states skip Level 1 or Level 5. This is normal and does not mean data is missing
- Men's gymnastics has different events (floor, pommel horse, rings, vault, parallel bars, high bar) and different level structures

## Iteration Budget
You have ~100 tool call iterations. If you hit the limit, explain progress via ask_user.`;
  }

  private async runLoop(context: AgentContext): Promise<{ success: boolean; message: string }> {
    const allTools = getToolDefinitions();
    const contextLimit = this.llmClient.getContextLimit();
    const iterationBatch = 100;
    let maxIterations = iterationBatch;
    let iterations = 0;

    const buildSystem = (): string => {
      let system = context.systemPrompt;
      system += '\n\n' + buildPhasePrompt(context.currentPhase);
      if (context.loadedSkills.length > 0) {
        system += '\n\n## Loaded Skills\n' + context.loadedSkills.join(', ');
      }
      return system;
    };

    // eslint-disable-next-line no-constant-condition
    while (true) {

    while (iterations < maxIterations) {
      iterations++;
      context.iterationCount = iterations;

      if (context.abortRequested) {
        this.onActivity('Stop requested by user. Saving progress...', 'warning');
        await this.doAutoSaveProgress(context);
        saveProcessLog(context, { success: true, message: 'Run stopped by user.' });
        return { success: true, message: 'Run stopped by user. Progress has been saved.' };
      }

      if (context.totalInputTokens > contextLimit * 0.8) {
        const pct = Math.round((context.totalInputTokens / contextLimit) * 100);
        this.onActivity(`Context is ${pct}% full. Saving progress...`, 'warning');
        await this.doAutoSaveProgress(context);
        this.onActivity('Progress saved! Run again to resume.', 'success');
        return { success: true, message: `Paused at ${pct}% context. Progress saved.` };
      }

      this.onActivity(`[${context.currentPhase}] Thinking...`, 'info');
      console.log(`[AGENT] Phase=${context.currentPhase} Iter ${iterations}/${maxIterations}, tokens: in=${context.totalInputTokens} out=${context.totalOutputTokens}`);

      this.validateMessageSequence(context.messages);

      let phaseTools = filterToolsForPhase(allTools, context.currentPhase, context.unlockedTools);

      // Chrome tools removed from discovery phase entirely (2.6) — no gating needed.
      // browse_mso and browse_scorecat provide URL-safe site access.

      let response: LLMResponse;
      try {
        console.log(`[AGENT] Sending LLM request with ${phaseTools.length} tools (phase: ${context.currentPhase})...`);
        response = await this.llmClient.sendMessage({
          system: buildSystem(),
          messages: context.messages,
          tools: phaseTools,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.onActivity(`LLM API error: ${message}`, 'error');
        await this.doAutoSaveProgress(context);
        return { success: false, message: `LLM error: ${message}` };
      }

      context.totalInputTokens = response.usage.input_tokens;
      context.totalOutputTokens += response.usage.output_tokens;

      for (const block of response.content) {
        if (block.type === 'text') {
          this.onActivity(block.text, 'info');
        }
      }

      if (response.stop_reason === 'end_turn') {
        const textBlocks = response.content.filter((b): b is import('./llm-client').TextBlock => b.type === 'text');
        const finalMessage = textBlocks.map((b) => b.text).join('\n');
        context.messages.push({ role: 'assistant', content: response.content });

        // After a context prune, the agent's first response often summarizes prior work
        // using words like "complete" and "ready" — always nudge it to continue.
        if (context.justPruned) {
          context.justPruned = false;
          this.onActivity('Continuing after phase transition...', 'info');
          context.messages.push({
            role: 'user',
            content: 'You just transitioned to a new phase. Please proceed with the work for this phase — call the appropriate tools now.',
          });
          continue;
        }

        const lowerText = finalMessage.toLowerCase();
        const planPatterns = /\blet me (now |then )?(run|call|use|execute|extract|generate|regenerate)\b|\bnext.{0,20}(build_database|regenerate_output|import_idml|run_script|scorecat_extract|mso_extract|query_db)\b|\bi'll (now |then )?(run|call|use|execute|extract|generate)\b/.test(lowerText);
        const completionPatterns = /\bdone\b|\bcomplete\b|\bfinished\b|\bno (more|further)\b|\breview\b|\bready\b|\bgenerated\b|\bsuccessfully\b/.test(lowerText);
        if (planPatterns && !completionPatterns && iterations < maxIterations - 1) {
          this.onActivity('Continuing — agent described next steps without executing them.', 'info');
          context.messages.push({
            role: 'user',
            content: 'You described next steps but stopped without executing them. Please continue by calling the appropriate tools now.',
          });
          continue;
        }

        this.onActivity('Agent completed processing.', 'success');
        return { success: true, message: finalMessage || 'Processing complete.' };
      }

      if (response.stop_reason === 'max_tokens') {
        context.messages.push({ role: 'assistant', content: response.content });
        const orphanedToolUses = response.content.filter((b): b is import('./llm-client').ToolUseBlock => b.type === 'tool_use');
        if (orphanedToolUses.length > 0) {
          const dummyResults: ContentBlock[] = orphanedToolUses.map(tu => ({
            type: 'tool_result' as const,
            tool_use_id: tu.id,
            content: 'Error: Response was truncated. Please try again.',
          }));
          context.messages.push({ role: 'user', content: dummyResults });
        } else {
          context.messages.push({ role: 'user', content: 'Your response was truncated. Please continue.' });
        }
        continue;
      }

      if (response.stop_reason === 'tool_use') {
        // Agent is actively calling tools — it's working in the current phase.
        // Consume justPruned so the eventual end_turn exits normally.
        context.justPruned = false;

        const phaseBeforeTools = context.currentPhase;
        context.messages.push({ role: 'assistant', content: response.content });
        const toolResults = await this.executeToolCalls(response.content, context);
        context.messages.push({ role: 'user', content: toolResults });

        // Auto-switch to import_backs if ANY user-facing tool result contains PDF paths.
        // Check ask_user results AND any tool result that looks like a user message
        // (the user might provide PDFs via ask_user or via continueConversation).
        if (context.currentPhase !== 'import_backs') {
          const allResultText = toolResults
            .filter((b): b is import('./llm-client').ToolResultBlock => b.type === 'tool_result')
            .map(b => typeof b.content === 'string' ? b.content : '')
            .join(' ');

          if (containsUserPdfPath(allResultText)) {
            switchPhase(context, 'import_backs');
            this.onActivity('Detected PDF file paths in user response — switching to import_backs phase', 'info');
            console.log(`[AGENT] Auto-switch triggered. Result text: ${allResultText.substring(0, 200)}`);
          }
        }

        // Prune context on phase transition — condense prior work into a compact handoff
        if (context.currentPhase !== phaseBeforeTools) {
          // Flush the process log BEFORE pruning so pre-prune messages are preserved
          saveProcessLog(context, {
            success: false,
            message: `IN PROGRESS — phase transition: ${phaseBeforeTools} → ${context.currentPhase}`,
          });
          await this.pruneContextForPhaseTransition(context, phaseBeforeTools);
          // Reset the log index so post-prune messages append correctly
          context.lastLoggedMessageIndex = 0;
        }
      }

      if (iterations % 5 === 0) {
        saveProcessLog(context, {
          success: false,
          message: `IN PROGRESS — phase: ${context.currentPhase}, iteration ${iterations}/${maxIterations}`,
        });
      }
    }

    // Iteration limit checkpoint
    this.onActivity(`Reached iteration limit (${maxIterations})...`, 'warning');
    const totalTokens = context.totalInputTokens + context.totalOutputTokens;
    context.messages.push({
      role: 'user',
      content: `You have reached the iteration limit (${maxIterations}). Token usage: ${totalTokens.toLocaleString()} total.\n\nYou MUST use ask_user to explain progress and ask whether to continue (${iterationBatch} more iterations) or stop. Options: ["Continue", "Stop and save progress"]`,
    });

    try {
      const phaseTools = filterToolsForPhase(allTools, context.currentPhase, context.unlockedTools);
      const checkpointResponse = await this.llmClient.sendMessage({
        system: buildSystem(),
        messages: context.messages,
        tools: phaseTools,
      });

      context.messages.push({ role: 'assistant', content: checkpointResponse.content });
      for (const block of checkpointResponse.content) {
        if (block.type === 'text') this.onActivity(block.text, 'info');
      }

      if (checkpointResponse.content.some(b => b.type === 'tool_use')) {
        const toolResults = await this.executeToolCalls(checkpointResponse.content, context);
        context.messages.push({ role: 'user', content: toolResults });

        const userChoice = toolResults
          .filter((b): b is import('./llm-client').ToolResultBlock => b.type === 'tool_result')
          .map(b => typeof b.content === 'string' ? b.content : '')
          .join('');

        if (userChoice.toLowerCase().includes('continue')) {
          this.onActivity(`Continuing with ${iterationBatch} more iterations...`, 'info');
          maxIterations += iterationBatch;
          continue;
        }
      }

      await this.doAutoSaveProgress(context);
      this.onActivity('Progress saved. Run again to continue.', 'success');
      return { success: false, message: 'Agent reached iteration limit. Progress saved.' };
    } catch {
      await this.doAutoSaveProgress(context);
      return { success: false, message: 'Agent reached iteration limit. Progress saved.' };
    }

    } // end outer while(true)
  }

  private validateMessageSequence(messages: LLMMessage[]): void {
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role !== 'assistant' || typeof msg.content === 'string') continue;

      const toolUseIds = msg.content
        .filter((b): b is import('./llm-client').ToolUseBlock => b.type === 'tool_use')
        .map(b => b.id);

      if (toolUseIds.length === 0) continue;

      const nextMsg = messages[i + 1];
      if (!nextMsg || nextMsg.role !== 'user' || typeof nextMsg.content === 'string') {
        const dummyResults: ContentBlock[] = toolUseIds.map(id => ({
          type: 'tool_result' as const,
          tool_use_id: id,
          content: 'Error: Tool result was lost. Please retry.',
        }));
        messages.splice(i + 1, 0, { role: 'user', content: dummyResults });
        continue;
      }

      if (Array.isArray(nextMsg.content)) {
        const resultIds = new Set(
          nextMsg.content
            .filter((b): b is import('./llm-client').ToolResultBlock => b.type === 'tool_result')
            .map(b => b.tool_use_id)
        );
        const missingIds = toolUseIds.filter(id => !resultIds.has(id));
        if (missingIds.length > 0) {
          const dummyResults: ContentBlock[] = missingIds.map(id => ({
            type: 'tool_result' as const,
            tool_use_id: id,
            content: 'Error: Tool result was lost. Please retry.',
          }));
          (nextMsg.content as ContentBlock[]).push(...dummyResults);
        }
      }
    }
  }

  // Tools that are safe to run concurrently (read-only, no shared mutable state)
  private static readonly PARALLELIZABLE_TOOLS = new Set([
    'render_pdf_page',
    'query_db',
    'query_db_to_file',
    'list_output_files',
    'list_meets',
    'get_meet_summary',
    'read_file',
    'list_skills',
    'open_file',
  ]);

  private async executeToolCalls(
    content: ContentBlock[],
    context: AgentContext
  ): Promise<ContentBlock[]> {
    const toolCalls = content.filter((b): b is import('./llm-client').ToolUseBlock => b.type === 'tool_use');

    // If all tools in this batch are parallelizable, run them concurrently
    const canParallelize = toolCalls.length > 1 &&
      toolCalls.every(call => AgentLoop.PARALLELIZABLE_TOOLS.has(call.name));

    if (canParallelize) {
      console.log(`[AGENT] Running ${toolCalls.length} tools in parallel: ${toolCalls.map(c => c.name).join(', ')}`);
      const results = await Promise.all(
        toolCalls.map(call => this.executeSingleTool(call, context))
      );
      return results;
    }

    // Otherwise, run sequentially (preserves ordering for stateful tools)
    const results: ContentBlock[] = [];
    for (const call of toolCalls) {
      results.push(await this.executeSingleTool(call, context));
    }
    return results;
  }

  private async executeSingleTool(
    call: import('./llm-client').ToolUseBlock,
    context: AgentContext
  ): Promise<ContentBlock> {
    const toolName = call.name;
    const toolArgs = call.input;
    const toolId = call.id;

    if (toolName === 'ask_user' && context.logPath) {
      saveProcessLog(context, {
        success: false,
        message: `IN PROGRESS — waiting for user response (iteration ${context.iterationCount})`,
      });
    }

    this.onActivity(`[${context.currentPhase}] Running tool: ${toolName}...`, 'info');
    console.log(`[AGENT] Running tool: ${toolName} args=${JSON.stringify(toolArgs).substring(0, 200)}`);

    let result: ToolResultContent;
    try {
      result = await this.executeTool(toolName, toolArgs, context);
      const textPreview = toolResultText(result);
      const preview = textPreview.length > 200 ? textPreview.substring(0, 200) + '...' : textPreview;
      this.onActivity(`Tool ${toolName} result: ${preview}`, 'info');

      // Track search_meets results: discover IDs and gate Chrome tools
      if (toolName === 'search_meets' && typeof result === 'string' && !result.includes('No meets found')) {
        context.searchMeetsReturned = true;
        // Extract discovered meet IDs from the result
        const idPattern = /ID:\s*(\S+)/g;
        let idMatch;
        if (!context.discoveredMeetIds) context.discoveredMeetIds = [];
        while ((idMatch = idPattern.exec(result)) !== null) {
          const id = idMatch[1].replace(/[|,]/g, '');
          if (id && !context.discoveredMeetIds.includes(id)) {
            context.discoveredMeetIds.push(id);
          }
        }
        if (context.discoveredMeetIds.length > 0) {
          console.log(`[AGENT] Discovered meet IDs: ${context.discoveredMeetIds.join(', ')}`);
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      result = `Error: ${errMsg}`;
      this.onActivity(`Tool ${toolName} failed: ${errMsg}`, 'error');
    }

    return {
      type: 'tool_result',
      tool_use_id: toolId,
      content: result,
    };
  }

  private async executeTool(
    name: string,
    args: Record<string, unknown>,
    context: AgentContext
  ): Promise<ToolResultContent> {
    // --- Structural enforcement checks ---

    // search_meets: track calls, limit to 5, cache results
    if (name === 'search_meets') {
      const count = (context.searchMeetsCallCount || 0) + 1;
      context.searchMeetsCallCount = count;
      if (count > 5) {
        return 'Error: search_meets has been called 6+ times. The meets you need should already be in the results above. ' +
          'If you cannot find a meet, use ask_user to ask the user for the meet NAME or URL — never ask for IDs.';
      }
    }

    // Extraction tools: reject IDs not discovered by search_meets (prevents brute-force guessing)
    if ((name === 'mso_extract' || name === 'scorecat_extract') && context.discoveredMeetIds && context.discoveredMeetIds.length > 0) {
      const meetIds = Array.isArray(args.meet_ids) ? args.meet_ids as string[] : [];
      const undiscovered = meetIds.filter(id => !context.discoveredMeetIds!.includes(id));
      if (undiscovered.length > 0) {
        return `Error: Meet ID(s) ${undiscovered.join(', ')} were not found by search_meets. ` +
          'Do NOT guess meet IDs. Use search_meets to find the correct IDs first.';
      }
    }

    // ask_user during extraction: reject questions asking for meet IDs
    if (name === 'ask_user' && context.currentPhase === 'extraction') {
      const question = String((args as Record<string, unknown>).question || '').toLowerCase();
      if (/\bmeet\s*id\b|\bsource\s*id\b|\bmso\s*id\b|\bscorecat\s*id\b/.test(question)) {
        return 'Error: Do not ask the user for meet IDs. Users do not know platform-specific IDs. ' +
          'Use search_meets to find IDs, or ask for the meet NAME or URL instead.';
      }
    }

    // Validate finalize_meet meet_name matches context.outputName
    if (name === 'finalize_meet' && context.outputName) {
      const fmName = typeof args.meet_name === 'string' ? args.meet_name : '';
      if (fmName && fmName !== context.outputName) {
        console.warn(`[AGENT] finalize_meet meet_name "${fmName}" auto-corrected to "${context.outputName}"`);
        args = { ...args, meet_name: context.outputName };
      }
    }

    // Clear suspicious names gate after fix_names succeeds
    if (name === 'fix_names') {
      const result = await this.toolExecutors[name](args);
      const resultStr = typeof result === 'string' ? result : '';
      if (!resultStr.startsWith('Error')) {
        context.suspiciousNames = undefined;
      }
      return result;
    }

    // External tool executors first
    if (this.toolExecutors[name]) {
      return this.toolExecutors[name](args);
    }

    // Context-aware tools
    switch (name) {
      case 'set_phase':
        return toolSetPhase(requireString(args, 'phase') as WorkflowPhase, requireString(args, 'reason'), context);

      case 'unlock_tool':
        return toolUnlockTool(requireString(args, 'tool_name'), requireString(args, 'reason'), context);

      case 'build_database':
        return toolBuildDatabase(args, context);

      case 'regenerate_output':
        return toolRegenerateOutput(args, context);

      case 'import_pdf_backs':
        return toolImportPdfBacks(args, context);

      case 'set_output_name': {
        const newName = requireString(args, 'name');
        // Prevent name change when folder already has files
        if (context.outputName && newName !== context.outputName) {
          const oldDir = getOutputDir(context.outputName, false);
          if (fs.existsSync(oldDir) && fs.readdirSync(oldDir).length > 0) {
            return `Error: Cannot change output name — folder "${context.outputName}" already contains files. Use "Clear Session" to start fresh if you need a different name.`;
          }
        }
        // Try to normalize to canonical format if we have enough context
        const { normalizeMeetName, normalizeState } = require('./meet-naming');
        const state = normalizeState(context.state || (args.state as string) || '');
        const yearMatch = newName.match(/\b(20\d{2})\b/);
        const year = yearMatch ? yearMatch[1] : new Date().getFullYear().toString();
        if (state && state.length === 2) {
          // Extract dates from the name if present (e.g., "March 14-16")
          const dateMatch = newName.match(/((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d[\d\s,-]*)/i);
          const normalized = normalizeMeetName({
            association: 'USAG', gender: 'W', sport: 'Gymnastics',
            year, state,
            dates: dateMatch ? dateMatch[1].replace(/,?\s*\d{4}\s*$/, '').trim() : undefined,
          });
          context.outputName = normalized;
          if (normalized !== newName) {
            return `Output folder name normalized to: "${normalized}" (from "${newName}")`;
          }
        } else {
          context.outputName = newName;
        }
        return `Output folder name set to: "${context.outputName}"`;
      }

      case 'render_pdf_page':
        return toolRenderPdfPage(optionalString(args, 'pdf_path'), args.page_number as number | undefined, context.outputName || context.meetName);

      case 'open_file':
        return toolOpenFile(requireString(args, 'file_path'), context.outputName || context.meetName);

      case 'list_output_files':
        return toolListOutputFiles(optionalString(args, 'meet_name') || context.outputName || context.meetName);

      case 'list_skills':
        return toolListSkills();

      case 'load_skill':
        return toolLoadSkill(requireString(args, 'skill_name'), context);

      case 'save_progress':
        return toolSaveProgress(context, requireString(args, 'summary'), requireString(args, 'next_steps'), optionalString(args, 'data_files'));

      case 'load_progress':
        return toolLoadProgress();

      default:
        return `Error: Unknown tool "${name}"`;
    }
  }

  // Tools whose arguments contain key facts worth preserving in a phase handoff
  private static readonly HANDOFF_TOOL_ARGS: Record<string, string[]> = {
    search_meets: ['query', 'state'],
    lookup_meet: ['source', 'meet_id'],
    mso_extract: ['meet_ids'],
    scorecat_extract: ['meet_ids'],
    build_database: ['source', 'data_path', 'state', 'meet_name', 'postmark_date', 'online_date', 'ship_date', 'division_order', 'source_id', 'source_name', 'meet_dates'],
    set_output_name: ['name'],
    regenerate_output: ['state', 'meet_name', 'outputs'],
    import_pdf_backs: ['pdf_paths', 'state', 'meet_name'],
  };

  /**
   * Condense the message history into a compact handoff when transitioning phases.
   * Runs two extraction strategies in parallel:
   *   1. Automated: tool arguments, ask_user Q&A, file paths, agent text
   *   2. LLM-generated: a lightweight model summarizes the full conversation
   * Then combines both into a single handoff message.
   */
  private async pruneContextForPhaseTransition(context: AgentContext, fromPhase: string): Promise<void> {
    const messages = [...context.messages]; // snapshot before we mutate

    // Start LLM summary in parallel (best-effort, 15s timeout)
    const llmSummaryPromise = Promise.race([
      this.generateLLMSummary(messages),
      new Promise<null>(resolve => setTimeout(() => resolve(null), 15000)),
    ]);

    // --- Automated extraction (synchronous) ---
    const agentTexts: string[] = [];
    const askUserExchanges: string[] = [];
    const keyFiles: Set<string> = new Set();
    const toolArgSnapshots: string[] = [];
    const keyToolResults: string[] = [];
    const filePattern = /(?:(?:[A-Za-z]:\\[\w\\. -]+|\/[\w./_-]+)\.(?:json|pdf|db|idml|txt|csv))/g;

    // Tools whose RESULTS contain critical data (IDs, counts, file paths) that must survive pruning
    const HANDOFF_RESULT_TOOLS = new Set([
      'search_meets', 'lookup_meet', 'mso_extract', 'scorecat_extract',
      'build_database', 'get_meet_summary',
    ]);

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (typeof msg.content === 'string') continue;

      if (msg.role === 'assistant') {
        for (const block of msg.content) {
          if (block.type === 'text') {
            agentTexts.push(block.text);
          }
          // Extract key arguments from important tool calls
          if (block.type === 'tool_use') {
            const keysToCapture = AgentLoop.HANDOFF_TOOL_ARGS[block.name];
            if (keysToCapture) {
              const args = block.input as Record<string, unknown>;
              const captured: string[] = [];
              for (const key of keysToCapture) {
                if (args[key] !== undefined && args[key] !== null) {
                  captured.push(`${key}: ${JSON.stringify(args[key])}`);
                }
              }
              if (captured.length > 0) {
                toolArgSnapshots.push(`${block.name}(${captured.join(', ')})`);
              }
            }
          }
        }
      }

      if (msg.role === 'user') {
        for (const block of msg.content) {
          if (block.type !== 'tool_result') continue;
          const resultText = typeof block.content === 'string' ? block.content : '';

          // Extract file paths from tool results
          const matches = resultText.match(filePattern);
          if (matches) matches.forEach(f => keyFiles.add(f));

          // Capture truncated results from key tools (meet IDs, extraction summaries, etc.)
          const prevMsg = i > 0 ? messages[i - 1] : null;
          if (prevMsg && prevMsg.role === 'assistant' && typeof prevMsg.content !== 'string') {
            const matchingToolUse = prevMsg.content.find(
              (b): b is import('./llm-client').ToolUseBlock =>
                b.type === 'tool_use' && b.id === block.tool_use_id
            );
            if (matchingToolUse) {
              if (matchingToolUse.name === 'ask_user') {
                const question = String((matchingToolUse.input as Record<string, unknown>).question || '');
                askUserExchanges.push(`Q: ${question}\nA: ${resultText}`);
              } else if (HANDOFF_RESULT_TOOLS.has(matchingToolUse.name)) {
                // Keep first 800 chars of result — enough for meet IDs, counts, file paths
                const truncated = resultText.length > 800 ? resultText.substring(0, 800) + '...' : resultText;
                keyToolResults.push(`[${matchingToolUse.name} result]: ${truncated}`);
              }
            }
          }
        }
      }
    }

    // Await the LLM summary (may be null if it failed or timed out)
    const llmSummary = await llmSummaryPromise;

    // Safety net: if automated extraction produced no content at all, keep recent
    // text from the last 5 messages instead of an empty handoff.
    const hasContent = agentTexts.length > 0 || askUserExchanges.length > 0 || keyToolResults.length > 0;
    if (!hasContent && !llmSummary) {
      console.warn('[AGENT] Handoff empty — preserving recent text from last 5 messages');
      const recentText = messages.slice(-5)
        .flatMap(m => typeof m.content === 'string' ? [m.content] :
          m.content.filter((b): b is import('./llm-client').TextBlock => b.type === 'text').map(b => b.text))
        .join('\n\n');
      context.messages = [{
        role: 'user',
        content: `[Phase: ${fromPhase} → ${context.currentPhase}]\n\nMeet: "${context.meetName}"${context.outputName ? ` | Output: "${context.outputName}"` : ''}${context.state ? ` | State: ${context.state}` : ''}\n\n${recentText || 'No context available — ask the user what to do.'}`,
      }];
      context.loadedSkills = [];
      context.justPruned = true;
      this.onActivity(
        `Context pruned for ${fromPhase} → ${context.currentPhase} (empty handoff — preserved recent text)`,
        'warning'
      );
      return;
    }

    // Use the last few agent text blocks as automated summary (capped)
    const recentTexts = agentTexts.slice(-3);
    let autoSummary = recentTexts.join('\n\n');
    if (autoSummary.length > 2000) {
      autoSummary = autoSummary.slice(-2000);
    }

    // --- Build the handoff message ---
    const parts: string[] = [
      `[Phase handoff: ${fromPhase} → ${context.currentPhase}]`,
      '',
      `You are processing meet "${context.meetName}".`,
    ];
    if (context.outputName) parts.push(`Output name: "${context.outputName}"`);
    if (context.state) parts.push(`State: ${context.state}`);
    parts.push('');

    if (toolArgSnapshots.length > 0) {
      // Deduplicate — keep only the last call per tool name (e.g., 8x regenerate_output → 1)
      const lastByTool = new Map<string, string>();
      for (const snap of toolArgSnapshots) {
        const toolName = snap.split('(')[0];
        lastByTool.set(toolName, snap);
      }
      parts.push('Key tool calls from prior phases:');
      for (const snap of lastByTool.values()) parts.push(`  ${snap}`);
      parts.push('');
    }

    if (keyToolResults.length > 0) {
      parts.push('Key tool results from prior phases:');
      parts.push(...keyToolResults);
      parts.push('');
    }

    if (askUserExchanges.length > 0) {
      parts.push('User responses from prior phases:');
      parts.push(...askUserExchanges);
      parts.push('');
    }

    if (llmSummary) {
      parts.push('Context summary:');
      parts.push(llmSummary);
      parts.push('');
    }

    parts.push('Agent notes from prior phases:');
    parts.push(autoSummary);

    if (keyFiles.size > 0) {
      parts.push('');
      parts.push('Key files on disk:');
      for (const f of keyFiles) parts.push(`  ${f}`);
    }

    // Generate prescriptive next-step when transitioning to extraction
    // Parse search_meets results to determine which tool to call and with what IDs
    if (context.currentPhase === 'extraction' && keyToolResults.length > 0) {
      const searchResult = keyToolResults.find(r => r.startsWith('[search_meets result]'));
      if (searchResult) {
        const msoIds: string[] = [];
        const scorecatIds: string[] = [];
        // Parse "Source: mso | ID: 12345" and "Source: scorecat | ID: ABC123" patterns
        const meetPattern = /Source:\s*(mso|scorecat)\s*\|\s*ID:\s*(\S+)/gi;
        let match;
        while ((match = meetPattern.exec(searchResult)) !== null) {
          const [, source, id] = match;
          if (source.toLowerCase() === 'mso') msoIds.push(id);
          else if (source.toLowerCase() === 'scorecat') scorecatIds.push(id);
        }

        parts.push('');
        parts.push('## Next Step');
        if (scorecatIds.length > 0 && msoIds.length > 0) {
          parts.push(`This meet has data on both sources. Call both extraction tools:`);
          parts.push(`  1. mso_extract with meet_ids: ${JSON.stringify(msoIds)}`);
          parts.push(`  2. scorecat_extract with meet_ids: ${JSON.stringify(scorecatIds)}`);
        } else if (scorecatIds.length > 0) {
          parts.push(`This meet is on ScoreCat. Call: scorecat_extract with meet_ids: ${JSON.stringify(scorecatIds)}`);
        } else if (msoIds.length > 0) {
          parts.push(`This meet is on MSO. Call: mso_extract with meet_ids: ${JSON.stringify(msoIds)}`);
        } else {
          parts.push('Continue with extraction using the appropriate dedicated tool.');
        }
      }
    } else if (context.currentPhase === 'import_backs') {
      // Dedicated handoff for import_backs: surface PDF paths from tool results
      const pdfPaths: string[] = [];
      for (const f of keyFiles) {
        if (f.toLowerCase().endsWith('.pdf')) pdfPaths.push(f);
      }
      // Also scan recent messages for PDF paths that may have been in user text
      for (const msg of messages.slice(-5)) {
        const msgText = typeof msg.content === 'string' ? msg.content :
          msg.content.filter((b): b is import('./llm-client').TextBlock => b.type === 'text').map(b => b.text).join(' ');
        const pdfMatches = msgText.match(/(?:[A-Za-z]:\\[\w\\. -]+|\/[\w./_-]+|~\/[\w./_-]+)\.pdf/gi);
        if (pdfMatches) pdfMatches.forEach(p => { if (!pdfPaths.includes(p)) pdfPaths.push(p); });
      }

      parts.push('');
      parts.push('## Next Step');
      if (pdfPaths.length > 0) {
        parts.push(`The user provided PDF file(s) for import:`);
        for (const p of pdfPaths) parts.push(`  - ${p}`);
        parts.push('');
        parts.push('Use the `import_pdf_backs` tool with these PDF paths. Do NOT manually copy files with run_script.');
      } else {
        parts.push('You are in the import_backs phase. Use `import_pdf_backs` to import edited PDF back pages.');
        parts.push('If the user has not yet provided PDF file paths, use `ask_user` to request them.');
      }
    } else {
      parts.push('');
      parts.push('Continue working in the current phase. Use read_file or query_db to access data from earlier phases if needed.');
    }

    const handoff = parts.join('\n');

    // Replace messages and clear loaded skills; reset per-phase counters
    const oldMessageCount = context.messages.length;
    context.messages = [{ role: 'user', content: handoff }];
    context.loadedSkills = [];
    context.searchMeetsCallCount = 0;
    context.justPruned = true; // Prevent next end_turn from exiting the loop

    const handoffTokenEstimate = Math.round(handoff.length / 4);
    console.log(
      `[AGENT] Context pruned: ${oldMessageCount} messages → 1 handoff (~${handoffTokenEstimate} tokens). ` +
      `LLM summary: ${llmSummary ? 'yes' : 'skipped'}. Tool snapshots: ${toolArgSnapshots.length}.`
    );
    this.onActivity(
      `Context pruned for ${fromPhase} → ${context.currentPhase} transition (${oldMessageCount} messages → compact handoff)`,
      'info'
    );
  }

  /**
   * Generate a concise summary of the conversation using a lightweight LLM.
   * Uses qwen on OpenRouter or haiku on Anthropic/subscription.
   * Returns null on any failure (best-effort).
   */
  private async generateLLMSummary(messages: LLMMessage[]): Promise<string | null> {
    try {
      const { configStore } = await import('./config-store');
      const provider = configStore.get('apiProvider');
      const apiKey = configStore.get('apiKey');

      // Subscription provider doesn't need an API key (uses OAuth)
      if (provider !== 'subscription' && !apiKey) return null;

      const model = provider === 'openrouter'
        ? 'qwen/qwen3.5-35b-a3b'
        : 'claude-haiku-4-5-20251001';

      const condensed = this.buildCondensedConversation(messages);
      if (!condensed) return null;

      const summaryClient = new LLMClient({ provider, apiKey, model });
      const response = await summaryClient.sendMessage({
        system: [
          'You are summarizing an agent conversation for a phase-transition handoff.',
          'Extract and state ALL key facts concisely: meet name, data source and IDs, state,',
          'deadline dates, athlete counts, level distribution, division ordering, any issues or',
          'user preferences. Be specific — include numbers, IDs, and exact values.',
          'Keep it under 300 words. No preamble.',
        ].join(' '),
        messages: [{ role: 'user', content: condensed }],
        tools: [],
      });

      const textBlocks = response.content.filter(
        (b): b is import('./llm-client').TextBlock => b.type === 'text'
      );
      const summary = textBlocks.map(b => b.text).join('\n');
      console.log(`[AGENT] LLM summary generated (${summary.length} chars, model: ${model})`);
      return summary || null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[AGENT] LLM summary failed (non-fatal): ${msg.substring(0, 200)}`);
      return null;
    }
  }

  /**
   * Build a condensed text representation of the conversation for the summary model.
   * Includes agent text, tool names + key args, and truncated tool results.
   */
  private buildCondensedConversation(messages: LLMMessage[]): string {
    const parts: string[] = [];

    for (const msg of messages) {
      if (typeof msg.content === 'string') {
        parts.push(`[${msg.role}] ${msg.content}`);
        continue;
      }

      for (const block of msg.content) {
        if (block.type === 'text') {
          parts.push(`[${msg.role}] ${block.text}`);
        } else if (block.type === 'tool_use') {
          const argsStr = JSON.stringify(block.input);
          parts.push(`[tool: ${block.name}] ${argsStr.substring(0, 400)}`);
        } else if (block.type === 'tool_result') {
          const text = typeof block.content === 'string' ? block.content : '[non-text content]';
          parts.push(`[result] ${text.substring(0, 500)}`);
        }
      }
    }

    let result = parts.join('\n');
    // Cap at ~10K chars to keep the summary model's input reasonable
    if (result.length > 10000) {
      result = result.slice(-10000);
    }
    return result;
  }

  private async doAutoSaveProgress(context: AgentContext): Promise<void> {
    const summary = extractProgressSummary(context);
    const nextSteps = extractNextSteps(context);
    await autoSaveProgress(context, summary, nextSteps);
  }
}
