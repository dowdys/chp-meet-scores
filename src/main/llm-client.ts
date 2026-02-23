/**
 * LLM Client - Provider abstraction for Anthropic and OpenRouter APIs.
 * Uses Node.js built-in fetch (Node 18+).
 */

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
    properties: Record<string, { type: string; description: string }>;
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
  provider: 'anthropic' | 'openrouter';
  apiKey: string;
  model: string;
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
   */
  async sendMessage(options: {
    system: string;
    messages: LLMMessage[];
    tools: ToolDefinition[];
  }): Promise<LLMResponse> {
    if (this.config.provider === 'anthropic') {
      return this.sendAnthropic(options);
    } else {
      return this.sendOpenRouter(options);
    }
  }

  /**
   * Check if a model is available.
   * Anthropic: check against known model list.
   * OpenRouter: query their models API.
   */
  async checkModelAvailability(model: string): Promise<boolean> {
    if (this.config.provider === 'anthropic') {
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
      const errorText = await response.text();
      throw new Error(`Anthropic API error (${response.status}): ${errorText}`);
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
