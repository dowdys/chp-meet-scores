import { chromeController } from '../chrome-controller';
import * as fs from 'fs';
import * as path from 'path';
import { getDataDir } from '../paths';
import { requireString, optionalString } from './validation';

export const searchToolExecutors: Record<string, (args: Record<string, unknown>) => Promise<string>> = {
  search_meets: async (args) => {
    const query = requireString(args, 'query');
    const stateFilter = optionalString(args, 'state')?.toLowerCase();
    const results: Array<{name: string, id: string, source: string, state: string, program: string, date: string}> = [];

    // 1. Search Algolia (ScoreCat)
    try {
      const algoliaResp = await fetch('https://2r102d471d.algolia.net/1/indexes/ff_meets/query', {
        method: 'POST',
        headers: {
          'x-algolia-application-id': '2R102D471D',
          'x-algolia-api-key': 'f6c6022306eb2dace46c6490e7ae9984',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query }),
      });
      const algoliaData = await algoliaResp.json() as { hits?: Array<Record<string, unknown>> };
      for (const hit of algoliaData.hits || []) {
        if (stateFilter && (hit.state as string | undefined)?.toLowerCase() !== stateFilter) continue;
        const startDate = hit.startDate ? new Date(hit.startDate as number).toISOString().split('T')[0] : 'unknown';
        results.push({
          name: hit.name as string,
          id: (hit.meet_id || hit.objectID) as string,
          source: 'scorecat',
          state: (hit.state as string) || '',
          program: (hit.program as string) || 'unknown',
          date: startDate,
        });
      }
    } catch (e) {
      // Algolia failed, continue with MSO
    }

    // 2. Search MSO Results.All
    try {
      const msoResp = await fetch('https://www.meetscoresonline.com/Results.All', {
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      const html = await msoResp.text();
      // Parse meet-container divs: data-meetid, data-state, data-filter-by
      const regex = /data-meetid="(\d+)"\s+data-state="([^"]+)"\s+data-filter-by="([^"]+)"/g;
      let match;
      const queryLower = query.toLowerCase();
      while ((match = regex.exec(html)) !== null) {
        const [, meetId, state, filterBy] = match;
        if (stateFilter && state.toLowerCase() !== stateFilter) continue;
        if (!filterBy.toLowerCase().includes(queryLower.split(' ')[0])) continue;
        // Check if this matches the query
        const queryWords = queryLower.split(/\s+/);
        const matchCount = queryWords.filter(w => filterBy.toLowerCase().includes(w)).length;
        if (matchCount >= Math.ceil(queryWords.length * 0.5)) {
          // Extract meet name from filterBy (it's like "2026 nevada state championships henderson nv wom")
          const isWomen = filterBy.includes('wom');
          const isMen = filterBy.includes('men');
          results.push({
            name: filterBy.split(/\s{2,}/)[0].replace(/\b\w/g, c => c.toUpperCase()).trim(),
            id: meetId,
            source: 'mso',
            state: state.toUpperCase(),
            program: isMen ? 'Men' : isWomen ? 'Women' : 'unknown',
            date: 'check MSO',
          });
        }
      }
    } catch (e) {
      // MSO failed
    }

    if (results.length === 0) {
      return `No meets found matching "${query}". Try a different query.`;
    }

    // Format results
    const lines = results.map((r, i) =>
      `${i + 1}. ${r.name}\n   Source: ${r.source} | ID: ${r.id} | State: ${r.state} | Program: ${r.program} | Date: ${r.date}`
    );
    return `Found ${results.length} meets matching "${query}":\n\n${lines.join('\n\n')}`;
  },

  http_fetch: async (args) => {
    try {
      const url = requireString(args, 'url');
      const method = (optionalString(args, 'method') ?? 'GET').toUpperCase();
      // Headers can come as a JSON string or an object
      let headers: Record<string, string> = {};
      if (args.headers) {
        if (typeof args.headers === 'string') {
          try { headers = JSON.parse(args.headers); } catch { headers = {}; }
        } else {
          headers = args.headers as Record<string, string>;
        }
      }
      const body = optionalString(args, 'body');

      const options: RequestInit = { method, headers };
      if (body && method !== 'GET') {
        options.body = body;
      }

      const response = await fetch(url, options);
      const text = await response.text();

      // Auto-save large responses to file to keep agent context small
      if (text.length > 5000) {
        const dataDir = getDataDir();
        if (!fs.existsSync(dataDir)) {
          fs.mkdirSync(dataDir, { recursive: true });
        }
        const filename = `http_result_${Date.now()}.json`;
        const filepath = path.join(dataDir, filename);
        fs.writeFileSync(filepath, text, 'utf8');
        const sizeKB = (Buffer.byteLength(text, 'utf8') / 1024).toFixed(1);
        const preview = text.substring(0, 500);
        return `HTTP ${response.status} ${response.statusText} (saved to ${filepath}, ${sizeKB} KB)\nPreview: ${preview}`;
      }

      return `HTTP ${response.status} ${response.statusText}\n\n${text}`;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },

  web_search: async (args) => {
    try {
      const query = requireString(args, 'query');

      await chromeController.ensureConnected();

      // Use Google search in a real Chrome window
      const encodedQuery = encodeURIComponent(query);
      await chromeController.navigate(`https://www.google.com/search?q=${encodedQuery}`);

      // Wait for search results to render (Google loads results dynamically)
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Extract search results by finding h3 elements (result titles) and their parent links.
      // Google's HTML structure changes frequently, so we use a robust approach:
      // find all h3 tags, look for a parent <a> link, and grab nearby snippet text.
      const results = await chromeController.executeJS(`
        JSON.stringify(
          Array.from(document.querySelectorAll('h3')).slice(0, 10).map(h3 => {
            const link = h3.closest('a');
            if (!link || !link.href || link.href.includes('google.com')) return null;
            // Find snippet: sibling or nearby text block
            const container = link.closest('[data-snf], [data-sokoban], [data-hveid]') || link.parentElement?.parentElement;
            let snippet = '';
            if (container) {
              const spans = container.querySelectorAll('span, em');
              for (const sp of spans) {
                const text = sp.textContent || '';
                if (text.length > 40 && !text.includes(h3.textContent)) {
                  snippet = text.substring(0, 200);
                  break;
                }
              }
            }
            return {
              title: h3.textContent.trim(),
              url: link.href,
              snippet: snippet
            };
          }).filter(Boolean)
        )
      `);

      const parsed = JSON.parse(results as string) as Array<{ title: string; url: string; snippet: string }>;

      if (parsed.length === 0) {
        return `No search results found for "${query}". Try a different query.`;
      }

      const formatted = parsed.map((r, i) =>
        `${i + 1}. ${r.title}\n   URL: ${r.url}${r.snippet ? '\n   ' + r.snippet : ''}`
      ).join('\n\n');

      return `Search results for "${query}":\n\n${formatted}`;
    } catch (err) {
      return `Error performing web search: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
