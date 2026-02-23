import { chromeController } from '../chrome-controller';

async function ensureConnected(): Promise<void> {
  if (!chromeController.isConnected()) {
    await chromeController.launch();
    await chromeController.connect();
  }
}

export const searchToolExecutors: Record<string, (args: Record<string, unknown>) => Promise<string>> = {
  web_search: async (args) => {
    try {
      const query = args.query as string;
      if (!query) {
        return 'Error: query parameter is required';
      }

      await ensureConnected();

      const encodedQuery = encodeURIComponent(query);
      await chromeController.navigate(`https://www.google.com/search?q=${encodedQuery}`);

      // Wait a moment for results to render
      await new Promise(resolve => setTimeout(resolve, 1500));

      // Extract search results from the page
      const results = await chromeController.executeJS(`
        JSON.stringify(
          Array.from(document.querySelectorAll('div.g')).slice(0, 10).map(el => ({
            title: el.querySelector('h3') ? el.querySelector('h3').textContent : '',
            url: el.querySelector('a') ? el.querySelector('a').href : '',
            snippet: el.querySelector('.VwiC3b') ? el.querySelector('.VwiC3b').textContent : ''
          })).filter(r => r.title && r.url)
        )
      `);

      const parsed = JSON.parse(results as string) as Array<{ title: string; url: string; snippet: string }>;

      if (parsed.length === 0) {
        return `No results found for "${query}". Google may have shown a CAPTCHA or different layout.`;
      }

      const formatted = parsed.map((r, i) =>
        `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.snippet}`
      ).join('\n\n');

      return `Search results for "${query}":\n\n${formatted}`;
    } catch (err) {
      return `Error performing web search: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
