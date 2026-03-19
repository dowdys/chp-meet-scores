/**
 * Process logging utilities extracted from AgentLoop.
 * Handles saving conversation logs and extracting progress summaries.
 *
 * Performance: incremental (IN PROGRESS) saves are append-only — only new
 * messages since the last save are written.  The header is written once on the
 * first save.  Final saves rewrite the whole file so the header reflects the
 * final status, token counts, etc.
 */

import * as fs from 'fs';
import * as path from 'path';
import { LLMMessage, ToolResultContent, TextContentPart } from './llm-client';
import { AgentContext } from './context-tools';
import { getDataDir, getOutputDir } from './paths';

/** Extract the text portion of a tool result content (ignoring images). */
export function toolResultText(content: ToolResultContent | undefined): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  return content.filter((p): p is TextContentPart => p.type === 'text').map(p => p.text).join('\n');
}

/**
 * Format the markdown header block that appears at the top of the process log.
 */
function formatHeader(context: AgentContext, isFinal: boolean, statusMessage: string, success: boolean): string {
  const lines: string[] = [];
  lines.push(`# Process Log: ${context.meetName}`);
  lines.push(`**Date**: ${new Date().toISOString()}`);
  lines.push(`**Status**: ${isFinal ? (success ? 'SUCCESS' : 'FAILED') : 'IN PROGRESS'} — ${statusMessage}`);
  lines.push(`**Iterations**: ${context.iterationCount}`);
  lines.push(`**Tokens**: ${context.totalInputTokens.toLocaleString()} input, ${context.totalOutputTokens.toLocaleString()} output`);
  lines.push(`**Skills loaded**: ${context.loadedSkills.join(', ') || 'none'}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  return lines.join('\n');
}

/**
 * Format a slice of messages into markdown lines.
 * iterationOffset is the iteration number to start counting from for
 * assistant text blocks, and returns the updated iteration counter.
 */
function formatMessages(
  messages: LLMMessage[],
  iterationOffset: number
): { text: string; nextIteration: number } {
  const lines: string[] = [];
  let iterationNum = iterationOffset;

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      lines.push(`## ${msg.role === 'user' ? 'User' : 'Agent'}`);
      lines.push('');
      lines.push(msg.content);
      lines.push('');
      continue;
    }

    // ContentBlock array
    for (const block of msg.content) {
      if (block.type === 'text') {
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
        const content = toolResultText(block.content);
        lines.push(content.length > 3000 ? content.substring(0, 3000) + '\n... (truncated)' : content);
        lines.push('```');
        lines.push('');
      }
    }
  }

  return { text: lines.join('\n'), nextIteration: iterationNum };
}

/**
 * Count assistant text blocks in a message slice to compute iteration offsets.
 */
function countIterations(messages: LLMMessage[]): number {
  let count = 0;
  for (const msg of messages) {
    if (typeof msg.content === 'string') continue;
    for (const block of msg.content) {
      if (block.type === 'text' && msg.role === 'assistant') {
        count++;
      }
    }
  }
  return count;
}

/**
 * Save the process log as a readable markdown file.
 *
 * Incremental (IN PROGRESS) saves are append-only: the header is written on
 * the first call, and subsequent calls only append messages added since the
 * previous save.  Final saves rewrite the entire file so the header reflects
 * the final status, iteration count, and token totals.
 */
export function saveProcessLog(
  context: AgentContext,
  result: { success: boolean; message: string }
): void {
  try {
    let logPath = context.logPath;
    if (!logPath) {
      const logsDir = path.join(getDataDir(), 'logs');
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
      }
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
      const safeName = context.meetName.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
      logPath = path.join(logsDir, `${safeName}_${timestamp}.md`);
      context.logPath = logPath;
    }

    const isFinal = !result.message.startsWith('IN PROGRESS');
    const lastIdx = context.lastLoggedMessageIndex ?? 0;
    const isFirstSave = lastIdx === 0;

    if (isFinal) {
      // Final save: rewrite entire file so header has correct status/tokens.
      const header = formatHeader(context, true, result.message, result.success);
      const { text: body } = formatMessages(context.messages, 0);
      const fullContent = header + body;

      fs.writeFileSync(logPath, fullContent, 'utf-8');
      context.lastLoggedMessageIndex = context.messages.length;

      // Copy to the output folder on final saves
      const outputName = context.outputName || context.meetName;
      const outputDir = getOutputDir(outputName, false);
      if (fs.existsSync(outputDir)) {
        try {
          const outputLogPath = path.join(outputDir, 'process_log.md');
          fs.writeFileSync(outputLogPath, fullContent, 'utf-8');
        } catch {
          // Non-critical — just skip
        }
      }
      context.onActivity(`Process log saved: ${logPath}`, 'info');
    } else if (isFirstSave) {
      // First incremental save: write header + all messages so far.
      const header = formatHeader(context, false, result.message, result.success);
      const { text: body } = formatMessages(context.messages, 0);
      fs.writeFileSync(logPath, header + body, 'utf-8');
      context.lastLoggedMessageIndex = context.messages.length;
    } else {
      // Subsequent incremental save: append only new messages.
      const newMessages = context.messages.slice(lastIdx);
      if (newMessages.length > 0) {
        const iterationOffset = countIterations(context.messages.slice(0, lastIdx));
        const { text: body } = formatMessages(newMessages, iterationOffset);
        fs.appendFileSync(logPath, body, 'utf-8');
      }
      context.lastLoggedMessageIndex = context.messages.length;
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    context.onActivity(`Warning: Could not save process log: ${errMsg}`, 'warning');
  }
}

/**
 * Extract a meaningful summary from the conversation messages.
 * Focuses on tool results and agent reasoning from the last several turns.
 */
export function extractProgressSummary(context: AgentContext): string {
  const parts: string[] = [];

  for (const msg of context.messages) {
    if (typeof msg.content === 'string') continue;

    for (const block of msg.content) {
      if (block.type === 'text' && msg.role === 'assistant') {
        parts.push(`Agent: ${block.text.substring(0, 300)}`);
      }
      if (block.type === 'tool_use') {
        const argsPreview = block.input ? JSON.stringify(block.input).substring(0, 100) : '';
        parts.push(`Called ${block.name}(${argsPreview})`);
      }
      if (block.type === 'tool_result') {
        const preview = toolResultText(block.content).substring(0, 200);
        parts.push(`  -> ${preview}`);
      }
    }
  }

  // Keep the last ~2000 chars of context
  const combined = parts.join('\n');
  if (combined.length > 2000) {
    return '...\n' + combined.substring(combined.length - 2000);
  }
  return combined || 'Auto-saved with no meaningful progress captured.';
}

/**
 * Extract next steps by looking at the agent's last text message.
 */
export function extractNextSteps(context: AgentContext): string {
  for (let i = context.messages.length - 1; i >= 0; i--) {
    const msg = context.messages[i];
    if (msg.role !== 'assistant' || typeof msg.content === 'string') continue;

    for (const block of msg.content) {
      if (block.type === 'text') {
        return `Continue from agent's last action: ${block.text.substring(0, 500)}`;
      }
    }
  }
  return 'Resume processing from the beginning of the current step.';
}
