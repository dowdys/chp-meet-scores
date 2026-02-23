import { chromeController } from '../chrome-controller';
import * as fs from 'fs';
import * as path from 'path';

function getDataDir(): string {
  const isDev = !require('electron').app.isPackaged;
  if (isDev) {
    // __dirname is dist/main when bundled, repo root is two levels up
    return path.join(__dirname, '..', '..', 'data');
  }
  return path.join(require('electron').app.getPath('userData'), 'data');
}

async function ensureConnected(): Promise<void> {
  if (!chromeController.isConnected()) {
    await chromeController.launch();
    await chromeController.connect();
  }
}

export const browserToolExecutors: Record<string, (args: Record<string, unknown>) => Promise<string>> = {
  chrome_navigate: async (args) => {
    try {
      const url = args.url as string;
      if (!url) {
        return 'Error: url parameter is required';
      }
      await ensureConnected();
      await chromeController.navigate(url);
      return `Navigated to ${url}`;
    } catch (err) {
      return `Error navigating: ${err instanceof Error ? err.message : String(err)}`;
    }
  },

  chrome_execute_js: async (args) => {
    try {
      const script = args.script as string;
      if (!script) {
        return 'Error: script parameter is required';
      }
      await ensureConnected();
      const result = await chromeController.executeJS(script);
      const resultStr = JSON.stringify(result, null, 2);

      if (resultStr.length > 10000) {
        const dataDir = getDataDir();
        if (!fs.existsSync(dataDir)) {
          fs.mkdirSync(dataDir, { recursive: true });
        }
        const filename = `js_result_${Date.now()}.json`;
        const filepath = path.join(dataDir, filename);
        fs.writeFileSync(filepath, resultStr, 'utf8');
        const summary = resultStr.substring(0, 200);
        return `Result saved to ${filepath}. ${summary}...`;
      }

      return resultStr;
    } catch (err) {
      return `Error executing JS: ${err instanceof Error ? err.message : String(err)}`;
    }
  },

  chrome_screenshot: async () => {
    try {
      await ensureConnected();
      const filepath = await chromeController.screenshot();
      return `Screenshot saved to ${filepath}`;
    } catch (err) {
      return `Error taking screenshot: ${err instanceof Error ? err.message : String(err)}`;
    }
  },

  chrome_click: async (args) => {
    try {
      const selector = args.selector as string;
      if (!selector) {
        return 'Error: selector parameter is required';
      }
      await ensureConnected();
      await chromeController.executeJS(`document.querySelector(${JSON.stringify(selector)}).click()`);
      return `Clicked element: ${selector}`;
    } catch (err) {
      return `Error clicking element: ${err instanceof Error ? err.message : String(err)}`;
    }
  },

  chrome_network: async (args) => {
    try {
      const duration = (args.duration as number) || 5000;
      await ensureConnected();

      // Inject a network monitor that collects XHR/fetch requests
      await chromeController.executeJS(`
        window.__networkRequests = [];
        const origFetch = window.fetch;
        window.fetch = async function(...args) {
          const url = typeof args[0] === 'string' ? args[0] : args[0].url;
          const start = Date.now();
          try {
            const resp = await origFetch.apply(this, args);
            const clone = resp.clone();
            const body = await clone.text();
            window.__networkRequests.push({ type: 'fetch', url, status: resp.status, size: body.length, time: Date.now() - start });
            return resp;
          } catch(e) {
            window.__networkRequests.push({ type: 'fetch', url, error: e.message, time: Date.now() - start });
            throw e;
          }
        };
        const origXHROpen = XMLHttpRequest.prototype.open;
        const origXHRSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function(method, url) {
          this.__url = url;
          this.__method = method;
          return origXHROpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function() {
          const start = Date.now();
          this.addEventListener('load', function() {
            window.__networkRequests.push({ type: 'xhr', url: this.__url, method: this.__method, status: this.status, size: this.responseText.length, time: Date.now() - start });
          });
          return origXHRSend.apply(this, arguments);
        };
      `);

      // Wait for the specified duration
      await new Promise(resolve => setTimeout(resolve, duration));

      // Collect results
      const requests = await chromeController.executeJS(`JSON.stringify(window.__networkRequests || [])`);
      const parsed = JSON.parse(requests as string);

      if (parsed.length === 0) {
        return `No XHR/fetch requests captured in ${duration}ms.`;
      }

      const lines = parsed.map((r: { type: string; method?: string; url: string; status?: number; size?: number; time: number; error?: string }) =>
        `[${r.type.toUpperCase()}] ${r.method || 'GET'} ${r.url} -> ${r.status || 'error'} (${r.size || 0} bytes, ${r.time}ms)`
      );
      return `Captured ${parsed.length} requests in ${duration}ms:\n${lines.join('\n')}`;
    } catch (err) {
      return `Error monitoring network: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
