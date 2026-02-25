import { pythonManager } from '../python-manager';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { spawn, spawnSync } from 'child_process';
import Database from 'better-sqlite3';
import { getDataDir, getProjectRoot } from '../paths';

function getDbPath(): string {
  return path.join(getDataDir(), 'chp_results.db');
}

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
  return 'python'; // fallback — will produce a clear error if not found
}

// --- Staging DB management ---
// Module-level staging DB path: shared across run_python calls within a session.
// Reset on resetStagingDb().
let currentStagingDbPath: string | null = null;

export function getStagingDbPath(): string {
  if (!currentStagingDbPath) {
    const timestamp = Date.now();
    currentStagingDbPath = path.join(getDataDir(), `staging_${timestamp}.db`);
  }
  return currentStagingDbPath;
}

export function resetStagingDb(): void {
  if (currentStagingDbPath && fs.existsSync(currentStagingDbPath)) {
    try {
      fs.unlinkSync(currentStagingDbPath);
    } catch {
      // Ignore cleanup errors
    }
  }
  currentStagingDbPath = null;
}

// NOTE: run_python is intentionally NOT here. It needs meet context (meetName) for
// --output path injection, so it's handled inline in agent-loop.ts's executeTool().
// However, the staging DB path is now provided by getStagingDbPath() from this module.

export const pythonToolExecutors: Record<string, (args: Record<string, unknown>) => Promise<string>> = {
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

  run_script: async (args) => {
    try {
      const code = args.code as string;
      if (!code) {
        return 'Error: code parameter is required';
      }

      const timeout = (args.timeout as number) || 30000;
      const dataDir = getDataDir();
      const dbPath = getDbPath();

      // Write code to a temp file
      const timestamp = Date.now();
      const tempFile = path.join(dataDir, `tmp_script_${timestamp}.py`);
      fs.writeFileSync(tempFile, code, 'utf8');

      try {
        // Resolve python path (works on both Linux and Windows)
        const pythonCmd = findPythonCommand();

        const result = await new Promise<{ stdout: string; stderr: string; exitCode: number | null }>((resolve, reject) => {
          const proc = spawn(pythonCmd, [tempFile], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: {
              ...process.env,
              DB_PATH: dbPath,
              DATA_DIR: dataDir,
              STAGING_DB_PATH: currentStagingDbPath || '',
            },
            timeout,
          });

          let stdout = '';
          let stderr = '';

          proc.stdout.on('data', (data: Buffer) => {
            stdout += data.toString();
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

          // Kill on timeout
          setTimeout(() => {
            try { proc.kill('SIGKILL'); } catch { /* ignore */ }
          }, timeout);
        });

        let output = '';
        if (result.stdout) {
          output += result.stdout;
        }
        if (result.stderr) {
          output += (output ? '\n\n--- stderr ---\n' : '') + result.stderr;
        }
        if (result.exitCode !== 0) {
          output = `Script exited with code ${result.exitCode}.\n${output}`;
        }

        // Truncate to 50KB
        if (output.length > 50000) {
          output = output.substring(0, 50000) + '\n... (truncated at 50KB)';
        }

        return output || 'Script completed successfully (no output).';
      } finally {
        // Clean up temp file
        try {
          if (fs.existsSync(tempFile)) {
            fs.unlinkSync(tempFile);
          }
        } catch {
          // Ignore cleanup errors
        }
      }
    } catch (err) {
      return `Error running script: ${err instanceof Error ? err.message : String(err)}`;
    }
  },

  finalize_meet: async (args) => {
    try {
      const meetName = args.meet_name as string;
      if (!meetName) {
        return 'Error: meet_name parameter is required';
      }

      const stagingPath = currentStagingDbPath;
      if (!stagingPath || !fs.existsSync(stagingPath)) {
        return 'Error: No staging database found. Run run_python first to create staging data.';
      }

      const centralPath = getDbPath();

      // Open central DB (read-write)
      const centralDb = new Database(centralPath);

      try {
        // Attach staging DB
        centralDb.exec(`ATTACH DATABASE '${stagingPath.replace(/'/g, "''")}' AS staging`);

        // Begin transaction for atomicity
        const transaction = centralDb.transaction(() => {
          // Delete existing data for this meet in central
          centralDb.prepare('DELETE FROM results WHERE meet_name = ?').run(meetName);
          centralDb.prepare('DELETE FROM winners WHERE meet_name = ?').run(meetName);

          // Copy results from staging to central
          const resultCount = centralDb.prepare(
            `INSERT INTO results (state, meet_name, association, name, gym, session, level, division,
             vault, bars, beam, floor, aa, rank, num)
             SELECT state, meet_name, association, name, gym, session, level, division,
             vault, bars, beam, floor, aa, rank, num
             FROM staging.results WHERE meet_name = ?`
          ).run(meetName);

          // Copy winners from staging to central
          let winnerCount = { changes: 0 };
          try {
            winnerCount = centralDb.prepare(
              `INSERT INTO winners (state, meet_name, association, name, gym, session, level, division,
               event, score, is_tie)
               SELECT state, meet_name, association, name, gym, session, level, division,
               event, score, is_tie
               FROM staging.winners WHERE meet_name = ?`
            ).run(meetName);
          } catch {
            // Winners table might not exist in staging if processing didn't complete fully
          }

          return { results: resultCount.changes, winners: winnerCount.changes };
        });

        const counts = transaction();

        // Detach and clean up
        centralDb.exec('DETACH DATABASE staging');
        centralDb.close();

        // Delete staging DB file
        try {
          fs.unlinkSync(stagingPath);
        } catch {
          // Ignore
        }
        currentStagingDbPath = null;

        return `Finalized "${meetName}" into central database: ${counts.results} athletes, ${counts.winners} winners merged.`;
      } catch (err) {
        centralDb.close();
        throw err;
      }
    } catch (err) {
      return `Error finalizing meet: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
