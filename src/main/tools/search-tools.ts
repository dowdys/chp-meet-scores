import { chromeController } from '../chrome-controller';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

function getDataDir(): string {
  const root = app.isPackaged ? process.resourcesPath! : path.join(app.getAppPath(), '..', '..');
  return path.join(root, 'data');
}

async function ensureConnected(): Promise<void> {
  if (!chromeController.isConnected()) {
    await chromeController.ensureConnected();
  }
}

export const searchToolExecutors: Record<string, (args: Record<string, unknown>) => Promise<string>> = {
  http_fetch: async (args) => {
    try {
      const url = args.url as string;
      const method = (args.method as string || 'GET').toUpperCase();
      // Headers can come as a JSON string or an object
      let headers: Record<string, string> = {};
      if (args.headers) {
        if (typeof args.headers === 'string') {
          try { headers = JSON.parse(args.headers); } catch { headers = {}; }
        } else {
          headers = args.headers as Record<string, string>;
        }
      }
      const body = args.body as string | undefined;

      if (!url) {
        return 'Error: url parameter is required';
      }

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
      const query = args.query as string;
      if (!query) {
        return 'Error: query parameter is required';
      }

      await ensureConnected();

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
