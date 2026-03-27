/**
 * Query engine for the Query Results tab.
 *
 * Uses MiniMax M2.7 with native tool calling (same pattern as the rest of the app).
 * Tools cover common query patterns as dedicated endpoints + a general SQL fallback.
 * All queries hit Supabase PostgreSQL.
 */
import { getSupabaseClient } from './supabase-client';
import { configStore } from './config-store';

// --- Tool Definitions ---

const QUERY_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'get_event_winners',
      description: 'Get winners for a specific event, level, and state. Use for questions about who won, best scores, top athletes, champions.',
      parameters: {
        type: 'object',
        properties: {
          state: { type: 'string', description: '2-letter state abbreviation (KY, MN, OR, etc.)' },
          year: { type: 'string', description: 'Year (default 2026)', default: '2026' },
          level: { type: 'string', description: 'Level: 2-10 for numbered, XD/XSA/XP/XG/XS/XB for Xcel (Gold=XG, Silver=XS, etc.). Null for all levels.' },
          event: { type: 'string', enum: ['vault', 'bars', 'beam', 'floor', 'aa'], description: 'Event name. aa = all-around. Null for all events.' },
        },
        required: ['state'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_meet_info',
      description: 'Get meet summary info: athlete count, winner count, dates. Use for questions about meets, how many athletes, statistics.',
      parameters: {
        type: 'object',
        properties: {
          state: { type: 'string', description: '2-letter state abbreviation. Null for all meets.' },
          year: { type: 'string', description: 'Year (default 2026)', default: '2026' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'search_athlete',
      description: 'Search for an athlete by name. Returns their scores across all events.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Athlete name (partial match supported)' },
          state: { type: 'string', description: '2-letter state abbreviation to narrow search' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_gym_athletes',
      description: 'Get all athletes and winners from a specific gym/team/club.',
      parameters: {
        type: 'object',
        properties: {
          gym: { type: 'string', description: 'Gym name (partial match supported)' },
          state: { type: 'string', description: '2-letter state abbreviation' },
        },
        required: ['gym'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'run_sql',
      description: 'Run a custom SQL query for complex questions that other tools cannot handle. Only SELECT queries allowed.',
      parameters: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'PostgreSQL SELECT query. Use public.winners, public.results, public.meets (fully qualified). Filter state via JOIN with public.meets (meets.state has 2-letter codes, winners/results.state has full names). No semicolons.' },
        },
        required: ['sql'],
      },
    },
  },
];

const SYSTEM_PROMPT = `You are a gymnastics results assistant. Answer questions about meet results using the available tools.

Available meets: KY, LA, MN, NE, OR, WI (all 2026 USAG Women's Gymnastics).

Level mappings: Gold=XG, Silver=XS, Bronze=XB, Diamond=XD, Sapphire=XSA, Platinum=XP. Numbered levels: 2-10.
Events: vault, bars, beam, floor, aa (all-around).

Rules:
- Use get_event_winners for who won / best score / champion questions.
- Use get_meet_info for meet statistics / how many athletes.
- Use search_athlete to look up a specific person.
- Use get_gym_athletes to look up a gym/team/club.
- Use run_sql only when other tools can't answer the question.
- Answer concisely and professionally. No emojis.
- Mention ties when they exist. Say "no ties" when asked and there aren't any.
- For multi-part questions, call multiple tools.`;

// --- Tool Executors ---

async function executeTool(name: string, args: Record<string, any>): Promise<string> {
  const supabase = await getSupabaseClient();
  if (!supabase) return JSON.stringify({ error: 'Database not available' });

  try {
    switch (name) {
      case 'get_event_winners': {
        const { data, error } = await supabase.rpc('get_event_winners', {
          p_state: args.state || null,
          p_year: args.year || '2026',
          p_level: args.level || null,
          p_event: args.event || null,
        });
        if (error) return JSON.stringify({ error: error.message });
        return JSON.stringify(data || []);
      }
      case 'get_meet_info': {
        const { data, error } = await supabase.rpc('get_meet_summary', {
          p_state: args.state || null,
          p_year: args.year || null,
        });
        if (error) return JSON.stringify({ error: error.message });
        return JSON.stringify(data || []);
      }
      case 'search_athlete': {
        const { data, error } = await supabase.rpc('search_athletes', {
          p_name: args.name,
          p_state: args.state || null,
          p_year: args.year || '2026',
        });
        if (error) return JSON.stringify({ error: error.message });
        return JSON.stringify(data || []);
      }
      case 'get_gym_athletes': {
        const { data, error } = await supabase.rpc('get_gym_results', {
          p_gym: args.gym,
          p_state: args.state || null,
          p_year: args.year || '2026',
        });
        if (error) return JSON.stringify({ error: error.message });
        return JSON.stringify(data || []);
      }
      case 'run_sql': {
        let sql = (args.sql || '').replace(/;\s*$/, '').trim();
        if (!/^select/i.test(sql)) return JSON.stringify({ error: 'Only SELECT queries allowed' });
        const { data, error } = await supabase.rpc('exec_query', { p_sql: sql });
        if (error) return JSON.stringify({ error: error.message });
        return JSON.stringify(data || []);
      }
      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
  }
}

// --- Conversation + Tool Loop ---

interface Message {
  role: string;
  content?: string;
  tool_calls?: any[];
  tool_call_id?: string;
  name?: string;
}

const conversation: Message[] = [];

async function processQuestion(question: string): Promise<string> {
  const apiKey = configStore.get('apiKey');
  if (!apiKey) return 'No API key configured. Set an OpenRouter API key in Settings.';

  conversation.push({ role: 'user', content: question });

  // Trim conversation to prevent token overflow
  while (conversation.length > 16) conversation.shift();

  let iterations = 0;
  const maxIterations = 5;

  while (iterations < maxIterations) {
    iterations++;

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'minimax/minimax-m2.7',
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...conversation],
        tools: QUERY_TOOLS,
        temperature: 0.1,
        max_tokens: 600,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return `Model error (${response.status}): ${errText.slice(0, 200)}`;
    }

    const data = await response.json() as any;
    const choice = data.choices?.[0];
    if (!choice) return 'No response from model.';

    const message = choice.message;

    // If model wants to call tools
    if (message.tool_calls && message.tool_calls.length > 0) {
      conversation.push(message);

      // Execute all tool calls in parallel
      const toolResults = await Promise.all(
        message.tool_calls.map(async (tc: any) => {
          const args = typeof tc.function.arguments === 'string'
            ? JSON.parse(tc.function.arguments)
            : tc.function.arguments;
          const result = await executeTool(tc.function.name, args);
          return {
            role: 'tool' as const,
            tool_call_id: tc.id,
            content: result,
          };
        })
      );

      conversation.push(...toolResults);
      continue; // Let model process the results
    }

    // Model is done — has a text response
    const answer = message.content?.trim() || 'No answer generated.';
    conversation.push({ role: 'assistant', content: answer });
    return answer;
  }

  return 'Query took too many steps. Try a simpler question.';
}

// --- Public API ---

export async function answerQuery(question: string): Promise<string> {
  return processQuestion(question);
}

export function clearQueryHistory(): void {
  conversation.length = 0;
}
