import { app } from 'electron';
import { spawn, spawnSync, execFileSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
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
   * In production: prefer bundled binary, fall back to system Python + .py files.
   */
  private resolvePath(scriptName: string): { command: string; args: string[] } {
    if (app.isPackaged) {
      const baseName = scriptName.replace(/\.py$/, '');
      const binaryName = process.platform === 'win32' ? `${baseName}.exe` : baseName;
      const binaryPath = path.join(process.resourcesPath, 'python', binaryName);

      // Check if bundled binary exists and is executable
      if (fs.existsSync(binaryPath)) {
        try {
          fs.accessSync(binaryPath, fs.constants.X_OK);
          // Verify it's actually executable (not blocked by quarantine etc.)
          if (process.platform === 'darwin') {
            try {
              execFileSync(binaryPath, ['--help'], { timeout: 5000, stdio: 'pipe' });
            } catch (testErr: unknown) {
              // --help may exit non-zero, that's fine — we just need it to launch
              const err = testErr as { status?: number; killed?: boolean; signal?: string };
              if (err.killed || err.signal === 'SIGKILL') {
                // Binary was killed (likely quarantine/Gatekeeper block)
                console.warn(`[python-manager] Binary blocked by macOS: ${binaryPath}, falling back to system Python`);
                return this.fallbackToSystemPython(scriptName);
              }
              // Non-zero exit from --help is fine (means it launched successfully)
            }
          }
          console.log(`[python-manager] Using bundled binary: ${binaryPath}`);
          return { command: binaryPath, args: [] };
        } catch {
          console.warn(`[python-manager] Binary not executable: ${binaryPath}, falling back to system Python`);
          return this.fallbackToSystemPython(scriptName);
        }
      } else {
        console.warn(`[python-manager] Binary not found: ${binaryPath}, falling back to system Python`);
        return this.fallbackToSystemPython(scriptName);
      }
    } else {
      // Development: use shared project root
      const projectRoot = getProjectRoot();
      const scriptPath = path.join(projectRoot, 'python', scriptName);
      return { command: findPythonCommand(), args: [scriptPath] };
    }
  }

  /**
   * Fallback for packaged mode when the bundled binary is missing or blocked.
   * Uses system Python to run the bundled .py source files.
   */
  private fallbackToSystemPython(scriptName: string): { command: string; args: string[] } {
    const scriptPath = path.join(process.resourcesPath, 'python', scriptName);
    if (!fs.existsSync(scriptPath)) {
      // Neither binary nor .py file — will fail, but let spawn report the error
      const baseName = scriptName.replace(/\.py$/, '');
      const binaryName = process.platform === 'win32' ? `${baseName}.exe` : baseName;
      return { command: path.join(process.resourcesPath, 'python', binaryName), args: [] };
    }
    const pythonCmd = findPythonCommand();
    console.log(`[python-manager] Fallback: ${pythonCmd} ${scriptPath}`);
    return { command: pythonCmd, args: [scriptPath] };
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
        env: { ...process.env, PYTHONUTF8: '1' },
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
