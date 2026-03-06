import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { getDataDir as sharedGetDataDir, getProjectRoot as sharedGetProjectRoot } from '../paths';

function getProjectRoot(): string {
  return sharedGetProjectRoot();
}

function getDataDir(): string {
  return sharedGetDataDir();
}

export const fileToolExecutors: Record<string, (args: Record<string, unknown>) => Promise<string>> = {
  read_file: async (args) => {
    try {
      const filePath = args.path as string;
      if (!filePath) {
        return 'Error: path parameter is required';
      }

      // Resolve path: if relative, check writable data dir first, then resources data dir
      let resolvedPath: string;
      if (path.isAbsolute(filePath)) {
        resolvedPath = filePath;
      } else {
        const writableData = getDataDir();
        const resourcesData = path.join(getProjectRoot(), 'data');
        const writablePath = path.join(writableData, filePath);
        const resourcesPath = path.join(resourcesData, filePath);
        // Prefer writable data dir (where chrome_save_to_file writes)
        if (fs.existsSync(writablePath)) {
          resolvedPath = writablePath;
        } else if (fs.existsSync(resourcesPath)) {
          resolvedPath = resourcesPath;
        } else {
          resolvedPath = writablePath; // default to writable for error message
        }
      }

      // Security check: path must be under project root OR under home dir
      const projectRoot = getProjectRoot();
      const homeDir = app.getPath('home');
      const normalizedPath = path.resolve(resolvedPath);
      if (!normalizedPath.startsWith(projectRoot) && !normalizedPath.startsWith(homeDir)) {
        return `Error: Access denied. Path must be under the project root (${projectRoot}) or home directory (${homeDir}).`;
      }

      if (!fs.existsSync(resolvedPath)) {
        // List files in data dir to help the agent find the right file
        const dataDir = getDataDir();
        let suggestion = '';
        if (fs.existsSync(dataDir)) {
          const files = fs.readdirSync(dataDir)
            .filter(f => !fs.statSync(path.join(dataDir, f)).isDirectory())
            .slice(0, 20);
          if (files.length > 0) {
            suggestion = `\n\nFiles in ${dataDir}:\n  ${files.join('\n  ')}`;
          }
        }
        return `Error: File not found: ${resolvedPath}${suggestion}`;
      }

      const content = fs.readFileSync(resolvedPath, 'utf-8');
      const lines = content.split('\n');

      // Apply offset/limit (1-based line numbers, like Claude Code's Read)
      const offset = (args.offset as number) || 1;
      const limit = (args.limit as number) || lines.length;
      const startIdx = Math.max(0, offset - 1);
      const endIdx = Math.min(lines.length, startIdx + limit);
      const selectedLines = lines.slice(startIdx, endIdx);

      // Format with line numbers
      const numbered = selectedLines.map((line, i) => {
        const lineNum = startIdx + i + 1;
        return `${String(lineNum).padStart(6)}  ${line}`;
      });

      let result = numbered.join('\n');

      // Truncate if too large (50KB)
      if (result.length > 50000) {
        result = result.substring(0, 50000) + '\n... (truncated at 50KB)';
      }

      const header = `File: ${resolvedPath} (${lines.length} lines total, showing ${startIdx + 1}-${endIdx})`;
      return `${header}\n${result}`;
    } catch (err) {
      return `Error reading file: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
