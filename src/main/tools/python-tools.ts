import { pythonManager } from '../python-manager';
import * as fs from 'fs';
import * as path from 'path';

function getDataDir(): string {
  const isDev = !require('electron').app.isPackaged;
  if (isDev) {
    return path.join(__dirname, '..', '..', 'data');
  }
  return path.join(require('electron').app.getPath('userData'), 'data');
}

export const pythonToolExecutors: Record<string, (args: Record<string, unknown>) => Promise<string>> = {
  run_python: async (args) => {
    try {
      const argsStr = args.args as string;
      if (!argsStr) {
        return 'Error: args parameter is required (command line arguments for process_meet.py)';
      }

      // Split the args string into an array, respecting quoted strings
      const argList = argsStr.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
      // Remove surrounding quotes from each argument
      const cleanArgs = argList.map(a => a.replace(/^"(.*)"$/, '$1'));

      const result = await pythonManager.runScript('process_meet.py', cleanArgs);

      let output = result.stdout;
      if (result.stderr && result.stderr.trim()) {
        output += `\n\n--- stderr ---\n${result.stderr}`;
      }
      if (result.exitCode !== 0) {
        output += `\n\nProcess exited with code ${result.exitCode}`;
      }

      return output || 'Script completed with no output.';
    } catch (err) {
      return `Error running Python script: ${err instanceof Error ? err.message : String(err)}`;
    }
  },

  save_to_file: async (args) => {
    try {
      const content = args.content as string;
      const filename = args.filename as string;
      if (!content || !filename) {
        return 'Error: content and filename parameters are required';
      }

      const dataDir = getDataDir();
      const filepath = path.join(dataDir, filename);

      // Create directories if needed
      const dir = path.dirname(filepath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(filepath, content, 'utf8');
      const bytes = Buffer.byteLength(content, 'utf8');
      return `Saved ${bytes} bytes to ${filepath}`;
    } catch (err) {
      return `Error saving file: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
