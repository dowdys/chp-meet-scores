import { pythonManager } from '../python-manager';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { getDataDir } from '../paths';
import { requireString, optionalNumber } from './validation';

function getDbPath(): string {
  return path.join(getDataDir(), 'chp_results.db');
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

  // Clean up orphaned staging files older than 24 hours
  try {
    const dataDir = getDataDir();
    if (fs.existsSync(dataDir)) {
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      for (const f of fs.readdirSync(dataDir)) {
        if (f.startsWith('staging_') && f.endsWith('.db')) {
          const ts = parseInt(f.replace('staging_', '').replace('.db', ''), 10) || 0;
          if (ts > 0 && ts < cutoff) {
            try { fs.unlinkSync(path.join(dataDir, f)); } catch { /* ignore */ }
          }
        }
      }
    }
  } catch {
    // Non-fatal: skip cleanup if data dir is inaccessible
  }
}

// NOTE: run_python is intentionally NOT here. It needs meet context (meetName) for
// --output path injection, so it's handled inline in agent-loop.ts's executeTool().
// However, the staging DB path is now provided by getStagingDbPath() from this module.

export const pythonToolExecutors: Record<string, (args: Record<string, unknown>) => Promise<string>> = {
  save_to_file: async (args) => {
    try {
      const content = requireString(args, 'content');
      const filename = requireString(args, 'filename');

      const dataDir = getDataDir();
      const filepath = path.join(dataDir, filename);

      const resolved = path.resolve(filepath);
      if (!resolved.startsWith(path.resolve(dataDir))) {
        return 'Error: filename must not escape the data directory.';
      }

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
      const code = requireString(args, 'code');
      const timeout = optionalNumber(args, 'timeout') ?? 30000;
      const dataDir = getDataDir();
      const centralDbPath = getDbPath();

      // During processing, point DB_PATH at the staging DB so agent scripts
      // can't accidentally write to the central DB. The staging DB is the
      // working copy; central is only written to by finalize_meet.
      const stagingPath = currentStagingDbPath;
      let dbPath: string;
      if (stagingPath && fs.existsSync(stagingPath)) {
        dbPath = stagingPath;
      } else {
        dbPath = centralDbPath;
        // If we're falling through to central during a processing phase, warn
        if (stagingPath) {
          console.warn('run_script: staging DB expected but not found, falling back to central DB');
        }
      }

      // Write code to a temp file
      const timestamp = Date.now();
      const tempFile = path.join(dataDir, `tmp_script_${timestamp}.py`);
      fs.writeFileSync(tempFile, code, 'utf8');

      try {
        // Use pythonManager to run via bundled binary (--exec-script mode)
        const result = await pythonManager.runScript(
          'process_meet.py',
          ['--exec-script', tempFile],
          undefined,
          {
            DB_PATH: dbPath,
            CENTRAL_DB_PATH: centralDbPath,
            DATA_DIR: dataDir,
            STAGING_DB_PATH: currentStagingDbPath || '',
            PYTHONUTF8: '1',
          },
          timeout
        );

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
      const meetName = requireString(args, 'meet_name');

      // Find staging DB: use module-level path, or fall back to scanning data dir
      let stagingPath = currentStagingDbPath;
      if (!stagingPath || !fs.existsSync(stagingPath)) {
        // Fallback: find most recent staging_*.db by numeric timestamp (not alphabetical)
        const dataDir = getDataDir();
        const stagingFiles = fs.readdirSync(dataDir)
          .filter(f => f.startsWith('staging_') && f.endsWith('.db'))
          .sort((a, b) => {
            const tsA = parseInt(a.replace('staging_', '').replace('.db', ''), 10) || 0;
            const tsB = parseInt(b.replace('staging_', '').replace('.db', ''), 10) || 0;
            return tsB - tsA; // Most recent first
          });
        if (stagingFiles.length > 0) {
          stagingPath = path.join(dataDir, stagingFiles[0]);
        }
      }

      if (!stagingPath || !fs.existsSync(stagingPath)) {
        return 'Error: No staging database found. If you just ran import_idml, finalize_meet is not needed — IDML imports write directly to the central database. If you ran build_database, the staging DB may have already been finalized or cleaned up.';
      }

      const centralPath = getDbPath();

      // Check for potential duplicate meets by querying staging DB for state
      let duplicateWarning = '';
      try {
        const stagingDb = new Database(stagingPath, { readonly: true });
        const stateRow = stagingDb.prepare(
          'SELECT DISTINCT state FROM results WHERE meet_name = ? LIMIT 1'
        ).get(meetName) as { state: string } | undefined;
        stagingDb.close();

        if (stateRow?.state && fs.existsSync(centralPath)) {
          const checkDb = new Database(centralPath, { readonly: true });
          try {
            const existingMeets = checkDb.prepare(
              'SELECT DISTINCT meet_name, COUNT(*) as cnt FROM results WHERE state = ? GROUP BY meet_name'
            ).all(stateRow.state) as { meet_name: string; cnt: number }[];

            if (existingMeets.length > 0) {
              // Check for same state + year under a different name (likely duplicate)
              const meetYear = meetName.match(/\b(20\d{2})\b/)?.[1] || '';
              const sameYearDifferentName = existingMeets.filter(m =>
                m.meet_name !== meetName && meetYear && m.meet_name.includes(meetYear)
              );

              if (sameYearDifferentName.length > 0) {
                const dupes = sameYearDifferentName.map(m =>
                  `  "${m.meet_name}" (${m.cnt} athletes)`
                ).join('\n');
                duplicateWarning = `⚠️ WARNING: ${stateRow.state} ${meetYear} already exists under a DIFFERENT name:\n${dupes}\n` +
                  `You are adding: "${meetName}". This may create duplicate data. ` +
                  `If this is the same meet, use the existing name to overwrite it instead.\n\n`;
              } else {
                const warnings = existingMeets.map((m) =>
                  `  "${m.meet_name}" (${m.cnt} athletes)`
                ).join('\n');
                duplicateWarning = `Note: ${stateRow.state} already has meets in the database:\n${warnings}\n` +
                  `Adding: "${meetName}". If this is a duplicate, use the same meet name to overwrite.\n`;
              }
              console.log(duplicateWarning);
            }
          } finally {
            checkDb.close();
          }
        }
      } catch {
        // Non-fatal: skip duplicate check if staging DB query fails
      }

      // Open central DB (read-write)
      const centralDb = new Database(centralPath);

      try {
        // Ensure central DB has the required tables
        centralDb.exec(`
          CREATE TABLE IF NOT EXISTS results (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            state TEXT, meet_name TEXT, association TEXT,
            name TEXT, gym TEXT, session TEXT, level TEXT, division TEXT,
            vault REAL, bars REAL, beam REAL, floor REAL, aa REAL,
            rank TEXT, num TEXT
          );
          CREATE TABLE IF NOT EXISTS winners (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            state TEXT, meet_name TEXT, association TEXT,
            name TEXT, gym TEXT, session TEXT, level TEXT, division TEXT,
            event TEXT, score REAL, is_tie INTEGER DEFAULT 0
          );
          CREATE UNIQUE INDEX IF NOT EXISTS idx_winners_unique
            ON winners(meet_name, name, gym, session, level, division, event);
          CREATE TABLE IF NOT EXISTS meets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            meet_name TEXT UNIQUE,
            source TEXT,
            source_id TEXT,
            source_name TEXT,
            state TEXT,
            association TEXT,
            year TEXT,
            dates TEXT,
            created_at TEXT DEFAULT (datetime('now'))
          );
        `);

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
          } catch (err) {
            // Only tolerate "table doesn't exist" — anything else is real data loss
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('no such table')) {
              console.warn('finalize_meet: staging has no winners table (incomplete processing)');
            } else {
              throw err; // Re-throw — will roll back the transaction
            }
          }

          // Copy meets metadata from staging to central (only if staging has the table and data)
          try {
            const hasMeetsRow = centralDb.prepare(
              `SELECT COUNT(*) as cnt FROM staging.meets WHERE meet_name = ?`
            ).get(meetName) as { cnt: number } | undefined;
            if (hasMeetsRow && hasMeetsRow.cnt > 0) {
              centralDb.prepare('DELETE FROM meets WHERE meet_name = ?').run(meetName);
              centralDb.prepare(
                `INSERT OR REPLACE INTO meets (meet_name, source, source_id, source_name, state, association, year, dates, created_at)
                 SELECT meet_name, source, source_id, source_name, state, association, year, dates, created_at
                 FROM staging.meets WHERE meet_name = ?`
              ).run(meetName);
            }
          } catch (err) {
            // Tolerate missing table, but log other errors
            const msg = err instanceof Error ? err.message : String(err);
            if (!msg.includes('no such table')) {
              console.warn('finalize_meet: meets metadata copy error:', msg);
            }
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

        const finalMsg = `Finalized "${meetName}" into central database: ${counts.results} athletes, ${counts.winners} winners merged.`;
        return duplicateWarning ? duplicateWarning + finalMsg : finalMsg;
      } catch (err) {
        centralDb.close();
        throw err;
      }
    } catch (err) {
      return `Error finalizing meet: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
