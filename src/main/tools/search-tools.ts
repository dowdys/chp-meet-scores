import { chromeController } from '../chrome-controller';
import * as fs from 'fs';
import * as path from 'path';
import { getDataDir } from '../paths';
import { requireString, optionalString } from './validation';
import { fetchWithRetry } from './retry';

// State name → 2-letter abbreviation mapping (lowercase keys)
const STATE_ABBREVS: Record<string, string> = {
  alabama: 'al', alaska: 'ak', arizona: 'az', arkansas: 'ar', california: 'ca',
  colorado: 'co', connecticut: 'ct', delaware: 'de', florida: 'fl', georgia: 'ga',
  hawaii: 'hi', idaho: 'id', illinois: 'il', indiana: 'in', iowa: 'ia',
  kansas: 'ks', kentucky: 'ky', louisiana: 'la', maine: 'me', maryland: 'md',
  massachusetts: 'ma', michigan: 'mi', minnesota: 'mn', mississippi: 'ms',
  missouri: 'mo', montana: 'mt', nebraska: 'ne', nevada: 'nv', 'new hampshire': 'nh',
  'new jersey': 'nj', 'new mexico': 'nm', 'new york': 'ny', 'north carolina': 'nc',
  'north dakota': 'nd', ohio: 'oh', oklahoma: 'ok', oregon: 'or', pennsylvania: 'pa',
  'rhode island': 'ri', 'south carolina': 'sc', 'south dakota': 'sd', tennessee: 'tn',
  texas: 'tx', utah: 'ut', vermont: 'vt', virginia: 'va', washington: 'wa',
  'west virginia': 'wv', wisconsin: 'wi', wyoming: 'wy',
};

// Reverse lookup: abbreviation → full state name
const US_STATE_NAMES: Record<string, string> = {};
for (const [name, abbr] of Object.entries(STATE_ABBREVS)) {
  US_STATE_NAMES[abbr.toUpperCase()] = name.split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
}

/** Normalize a state input to its 2-letter abbreviation (lowercase). */
function normalizeState(raw: string): string {
  const lower = raw.toLowerCase().trim();
  // Already an abbreviation (2 letters)?
  if (lower.length === 2 && /^[a-z]{2}$/.test(lower)) return lower;
  return STATE_ABBREVS[lower] || lower;
}

export const searchToolExecutors: Record<string, (args: Record<string, unknown>) => Promise<string>> = {
  search_meets: async (args) => {
    const query = requireString(args, 'query');
    const rawState = requireString(args, 'state');
    if (!rawState.trim()) {
      return 'Error: state parameter is required and cannot be empty. Pass the state name or abbreviation (e.g., "Michigan", "NV").';
    }
    const stateFilter = normalizeState(rawState);
    const results: Array<{name: string, id: string, source: string, state: string, program: string, date: string}> = [];
    const searchNotes: string[] = [];
    let algoliaFailed = false;

    // --- Step 0: Perplexity context (if API key available) ---
    // Ask Perplexity about the championship to know what meets to expect and where to find them
    let perplexityContext = '';
    const perplexityMeetNames: string[] = [];
    try {
      const { configStore } = await import('../config-store');
      const pplxKey = configStore.get('perplexityApiKey');
      if (pplxKey) {
        const pplxResp = await fetchWithRetry('https://api.perplexity.ai/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${pplxKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'sonar',
            messages: [{
              role: 'user',
              content: `I need to find gymnastics meet results for: ${query}.

State championships are often split into multiple separately scored meets (e.g., one for Xcel divisions, one for competitive levels 4-10, one for levels 2-3).

For EACH separate meet that makes up this championship, tell me:
1. The EXACT meet name as it would appear on scoring platforms
2. Which scoring platform hosts the results: MeetScoresOnline.com (MSO) or ScoreCat (results.scorecatonline.com)
3. The dates
4. What levels/divisions it covers

Be specific about meet names — they're often like "2026 [State] Xcel State Championships" or "2026 [State] Level 4-10 State Championships". Keep your answer concise and factual.`,
            }],
          }),
        });
        const pplxData = await pplxResp.json() as { choices?: Array<{ message?: { content?: string } }> };
        perplexityContext = pplxData?.choices?.[0]?.message?.content || '';

        // Extract meet names from Perplexity response for smarter Algolia/MSO searching
        const nameMatches = perplexityContext.match(/[""]([^""]+(?:Championship|Championships|State)[^""]*)[""]/gi) ||
                           perplexityContext.match(/(?:^|\n)\d+\.\s*\*?\*?([^\n*]+(?:Championship|Championships|State)[^\n*]*)/gim);
        if (nameMatches) {
          for (const m of nameMatches) {
            const cleaned = m.replace(/^[\d.\s*"]+/, '').replace(/["*]+$/, '').trim();
            if (cleaned.length > 10 && cleaned.length < 100) {
              perplexityMeetNames.push(cleaned);
            }
          }
        }
      }
    } catch (err) {
      // Perplexity unavailable — note it so agent knows results may be incomplete
      const errMsg = err instanceof Error ? err.message : String(err);
      perplexityContext = `Note: Perplexity pre-search unavailable (${errMsg}). ScoreCat results may be less complete.`;
    }

    // --- Step 1: Search Algolia (ScoreCat) ---
    // Search with multiple query variations: original, state-based simple queries, and Perplexity names
    const stateName = stateFilter ? US_STATE_NAMES[stateFilter.toUpperCase()] || '' : '';
    const yearMatch = query.match(/\b(20\d{2})\b/);
    const year = yearMatch ? yearMatch[1] : new Date().getFullYear().toString();
    const algoliaQueries = [
      query,
      // Simple state-based searches (these match better than the verbose UI query)
      ...(stateName ? [
        `${stateName} state ${year}`,
        `${stateName} state championship ${year}`,
        `${stateName} ${year}`,
        `${stateFilter?.toUpperCase()} state ${year}`,
      ] : []),
      ...perplexityMeetNames,
    ];
    const seenScoreCatIds = new Set<string>();
    for (const aq of algoliaQueries) {
      try {
        const algoliaResp = await fetchWithRetry('https://2r102d471d.algolia.net/1/indexes/ff_meets/query', {
          method: 'POST',
          headers: {
            'x-algolia-application-id': '2R102D471D',
            'x-algolia-api-key': 'f6c6022306eb2dace46c6490e7ae9984',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ query: aq }),
        });
        const algoliaData = await algoliaResp.json() as { hits?: Array<Record<string, unknown>> };
        for (const hit of algoliaData.hits || []) {
          const hitId = ((hit.meet_id || hit.objectID) as string);
          if (seenScoreCatIds.has(hitId)) continue;
          const hitState = (hit.state as string | undefined) || '';
          if (stateFilter && normalizeState(hitState) !== stateFilter) continue;
          seenScoreCatIds.add(hitId);
          const startDate = hit.startDate ? new Date(hit.startDate as number).toISOString().split('T')[0] : 'unknown';
          results.push({
            name: hit.name as string,
            id: hitId,
            source: 'scorecat',
            state: (hit.state as string) || '',
            program: (hit.program as string) || 'unknown',
            date: startDate,
          });
        }
      } catch (err) {
        // Track Algolia failures so agent knows results may be incomplete
        if (!algoliaFailed) {
          algoliaFailed = true;
          searchNotes.push(`Note: ScoreCat/Algolia search had errors — some ScoreCat meets may be missing.`);
        }
      }
    }

    // --- Step 2: Search MSO Results.All ---
    const searchMsoPage = async (url: string) => {
      const msoResp = await fetchWithRetry(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      const html = await msoResp.text();
      const regex = /data-meetid="(\d+)"\s+data-state="([^"]+)"\s+data-filter-by="([^"]+)"/g;
      let match;
      const seenIds = new Set(results.map(r => r.id));

      while ((match = regex.exec(html)) !== null) {
        const [, meetId, meetState, filterBy] = match;
        if (seenIds.has(meetId)) continue;
        // State filter is the primary filter
        if (stateFilter && meetState.toLowerCase() !== stateFilter) continue;

        // When we have a state filter, include ALL meets from that state.
        // The agent + Perplexity context will identify which ones are relevant.
        const isMatch = !!stateFilter;

        if (isMatch) {
          const isWomen = filterBy.includes('wom');
          const isMen = filterBy.includes('men');
          results.push({
            name: filterBy.split(/\s{2,}/)[0].replace(/\b\w/g, c => c.toUpperCase()).trim(),
            id: meetId,
            source: 'mso',
            state: meetState.toUpperCase(),
            program: isMen ? 'Men' : isWomen ? 'Women' : 'unknown',
            date: 'check MSO',
          });
          seenIds.add(meetId);
        }
      }
    };

    try {
      await searchMsoPage('https://www.meetscoresonline.com/Results.All');

      const yearMatch = query.match(/\b(20\d{2})\b/);
      if (yearMatch) {
        const meetYear = parseInt(yearMatch[1], 10);
        const now = new Date();
        const currentSeasonEnd = now.getMonth() >= 7 ? now.getFullYear() + 1 : now.getFullYear();
        if (meetYear !== currentSeasonEnd) {
          const seasonStr = `${meetYear - 1}-${meetYear}`;
          await searchMsoPage(`https://www.meetscoresonline.com/Results.All.${seasonStr}`);
        }
      }
    } catch {
      searchNotes.push(`Note: MSO search failed — some MSO meets may be missing.`);
    }

    // --- Step 3: Perplexity ID fallback (if no results yet) ---
    if (results.length === 0) {
      try {
        const { configStore } = await import('../config-store');
        const pplxKey = configStore.get('perplexityApiKey');
        if (pplxKey) {
          const pplxResp = await fetchWithRetry('https://api.perplexity.ai/chat/completions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${pplxKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model: 'sonar',
              messages: [{
                role: 'user',
                content: `What is the MeetScoresOnline.com meet ID (the numeric ID from the URL like meetscoresonline.com/R{ID}) for the ${query} gymnastics meet? Also check ScoreCat (results.scorecatonline.com) if it's not on MSO. Just give me the meet ID and source.`,
              }],
            }),
          });
          const pplxData = await pplxResp.json() as { choices?: Array<{ message?: { content?: string } }> };
          const pplxText = pplxData?.choices?.[0]?.message?.content || '';
          if (pplxText) {
            const msoIds = pplxText.match(/\/R(\d{4,6})/g)?.map(m => m.replace('/R', '')) || [];
            const numericIds = pplxText.match(/\b(\d{4,6})\b/g) || [];
            const allIds = [...new Set([...msoIds, ...numericIds])];

            for (const meetId of allIds.slice(0, 3)) {
              try {
                const verifyResp = await fetchWithRetry('https://www.meetscoresonline.com/Ajax.ProjectsJson.msoMeet.aspx?_cpn=999999', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
                  body: `p_meetid=${meetId}&query_name=lookup_scores`,
                });
                const verifyData = await verifyResp.json() as { results?: Array<{ result?: { row?: unknown[] } }> };
                const rows = verifyData?.results?.[0]?.result?.row || [];
                if (Array.isArray(rows) && rows.length > 0) {
                  results.push({
                    name: `${query} (found via Perplexity)`,
                    id: meetId,
                    source: 'mso',
                    state: stateFilter?.toUpperCase() || '',
                    program: 'Women',
                    date: 'verified',
                  });
                }
              } catch { /* skip unverifiable IDs */ }
            }
          }
        }
      } catch {
        // Perplexity ID search failed — fall through
      }
    }

    // --- Format results ---
    if (results.length === 0) {
      let msg = `No meets found matching "${query}". Try a different query or use web_search for archived meets.`;
      if (perplexityContext) {
        msg += `\n\nHowever, Perplexity found this context about the championship:\n${perplexityContext}`;
      }
      return msg;
    }

    const lines = results.map((r, i) =>
      `${i + 1}. ${r.name}\n   Source: ${r.source} | ID: ${r.id} | State: ${r.state} | Program: ${r.program} | Date: ${r.date}`
    );
    let output = `Found ${results.length} meets matching "${query}":\n\n${lines.join('\n\n')}`;

    // Append Perplexity context so the agent knows what levels/dates to expect
    if (perplexityContext) {
      output += `\n\n--- Championship Context (from Perplexity) ---\n${perplexityContext}\n\nUse this context to verify the meets above cover all expected levels. If levels are missing, there may be additional meets to find.`;
    }

    // Surface any search backend failures
    if (searchNotes.length > 0) {
      output += '\n\n' + searchNotes.join('\n');
    }

    return output;
  },

  lookup_meet: async (args) => {
    try {
      const source = requireString(args, 'source');
      const meetId = requireString(args, 'meet_id');

      if (source !== 'mso') {
        return `lookup_meet only supports MSO meets. For ScoreCat meets, no verification is needed — the meet was already found via Algolia search. Proceed directly to scorecat_extract with meet_ids: ["${meetId}"].`;
      }

      // Fetch meet metadata via MSO lookup_meet API
      const metaResp = await fetchWithRetry('https://www.meetscoresonline.com/Ajax.ProjectsJson.msoMeet.aspx?_cpn=999999', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: `p_meetid=${meetId}&p_eventid=1&query_name=lookup_meet`,
      });
      const metaData = await metaResp.json() as { results?: Array<{ result?: { row?: Array<Record<string, string>> } }> };
      const rows = metaData?.results?.[0]?.result?.row || [];

      if (rows.length === 0) {
        return `No meet found for MSO ID ${meetId}. Verify the ID is correct.`;
      }

      const m = rows[0];

      // Also check athlete count via lookup_scores
      let athleteCount = 0;
      try {
        const scoresResp = await fetchWithRetry('https://www.meetscoresonline.com/Ajax.ProjectsJson.msoMeet.aspx?_cpn=999999', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
          body: `p_meetid=${meetId}&query_name=lookup_scores`,
        });
        const scoresData = await scoresResp.json() as { results?: Array<{ result?: { row?: unknown[] } }> };
        athleteCount = scoresData?.results?.[0]?.result?.row?.length || 0;
      } catch { /* non-fatal */ }

      const lines = [
        `MSO Meet #${meetId}:`,
        `  Name: ${m.MeetName || 'unknown'}`,
        `  Dates: ${m.meetfulldate_long || 'unknown'}`,
        `  Location: ${m.MeetCity || ''}, ${m.MeetState || ''}`,
        `  Facility: ${m.MeetFacility || 'unknown'}`,
        `  Host: ${m.HostClub || 'unknown'}`,
        `  Director: ${m.MeetDirector || 'unknown'}`,
        `  Status: ${m.StatusText || 'unknown'}`,
        `  Type: ${m.EventType || 'unknown'}`,
        `  Athletes: ${athleteCount > 0 ? athleteCount : 'unknown'}`,
      ];

      if (athleteCount > 0) {
        lines.push('');
        lines.push(`This meet has data available. Use mso_extract with meet_ids: ["${meetId}"] to extract.`);
      }

      return lines.join('\n');
    } catch (err) {
      return `Error looking up meet: ${err instanceof Error ? err.message : String(err)}`;
    }
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

      const response = await fetchWithRetry(url, options);
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
