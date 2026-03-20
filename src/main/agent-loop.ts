/**
 * Agent Loop - Orchestrates LLM calls and tool execution for meet processing.
 * Uses a phase-based architecture where each phase has its own tools and prompt.
 */

import * as fs from 'fs';
import * as path from 'path';
import { LLMClient, LLMMessage, ContentBlock, LLMResponse, ToolResultContent } from './llm-client';
import { resetStagingDb } from './tools/python-tools';
import { getDataDir } from './paths';
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

// --- Types ---

interface ToolExecutor {
  [toolName: string]: (args: Record<string, unknown>) => Promise<string>;
}

// --- Agent Loop ---

export class AgentLoop {
  private llmClient: LLMClient;
  private toolExecutors: ToolExecutor;
  private onActivity: (message: string, level: 'info' | 'success' | 'error' | 'warning') => void;
  private queryConversation: LLMMessage[] = [];
  private activeContext: AgentContext | null = null;
  private lastContext: AgentContext | null = null;

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
    this.onActivity(`Starting agent for meet: ${meetName}`, 'info');
    let context: AgentContext | null = null;

    try {
      const basePrompt = this.loadBasePrompt();
      resetStagingDb();

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
          context.currentPhase = savedProgress.current_phase;
        }
        if (savedProgress.idml_imported) {
          context.idmlImported = true;
        }

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
        // Fresh start — detect IDML import vs normal meet
        const isFilePath = /^(\/|[A-Za-z]:\\|~|\/mnt\/)/.test(meetName.trim()) || meetName.includes('.idml') || meetName.includes('.pdf');
        if (isFilePath) {
          const hasPdf = meetName.includes('.pdf');
          if (hasPdf) {
            // PDF import gets its own dedicated phase
            context.currentPhase = 'import_backs';
            context.messages.push({
              role: 'user',
              content: `The user provided PDF file path(s): "${meetName}"\n\nYou are in the IMPORT BACKS phase. Follow the steps in order:\n1. Use list_meets to find available meets\n2. Match the meet from context (filenames, user message) — only ask if ambiguous\n3. Use import_pdf_backs with the correct meet_name and state\n4. Open the generated files for user review`,
            });
          } else {
            // IDML files — redirect to import_backs phase, tell agent to request PDFs
            context.currentPhase = 'import_backs';
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
      const querySystem = `You are a gymnastics meet data analyst. Use the query_db tool to answer questions about meet results in the SQLite database.

## Database Schema
**results**: id, state, meet_name, association, name, gym, session, level, division, vault (REAL), bars (REAL), beam (REAL), floor (REAL), aa (REAL), rank, num
**winners**: id, state, meet_name, association, name, gym, session, level, division, event, score (REAL), is_tie (INTEGER)

Give clear, concise answers.`;

      if (this.queryConversation.length > 20) {
        this.queryConversation = this.queryConversation.slice(-10);
      }

      this.queryConversation.push({ role: 'user', content: question });

      const queryTools = getToolDefinitions().filter((t) =>
        ['query_db', 'query_db_to_file', 'list_output_files', 'list_meets', 'get_meet_summary'].includes(t.name)
      );

      const dummyContext: AgentContext = {
        meetName: '_query',
        systemPrompt: querySystem,
        loadedSkills: [],
        messages: this.queryConversation,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        onActivity: this.onActivity,
        abortRequested: false,
        iterationCount: 0,
        currentPhase: 'output_finalize',
        unlockedTools: [],
      };

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
          const textBlocks = response.content.filter((b): b is import('./llm-client').TextBlock => b.type === 'text');
          answer = textBlocks.map((b) => b.text).join('\n');
          this.queryConversation.push({ role: 'assistant', content: response.content });
          break;
        }

        if (response.stop_reason === 'tool_use') {
          this.queryConversation.push({ role: 'assistant', content: response.content });
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

      const phaseTools = filterToolsForPhase(allTools, context.currentPhase, context.unlockedTools);

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
        context.messages.push({ role: 'assistant', content: response.content });
        const toolResults = await this.executeToolCalls(response.content, context);
        context.messages.push({ role: 'user', content: toolResults });
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

  private async executeToolCalls(
    content: ContentBlock[],
    context: AgentContext
  ): Promise<ContentBlock[]> {
    const toolCalls = content.filter((b): b is import('./llm-client').ToolUseBlock => b.type === 'tool_use');
    const results: ContentBlock[] = [];

    for (const call of toolCalls) {
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

  private async executeTool(
    name: string,
    args: Record<string, unknown>,
    context: AgentContext
  ): Promise<ToolResultContent> {
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

      case 'set_output_name':
        context.outputName = requireString(args, 'name');
        return `Output folder name set to: "${context.outputName}"`;

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

  private async doAutoSaveProgress(context: AgentContext): Promise<void> {
    const summary = extractProgressSummary(context);
    const nextSteps = extractNextSteps(context);
    await autoSaveProgress(context, summary, nextSteps);
  }
}
