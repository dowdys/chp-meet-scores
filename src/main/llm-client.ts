/**
 * LLM Client - Provider abstraction for Anthropic, OpenRouter, and Claude Subscription APIs.
 * Uses Node.js built-in fetch (Node 18+).
 */

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

// --- Shared types ---

export interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
}

export interface LLMMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, { type: string; description: string; items?: { type: string }; enum?: string[] }>;
    required?: string[];
  };
}

export interface LLMResponse {
  content: ContentBlock[];
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens';
  usage: { input_tokens: number; output_tokens: number };
  model: string;
}

export interface LLMClientConfig {
  provider: 'anthropic' | 'openrouter' | 'subscription';
  apiKey: string;
  model: string;
}

// --- Custom error types for retry logic ---

export class RateLimitError extends Error {
  retryAfterMs: number;
  constructor(retryAfterMs: number, message?: string) {
    super(message || `Rate limited. Retry after ${retryAfterMs}ms`);
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class ApiError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
  }
}

// --- Claude Subscription OAuth token reader ---

interface ClaudeCredentials {
  claudeAiOauth?: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scopes: string[];
    subscriptionType: string;
  };
}

function getClaudeCredentialsPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || app.getPath('home');
  return path.join(home, '.claude', '.credentials.json');
}

function readClaudeOAuthToken(): { token: string; expiresAt: number } {
  const credPath = getClaudeCredentialsPath();
  if (!fs.existsSync(credPath)) {
    throw new Error(
      `Claude Code credentials not found at ${credPath}. ` +
      'Make sure Claude Code is installed and you are logged in.'
    );
  }

  const raw = fs.readFileSync(credPath, 'utf-8');
  const creds = JSON.parse(raw) as ClaudeCredentials;

  if (!creds.claudeAiOauth?.accessToken) {
    throw new Error(
      'No OAuth token found in Claude Code credentials. ' +
      'Make sure you are logged into Claude Code with your subscription.'
    );
  }

  const now = Date.now();
  if (creds.claudeAiOauth.expiresAt && creds.claudeAiOauth.expiresAt < now) {
    throw new Error(
      'Claude Code OAuth token has expired. ' +
      'Please run any Claude Code command to refresh it, then try again.'
    );
  }

  return {
    token: creds.claudeAiOauth.accessToken,
    expiresAt: creds.claudeAiOauth.expiresAt,
  };
}

// --- Model context limits ---

const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  'claude-opus-4-6': 200000,
  'claude-sonnet-4-6': 200000,
  'claude-sonnet-4-5-20241022': 200000,
  'claude-haiku-4-5-20251001': 200000,
};

const DEFAULT_CONTEXT_LIMIT = 128000;

// --- Anthropic API types ---

interface AnthropicResponseBody {
  id: string;
  type: string;
  role: string;
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
}

interface AnthropicContentBlock {
  type: 'text' | 'tool_use';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

// --- OpenRouter / OpenAI API types ---

interface OpenRouterResponseBody {
  id: string;
  choices: OpenRouterChoice[];
  model: string;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

interface OpenRouterChoice {
  index: number;
  message: {
    role: string;
    content: string | null;
    tool_calls?: OpenRouterToolCall[];
  };
  finish_reason: string;
}

interface OpenRouterToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenRouterModelEntry {
  id: string;
}

interface OpenRouterModelsResponse {
  data: OpenRouterModelEntry[];
}

// --- LLM Client ---

export class LLMClient {
  private config: LLMClientConfig;

  constructor(config: LLMClientConfig) {
    this.config = config;
  }

  /**
   * Send a message to the LLM and return the response.
   * Retries up to 3 times on transient network errors (fetch failed, timeouts).
   */
  async sendMessage(options: {
    system: string;
    messages: LLMMessage[];
    tools: ToolDefinition[];
  }): Promise<LLMResponse> {
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (this.config.provider === 'anthropic') {
          return await this.sendAnthropic(options);
        } else if (this.config.provider === 'subscription') {
          return await this.sendSubscription(options);
        } else {
          return await this.sendOpenRouter(options);
        }
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // Rate limit: use retry-after header timing instead of exponential backoff
        if (err instanceof RateLimitError) {
          if (attempt === maxRetries) throw err;
          console.log(`[LLM] Rate limited, waiting ${err.retryAfterMs}ms before retry ${attempt}/${maxRetries}`);
          await new Promise(resolve => setTimeout(resolve, err.retryAfterMs));
          continue;
        }

        const msg = lastError.message.toLowerCase();
        // Only retry on transient network/server errors, not auth/validation errors
        const isTransient = msg.includes('fetch failed') ||
          msg.includes('econnreset') ||
          msg.includes('etimedout') ||
          msg.includes('socket hang up') ||
          msg.includes('network') ||
          msg.includes('api error (500)') ||
          msg.includes('api error (502)') ||
          msg.includes('api error (520)') ||
          msg.includes('api error (529)');

        if (!isTransient || attempt === maxRetries) {
          throw lastError;
        }
        // Exponential backoff: 2s, 4s, 8s
        const delay = Math.pow(2, attempt) * 1000;
        console.log(`[LLM] Transient error, retrying in ${delay}ms (attempt ${attempt}/${maxRetries}): ${msg.substring(0, 100)}`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    throw lastError!;
  }

  /**
   * Check if a model is available.
   * Anthropic: check against known model list.
   * OpenRouter: query their models API.
   */
  async checkModelAvailability(model: string): Promise<boolean> {
    if (this.config.provider === 'anthropic' || this.config.provider === 'subscription') {
      const knownModels = [
        'claude-opus-4-6',
        'claude-sonnet-4-6',
        'claude-sonnet-4-5-20241022',
        'claude-haiku-4-5-20251001',
      ];
      return knownModels.includes(model);
    }

    // OpenRouter: query their models endpoint
    try {
      const response = await fetch('https://openrouter.ai/api/v1/models', {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
        },
      });

      if (!response.ok) {
        return false;
      }

      const body = await response.json() as OpenRouterModelsResponse;
      return body.data.some((m) => m.id === model);
    } catch {
      return false;
    }
  }

  /**
   * Get context window size for the current model.
   */
  getContextLimit(): number {
    return MODEL_CONTEXT_LIMITS[this.config.model] ?? DEFAULT_CONTEXT_LIMIT;
  }

  // --- Anthropic implementation ---

  private async sendAnthropic(options: {
    system: string;
    messages: LLMMessage[];
    tools: ToolDefinition[];
  }): Promise<LLMResponse> {
    const body = {
      model: this.config.model,
      max_tokens: 4096,
      system: options.system,
      messages: options.messages,
      tools: options.tools.length > 0 ? options.tools : undefined,
    };

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': this.config.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      if (response.status === 429) {
        const retryAfter = response.headers.get('retry-after');
        const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 30000;
        throw new RateLimitError(waitMs);
      }
      const errorText = await response.text();
      throw new ApiError(response.status, `Anthropic API error (${response.status}): ${errorText}`);
    }

    const data = await response.json() as AnthropicResponseBody;

    // Anthropic response maps directly to our format
    const content: ContentBlock[] = data.content.map((block) => {
      if (block.type === 'text') {
        return { type: 'text' as const, text: block.text };
      } else {
        return {
          type: 'tool_use' as const,
          id: block.id,
          name: block.name,
          input: block.input,
        };
      }
    });

    return {
      content,
      stop_reason: data.stop_reason as LLMResponse['stop_reason'],
      usage: data.usage,
      model: data.model,
    };
  }

  // --- Subscription implementation (uses Claude Code OAuth token) ---

  private async sendSubscription(options: {
    system: string;
    messages: LLMMessage[];
    tools: ToolDefinition[];
  }): Promise<LLMResponse> {
    // Read the OAuth token fresh each time (in case it was refreshed by Claude Code)
    const { token } = readClaudeOAuthToken();

    const body = {
      model: this.config.model,
      max_tokens: 4096,
      system: options.system,
      messages: options.messages,
      tools: options.tools.length > 0 ? options.tools : undefined,
    };

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      if (response.status === 429) {
        const retryAfter = response.headers.get('retry-after');
        const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 30000;
        throw new RateLimitError(waitMs);
      }
      const errorText = await response.text();
      if (response.status === 401) {
        throw new ApiError(401,
          'OAuth token rejected. Your Claude Code token may have expired. ' +
          'Run any Claude Code command to refresh it, then try again.'
        );
      }
      throw new ApiError(response.status, `Anthropic API error (${response.status}): ${errorText}`);
    }

    const data = await response.json() as AnthropicResponseBody;

    const content: ContentBlock[] = data.content.map((block) => {
      if (block.type === 'text') {
        return { type: 'text' as const, text: block.text };
      } else {
        return {
          type: 'tool_use' as const,
          id: block.id,
          name: block.name,
          input: block.input,
        };
      }
    });

    return {
      content,
      stop_reason: data.stop_reason as LLMResponse['stop_reason'],
      usage: data.usage,
      model: data.model,
    };
  }

  // --- OpenRouter implementation ---

  private async sendOpenRouter(options: {
    system: string;
    messages: LLMMessage[];
    tools: ToolDefinition[];
  }): Promise<LLMResponse> {
    // Convert Anthropic-format messages to OpenAI format
    const openaiMessages = this.convertMessagesToOpenAI(options.system, options.messages);

    // Convert tool definitions to OpenAI format
    const openaiTools = options.tools.length > 0
      ? options.tools.map((tool) => ({
          type: 'function' as const,
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.input_schema,
          },
        }))
      : undefined;

    const body = {
      model: this.config.model,
      messages: openaiMessages,
      tools: openaiTools,
      max_tokens: 4096,
    };

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
        'HTTP-Referer': 'https://github.com/dowdys/chp-meet-scores',
        'X-Title': 'Gymnastics Meet Scores',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenRouter API error (${response.status}): ${errorText}`);
    }

    const data = await response.json() as OpenRouterResponseBody;
    return this.convertOpenRouterResponse(data);
  }

  /**
   * Convert our LLMMessage[] to OpenAI-format messages.
   * Handles ContentBlock arrays (tool_use / tool_result) by splitting into
   * the appropriate OpenAI message types.
   */
  private convertMessagesToOpenAI(
    system: string,
    messages: LLMMessage[]
  ): Record<string, unknown>[] {
    const result: Record<string, unknown>[] = [
      { role: 'system', content: system },
    ];

    for (const msg of messages) {
      if (typeof msg.content === 'string') {
        result.push({ role: msg.role, content: msg.content });
        continue;
      }

      // ContentBlock array — need to split into OpenAI message types
      if (msg.role === 'assistant') {
        // Assistant message with possible tool_use blocks
        const textParts: string[] = [];
        const toolCalls: { id: string; type: 'function'; function: { name: string; arguments: string } }[] = [];

        for (const block of msg.content) {
          if (block.type === 'text' && block.text) {
            textParts.push(block.text);
          } else if (block.type === 'tool_use') {
            toolCalls.push({
              id: block.id!,
              type: 'function',
              function: {
                name: block.name!,
                arguments: JSON.stringify(block.input ?? {}),
              },
            });
          }
        }

        const assistantMsg: Record<string, unknown> = {
          role: 'assistant',
          content: textParts.length > 0 ? textParts.join('\n') : null,
        };
        if (toolCalls.length > 0) {
          assistantMsg.tool_calls = toolCalls;
        }
        result.push(assistantMsg);
      } else {
        // User message with possible tool_result blocks
        // In OpenAI format, tool results are separate "tool" role messages
        const textParts: string[] = [];

        for (const block of msg.content) {
          if (block.type === 'text' && block.text) {
            textParts.push(block.text);
          } else if (block.type === 'tool_result') {
            result.push({
              role: 'tool',
              tool_call_id: block.tool_use_id,
              content: block.content ?? '',
            });
          }
        }

        // If there are also text parts, add them as a user message
        if (textParts.length > 0) {
          result.push({ role: 'user', content: textParts.join('\n') });
        }
      }
    }

    return result;
  }

  /**
   * Convert OpenRouter (OpenAI-format) response to our LLMResponse.
   */
  private convertOpenRouterResponse(data: OpenRouterResponseBody): LLMResponse {
    const choice = data.choices[0];
    if (!choice) {
      throw new Error('OpenRouter returned no choices');
    }

    const content: ContentBlock[] = [];

    // Add text content if present
    if (choice.message.content) {
      content.push({ type: 'text', text: choice.message.content });
    }

    // Convert tool_calls to our tool_use format
    if (choice.message.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        let parsedArgs: Record<string, unknown> = {};
        try {
          parsedArgs = JSON.parse(tc.function.arguments);
        } catch {
          parsedArgs = { _raw: tc.function.arguments };
        }

        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: parsedArgs,
        });
      }
    }

    // Map finish_reason to our stop_reason
    let stop_reason: LLMResponse['stop_reason'] = 'end_turn';
    if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'function_call') {
      stop_reason = 'tool_use';
    } else if (choice.finish_reason === 'length') {
      stop_reason = 'max_tokens';
    }
    // Also detect tool_use if tool_calls are present regardless of finish_reason
    if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
      stop_reason = 'tool_use';
    }

    return {
      content,
      stop_reason,
      usage: {
        input_tokens: data.usage?.prompt_tokens ?? 0,
        output_tokens: data.usage?.completion_tokens ?? 0,
      },
      model: data.model,
    };
  }
}
