/**
 * Gym tools — Perplexity-powered gym lookup for verification and address enrichment.
 *
 * Two modes:
 *   - verify: Check if two gym names refer to the same gym
 *   - enrich: Look up addresses for a list of gyms
 */

import { fetchWithRetry } from './retry';
import { requireString } from './validation';
import { configStore } from '../config-store';

interface PerplexityResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

/** Run async tasks with bounded concurrency. */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

export const gymToolExecutors: Record<string, (args: Record<string, unknown>) => Promise<string>> = {
  perplexity_gym_lookup: async (args) => {
    const mode = requireString(args, 'mode');
    const state = requireString(args, 'state');

    const pplxKey = configStore.get('perplexityApiKey');
    if (!pplxKey) {
      return 'Error: Perplexity API key not configured. Add it in Settings.';
    }

    const prompts: { label: string; content: string }[] = [];

    if (mode === 'verify') {
      // Parse pairs — handle both JSON string and array from LLM
      let pairs: Array<{ gym_a: string; gym_b: string }>;
      try {
        const rawPairs = args.pairs;
        const parsed = typeof rawPairs === 'string' ? JSON.parse(rawPairs) : rawPairs;
        if (!Array.isArray(parsed)) {
          return 'Error: pairs must be a JSON array of {gym_a, gym_b} objects.';
        }
        pairs = parsed;
      } catch {
        return 'Error: pairs must be a valid JSON array of {gym_a, gym_b} objects.';
      }
      if (pairs.length === 0) {
        return 'Error: verify mode requires a non-empty "pairs" array.';
      }

      for (const pair of pairs) {
        if (!pair.gym_a || !pair.gym_b) {
          return 'Error: each pair must have "gym_a" and "gym_b" string fields.';
        }
        prompts.push({
          label: `${pair.gym_a} vs ${pair.gym_b}`,
          content: `Are "${pair.gym_a}" and "${pair.gym_b}" the same gymnastics gym in ${state}? ` +
            `Answer with: YES or NO, then the official/full gym name, city, and street address if you can find it. Be concise.`,
        });
      }
    } else if (mode === 'enrich') {
      // Parse gyms — handle both JSON string and array from LLM
      let gyms: string[];
      try {
        const rawGyms = args.gyms;
        const parsed = typeof rawGyms === 'string' ? JSON.parse(rawGyms) : rawGyms;
        if (!Array.isArray(parsed)) {
          return 'Error: gyms must be an array of gym name strings.';
        }
        gyms = parsed;
      } catch {
        return 'Error: gyms must be a valid array of gym name strings.';
      }
      if (gyms.length === 0) {
        return 'Error: enrich mode requires a non-empty "gyms" array.';
      }

      // Batch gyms into groups of 10 for efficiency
      for (let i = 0; i < gyms.length; i += 10) {
        const batch = gyms.slice(i, i + 10);
        const gymList = batch.map((g, idx) => `${idx + 1}. ${g}`).join('\n');
        prompts.push({
          label: `Batch ${Math.floor(i / 10) + 1}`,
          content: `For each gymnastics gym below in ${state}, provide the official name, city, and street address. ` +
            `If you cannot find a gym, say "NOT FOUND". Be concise, one line per gym.\n\n${gymList}`,
        });
      }
    } else {
      return `Error: Invalid mode "${mode}". Use "verify" or "enrich".`;
    }

    // Execute with bounded concurrency (max 5 parallel Perplexity calls)
    const results = await mapWithConcurrency(prompts, 5, async (p) => {
      try {
        const resp = await fetchWithRetry('https://api.perplexity.ai/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${pplxKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'sonar',
            messages: [{ role: 'user', content: p.content }],
          }),
        });
        const data: PerplexityResponse = await resp.json();
        const answer = data?.choices?.[0]?.message?.content || 'No response';
        return `[${p.label}]\n${answer}`;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return `[${p.label}]\nError: ${msg}`;
      }
    });

    return results.join('\n\n---\n\n');
  },
};
