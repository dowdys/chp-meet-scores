/**
 * Agent Loop - Orchestrates LLM calls and tool execution for meet processing.
 * Manages conversation history, token tracking, skill loading, and progress save/load.
 */

import * as fs from 'fs';
import * as path from 'path';
import { LLMClient, LLMMessage, ContentBlock, LLMResponse, ToolResultContent } from './llm-client';
import { resetStagingDb } from './tools/python-tools';
import { getProjectRoot, getDataDir } from './paths';
import { getToolDefinitions } from './tool-definitions';
import {
  AgentContext,
  toolRunPython,
  toolRenderPdfPage,
  toolOpenFile,
  toolListOutputFiles,
  toolListSkills,
  toolLoadSkill,
  toolLoadSkillDetail,
  toolSaveDraftSkill,
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
  private lastContext: AgentContext | null = null; // Preserved after processMeet for continuation

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
  async processMeet(meetName: string): Promise<{ success: boolean; message: string; outputName?: string }> {
    this.onActivity(`Starting agent for meet: ${meetName}`, 'info');

    // Declare context outside try so it's accessible in catch for log saving
    let context: AgentContext | null = null;

    try {
      // Load system prompt
      const systemPrompt = this.loadSystemPrompt();
      // Reset staging DB for a fresh meet
      resetStagingDb();

      // Create a stable log file path so we can save incrementally
      const logsDir = path.join(getDataDir(), 'logs');
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
      }
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
      const safeName = meetName.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
      const logPath = path.join(logsDir, `${safeName}_${timestamp}.md`);

      context = {
        meetName,
        systemPrompt,
        loadedSkills: [],
        messages: [],
        totalInputTokens: 0,
        totalOutputTokens: 0,
        onActivity: this.onActivity,
        abortRequested: false,
        logPath,
        iterationCount: 0,
      };

      // Store context ref for external abort
      this.activeContext = context;

      // Check for saved progress
      const savedProgress = await loadProgressData();
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

      // Run the agent loop
      const result = await this.runLoop(context);

      // Save the full process log for review
      saveProcessLog(context, result);
      this.activeContext = null;
      // Preserve context for possible continuation
      this.lastContext = context;

      return { ...result, outputName: context.outputName };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.onActivity(`Agent error: ${message}`, 'error');
      // Save log even for crashed/failed runs so they can be reviewed
      if (context) {
        saveProcessLog(context, { success: false, message: `CRASHED: ${message}` });
      }
      this.activeContext = null;
      return { success: false, message };
    }
  }

  /**
   * Continue the conversation from a completed processMeet run.
   * Appends the user's follow-up message and runs the agent loop again.
   */
  async continueConversation(message: string): Promise<{ success: boolean; message: string }> {
    const context = this.lastContext;
    if (!context) {
      return { success: false, message: 'No previous conversation to continue. Process a meet first.' };
    }

    this.onActivity(`Follow-up: ${message}`, 'info');

    try {
      // Append user message to the existing conversation
      context.messages.push({
        role: 'user',
        content: message,
      });
      context.abortRequested = false;
      this.activeContext = context;

      // Run the loop again with the extended conversation
      const result = await this.runLoop(context);

      saveProcessLog(context, result);
      this.activeContext = null;
      this.lastContext = context; // Keep for further continuation

      return result;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.onActivity(`Agent error: ${errMsg}`, 'error');
      this.activeContext = null;
      return { success: false, message: errMsg };
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

      // Truncate old query conversation if it gets too large
      if (this.queryConversation.length > 20) {
        // Keep the last 10 messages to stay within context limits
        this.queryConversation = this.queryConversation.slice(-10);
      }

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
        iterationCount: 0,
      };

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
          const textBlocks = response.content.filter((b): b is import('./llm-client').TextBlock => b.type === 'text');
          answer = textBlocks.map((b) => b.text).join('\n');
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
    const promptPath = path.join(getProjectRoot(), 'skills', 'system-prompt.md');
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
    const iterationBatch = 100;
    let maxIterations = iterationBatch;
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

    // Outer loop allows the user to extend the iteration limit at checkpoints
    // eslint-disable-next-line no-constant-condition
    while (true) {

    while (iterations < maxIterations) {
      iterations++;
      context.iterationCount = iterations;

      // Check if abort was requested
      if (context.abortRequested) {
        this.onActivity('Stop requested by user. Saving progress...', 'warning');
        await this.doAutoSaveProgress(context);
        saveProcessLog(context, { success: true, message: 'Run stopped by user.' });
        return { success: true, message: 'Run stopped by user. Progress has been saved.' };
      }

      // Check context usage: input_tokens from last call reflects the full conversation size.
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
        await this.doAutoSaveProgress(context);
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
        await this.doAutoSaveProgress(context);
        this.onActivity('Progress auto-saved before error return.', 'warning');
        return { success: false, message: `LLM error: ${message}` };
      }

      // Track tokens
      context.totalInputTokens = response.usage.input_tokens;
      context.totalOutputTokens += response.usage.output_tokens;
      console.log(`[AGENT] LLM responded: stop_reason=${response.stop_reason}, in=${response.usage.input_tokens}, out=${response.usage.output_tokens}, blocks=${response.content.length}`);

      // Log any text blocks from the response
      for (const block of response.content) {
        if (block.type === 'text') {
          this.onActivity(block.text, 'info');
        }
      }

      if (response.stop_reason === 'end_turn') {
        const textBlocks = response.content.filter((b): b is import('./llm-client').TextBlock => b.type === 'text');
        const finalMessage = textBlocks.map((b) => b.text).join('\n');
        context.messages.push({ role: 'assistant', content: response.content });

        // Check if the agent described next steps without executing them.
        const lowerText = finalMessage.toLowerCase();
        const planPatterns = /\blet me (now |then )?(run|call|use|execute|extract|generate|regenerate)\b|\bnext.{0,20}(run_python|run_script|scorecat_extract|mso_extract|query_db|--regenerate)\b|\bi'll (now |then )?(run|call|use|execute|extract|generate)\b/.test(lowerText);
        const completionPatterns = /\bdone\b|\bcomplete\b|\bfinished\b|\bno (more|further)\b|\breview\b|\bready\b|\bgenerated\b|\bsuccessfully\b/.test(lowerText);
        if (planPatterns && !completionPatterns && iterations < maxIterations - 1) {
          console.log('[AGENT] Detected unfinished plan in end_turn text — prompting agent to continue.');
          this.onActivity('Continuing — agent described next steps without executing them.', 'info');
          context.messages.push({
            role: 'user',
            content: 'You described next steps but stopped without executing them. Please continue by calling the appropriate tools now. Do not describe what you plan to do — just do it.',
          });
          continue;
        }

        this.onActivity('Agent completed processing.', 'success');
        return { success: true, message: finalMessage || 'Processing complete.' };
      }

      if (response.stop_reason === 'max_tokens') {
        // Response was truncated — add what we got
        context.messages.push({ role: 'assistant', content: response.content });

        // If the truncated response contains tool_use blocks, we must add
        // matching tool_result blocks or the next API call will fail
        const orphanedToolUses = response.content.filter((b): b is import('./llm-client').ToolUseBlock => b.type === 'tool_use');
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

      // Save log incrementally every 5 iterations so incomplete runs can be reviewed
      if (iterations % 5 === 0) {
        saveProcessLog(context, {
          success: false,
          message: `IN PROGRESS — iteration ${iterations}/${maxIterations}`,
        });
      }
    }

    // Iteration limit reached — ask the agent to explain the situation
    this.onActivity(`Reached iteration limit (${maxIterations}) — checking with you...`, 'warning');
    const totalTokens = context.totalInputTokens + context.totalOutputTokens;
    context.messages.push({
      role: 'user',
      content: `You have reached the iteration limit (${maxIterations} iterations). Token usage: ${context.totalInputTokens.toLocaleString()} input + ${context.totalOutputTokens.toLocaleString()} output = ${totalTokens.toLocaleString()} total (context limit: ${this.llmClient.getContextLimit().toLocaleString()}).\n\nYou MUST use the ask_user tool to:\n1. Explain to the user what you have accomplished so far\n2. Explain what you are currently working on and what is taking so many iterations\n3. Ask whether they want you to continue (with ${iterationBatch} more iterations) or stop\n\nProvide your summary as the question text in ask_user, and use these options: ["Continue", "Stop and save progress"]\n\nDo NOT just provide a text summary — you MUST call ask_user so the user can choose.`,
    });

    try {
      const checkpointResponse = await this.llmClient.sendMessage({
        system: buildSystem(),
        messages: context.messages,
        tools,
      });

      context.messages.push({ role: 'assistant', content: checkpointResponse.content });

      // Log any text the agent produced
      for (const block of checkpointResponse.content) {
        if (block.type === 'text') {
          this.onActivity(block.text, 'info');
        }
      }

      // Check if the agent used ask_user as instructed
      const hasToolUse = checkpointResponse.content.some(b => b.type === 'tool_use');

      if (hasToolUse) {
        // Execute the tool calls (which includes ask_user)
        const toolResults = await this.executeToolCalls(checkpointResponse.content, context);
        context.messages.push({ role: 'user', content: toolResults });

        // Check the user's response from ask_user
        const userChoice = toolResults
          .filter((b): b is import('./llm-client').ToolResultBlock => b.type === 'tool_result')
          .map(b => typeof b.content === 'string' ? b.content : '')
          .join('');

        if (userChoice.toLowerCase().includes('continue')) {
          this.onActivity(`Continuing with ${iterationBatch} more iterations...`, 'info');
          maxIterations += iterationBatch;
          continue; // Re-enter the outer while(true) -> inner while loop
        }
      }

      // User chose to stop, or agent didn't use ask_user — save and exit
      await this.doAutoSaveProgress(context);
      const summaryText = checkpointResponse.content
        .filter((b): b is import('./llm-client').TextBlock => b.type === 'text')
        .map(b => b.text)
        .join('\n');
      this.onActivity('Progress saved. Run again to continue where you left off.', 'success');
      return {
        success: false,
        message: summaryText || 'Agent reached iteration limit. Progress has been saved.',
      };
    } catch {
      await this.doAutoSaveProgress(context);
      return { success: false, message: 'Agent reached iteration limit. Progress has been saved.' };
    }

    } // end outer while(true)
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
        .filter((b): b is import('./llm-client').ToolUseBlock => b.type === 'tool_use')
        .map(b => b.id);

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
          nextMsg.content
            .filter((b): b is import('./llm-client').ToolResultBlock => b.type === 'tool_result')
            .map(b => b.tool_use_id)
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
    const toolCalls = content.filter((b): b is import('./llm-client').ToolUseBlock => b.type === 'tool_use');
    const results: ContentBlock[] = [];

    for (const call of toolCalls) {
      const toolName = call.name;
      const toolArgs = call.input;
      const toolId = call.id;

      // Save log before ask_user since the run will block waiting for user input
      if (toolName === 'ask_user' && context.logPath) {
        saveProcessLog(context, {
          success: false,
          message: `IN PROGRESS — waiting for user response (iteration ${context.iterationCount})`,
        });
      }

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
    switch (name) {
      case 'run_python':
        return toolRunPython(
          context.outputName || context.meetName,
          requireString(args, 'args'),
          context,
          this.onActivity
        );

      case 'set_output_name':
        context.outputName = requireString(args, 'name');
        return `Output folder name set to: "${context.outputName}"`;

      case 'render_pdf_page':
        return toolRenderPdfPage(
          optionalString(args, 'pdf_path'),
          args.page_number as number | undefined,
          context.outputName || context.meetName
        );

      case 'open_file':
        return toolOpenFile(
          requireString(args, 'file_path'),
          context.outputName || context.meetName
        );

      case 'list_output_files':
        return toolListOutputFiles(optionalString(args, 'meet_name') || context.outputName || context.meetName);

      case 'list_skills':
        return toolListSkills();

      case 'load_skill':
        return toolLoadSkill(requireString(args, 'skill_name'), context);

      case 'load_skill_detail':
        return toolLoadSkillDetail(requireString(args, 'detail_name'), context);

      case 'save_draft_skill':
        return toolSaveDraftSkill(requireString(args, 'platform_name'), requireString(args, 'content'));

      case 'save_progress':
        return toolSaveProgress(context, requireString(args, 'summary'), requireString(args, 'next_steps'), optionalString(args, 'data_files'));

      case 'load_progress':
        return toolLoadProgress();

      default:
        return `Error: Unknown tool "${name}"`;
    }
  }

  /**
   * Auto-save progress using extracted summary/next-steps from conversation.
   */
  private async doAutoSaveProgress(context: AgentContext): Promise<void> {
    const summary = extractProgressSummary(context);
    const nextSteps = extractNextSteps(context);
    await autoSaveProgress(context, summary, nextSteps);
  }
}
