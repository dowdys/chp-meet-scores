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

};
