import { app } from 'electron';
import { spawn, spawnSync } from 'child_process';
import * as path from 'path';
import { getProjectRoot } from './paths';

export interface PythonResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

type LineCallback = (line: string) => void;

/**
 * Find a working Python command. On Windows, `python3` often doesn't exist —
 * `python` is the standard name. Try `python` first, then `python3`.
 */
function findPythonCommand(): string {
  for (const cmd of ['python', 'python3']) {
    try {
      const result = spawnSync(cmd, ['--version'], { timeout: 5000, stdio: 'pipe' });
      if (result.status === 0) return cmd;
    } catch {
      // Command not found, try next
    }
  }
  return 'python';
}

class PythonManager {
  /**
   * Resolve the path to a Python script.
   * In dev mode: run from the python/ directory in the project root.
   * In production: run bundled executables from resources/python/.
   */
  private resolvePath(scriptName: string): { command: string; args: string[] } {
    if (app.isPackaged) {
      // Production: run bundled .exe
      const exePath = path.join(process.resourcesPath, 'python', scriptName.replace(/\.py$/, '.exe'));
      return { command: exePath, args: [] };
    } else {
      // Development: use shared project root
      const projectRoot = getProjectRoot();
      const scriptPath = path.join(projectRoot, 'python', scriptName);
      return { command: findPythonCommand(), args: [scriptPath] };
    }
  }

  /**
   * Run a Python script and return stdout/stderr/exitCode.
   * Optionally stream stdout lines via a callback for live activity log updates.
   */
  async runScript(
    scriptName: string,
    args: string[] = [],
    onLine?: LineCallback
  ): Promise<PythonResult> {
    const resolved = this.resolvePath(scriptName);

    return new Promise((resolve, reject) => {
      const proc = spawn(resolved.command, [...resolved.args, ...args], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data: Buffer) => {
        const text = data.toString();
        stdout += text;

        if (onLine) {
          const lines = text.split('\n').filter((l: string) => l.trim());
          for (const line of lines) {
            onLine(line);
          }
        }
      });

      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on('close', (exitCode) => {
        resolve({ stdout, stderr, exitCode });
      });

      proc.on('error', (err) => {
        reject(err);
      });
    });
  }
}

export const pythonManager = new PythonManager();
