/**
 * Process logging utilities extracted from AgentLoop.
 * Handles saving conversation logs and extracting progress summaries.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ContentBlock, LLMMessage, ToolResultContent, TextContentPart } from './llm-client';
import { AgentContext } from './context-tools';
import { getDataDir, getOutputDir } from './paths';

/** Extract the text portion of a tool result content (ignoring images). */
export function toolResultText(content: ToolResultContent | undefined): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  return content.filter((p): p is TextContentPart => p.type === 'text').map(p => p.text).join('\n');
}

/**
 * Save the process log as a readable markdown file.
 * Uses the stable logPath from context so incremental saves overwrite the same file.
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

    const lines: string[] = [];
    lines.push(`# Process Log: ${context.meetName}`);
    lines.push(`**Date**: ${new Date().toISOString()}`);
    lines.push(`**Status**: ${isFinal ? (result.success ? 'SUCCESS' : 'FAILED') : 'IN PROGRESS'} — ${result.message}`);
    lines.push(`**Iterations**: ${context.iterationCount}`);
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

    fs.writeFileSync(logPath, lines.join('\n'), 'utf-8');

    // Only copy to the output folder on final saves
    if (isFinal) {
      const outputName = context.outputName || context.meetName;
      const outputDir = getOutputDir(outputName, false);
      if (fs.existsSync(outputDir)) {
        try {
          const outputLogPath = path.join(outputDir, 'process_log.md');
          fs.writeFileSync(outputLogPath, lines.join('\n'), 'utf-8');
        } catch {
          // Non-critical — just skip
        }
      }
      context.onActivity(`Process log saved: ${logPath}`, 'info');
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
