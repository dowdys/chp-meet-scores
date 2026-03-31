import { chromeController } from '../chrome-controller';
import * as fs from 'fs';
import * as path from 'path';
import { getDataDir } from '../paths';
import { requireString, optionalNumber } from './validation';

export const browserToolExecutors: Record<string, (args: Record<string, unknown>) => Promise<string>> = {
  chrome_navigate: async (args) => {
    try {
      const url = requireString(args, 'url');
      await chromeController.ensureConnected();
      await chromeController.navigate(url);
      return `Navigated to ${url}`;
    } catch (err) {
      return `Error navigating: ${err instanceof Error ? err.message : String(err)}`;
    }
  },

  chrome_execute_js: async (args) => {
    try {
      const script = requireString(args, 'script');
      await chromeController.ensureConnected();

      const result = await chromeController.executeJS(script);
      // Agent scripts often call JSON.stringify() themselves, so result is already
      // a JSON string. Serialize for the agent context, but save raw to file to
      // avoid double-encoding that breaks Python parsers.
      const resultStr = JSON.stringify(result, null, 2);

      if (resultStr.length > 10000) {
        const dataDir = getDataDir();
        if (!fs.existsSync(dataDir)) {
          fs.mkdirSync(dataDir, { recursive: true });
        }
        const filename = `js_result_${Date.now()}.json`;
        const filepath = path.join(dataDir, filename);
        const fileContent = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        fs.writeFileSync(filepath, fileContent, 'utf8');
        const summary = resultStr.substring(0, 200);
        return `Result saved to ${filepath}. ${summary}...`;
      }

      return resultStr;
    } catch (err) {
      return `Error executing JS: ${err instanceof Error ? err.message : String(err)}`;
    }
  },

  chrome_save_to_file: async (args) => {
    try {
      const script = requireString(args, 'script');
      const filename = requireString(args, 'filename');
      const timeoutMs = optionalNumber(args, 'timeout_ms') ?? 60000;
      await chromeController.ensureConnected();

      const dataDir = getDataDir();
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      const filePath = path.join(dataDir, filename);

      const resolved = path.resolve(filePath);
      if (!resolved.startsWith(path.resolve(dataDir))) {
        return 'Error: filename must not escape the data directory.';
      }

      const { size, preview } = await chromeController.saveJSToFile(script, filePath, timeoutMs);
      const sizeKB = (size / 1024).toFixed(1);
      return `Saved to ${filePath} (${sizeKB} KB). Preview: ${preview}`;
    } catch (err) {
      return `Error saving JS result to file: ${err instanceof Error ? err.message : String(err)}`;
    }
  },

  chrome_screenshot: async () => {
    try {
      await chromeController.ensureConnected();
      const filepath = await chromeController.screenshot();
      return `Screenshot saved to ${filepath}`;
    } catch (err) {
      return `Error taking screenshot: ${err instanceof Error ? err.message : String(err)}`;
    }
  },

  chrome_click: async (args) => {
    try {
      const selector = requireString(args, 'selector');
      await chromeController.ensureConnected();
      await chromeController.executeJS(`document.querySelector(${JSON.stringify(selector)}).click()`);
      return `Clicked element: ${selector}`;
    } catch (err) {
      return `Error clicking element: ${err instanceof Error ? err.message : String(err)}`;
    }
  },

  // --- Site-specific browse tools (URL-safe) ---

  browse_mso: async (args) => {
    try {
      const meetId = requireString(args, 'meet_id');
      // Sanitize: only allow numeric IDs
      if (!/^\d+$/.test(meetId)) {
        return 'Error: meet_id must be a numeric MSO ID (e.g., "34670")';
      }
      const url = `https://www.meetscoresonline.com/R${meetId}`;
      await chromeController.ensureConnected();
      await chromeController.navigate(url);
      await new Promise(resolve => setTimeout(resolve, 2000));
      const screenshotPath = await chromeController.screenshot();

      // Extract key page text
      const pageText = await chromeController.executeJS(`
        JSON.stringify({
          title: document.title || '',
          h1: document.querySelector('h1')?.textContent?.trim() || '',
          h2: document.querySelector('h2')?.textContent?.trim() || '',
          meetInfo: document.querySelector('.meet-info, .header-info, [class*="meet"]')?.textContent?.trim()?.substring(0, 500) || '',
        })
      `);

      return `Navigated to MSO meet page: ${url}\nScreenshot: ${screenshotPath}\nPage info: ${pageText}`;
    } catch (err) {
      return `Error browsing MSO: ${err instanceof Error ? err.message : String(err)}`;
    }
  },

  browse_scorecat: async (args) => {
    try {
      const meetId = requireString(args, 'meet_id');
      // Sanitize: only allow alphanumeric IDs
      if (!/^[A-Za-z0-9]+$/.test(meetId)) {
        return 'Error: meet_id must be an alphanumeric ScoreCat/Algolia ID (e.g., "VQS0J5FI")';
      }
      const url = `https://results.scorecatonline.com/meets/${meetId}`;
      await chromeController.ensureConnected();
      await chromeController.navigate(url);
      await new Promise(resolve => setTimeout(resolve, 3000)); // ScoreCat is SPA — needs extra load time

      const screenshotPath = await chromeController.screenshot();

      // Extract key page text
      const pageText = await chromeController.executeJS(`
        JSON.stringify({
          title: document.title || '',
          meetName: document.querySelector('h1, h2, [class*="meet-name"], [class*="meetName"]')?.textContent?.trim() || '',
          bodyText: document.body?.textContent?.trim()?.substring(0, 500) || '',
        })
      `);

      return `Navigated to ScoreCat meet page: ${url}\nScreenshot: ${screenshotPath}\nPage info: ${pageText}`;
    } catch (err) {
      return `Error browsing ScoreCat: ${err instanceof Error ? err.message : String(err)}`;
    }
  },

};
