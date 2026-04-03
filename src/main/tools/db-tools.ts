import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { getDataDir, getOutputDir } from '../paths';
import { getStagingDbPath } from './python-tools';
import { isSupabaseEnabled, getSupabaseClient } from '../supabase-client';
import { requireString, optionalString } from './validation';

function getCentralDbPath(): string {
  return path.join(getDataDir(), 'chp_results.db');
}

// Current workflow phase — set by the agent loop when phase changes.
// DB tools use this to enforce staging-only during processing phases.
let currentPhase: string | null = null;

/** Called by the agent loop to keep db-tools aware of the current phase. */
export function setDbToolsPhase(phase: string | null): void {
  currentPhase = phase;
}

// import_backs is NOT included — it runs post-finalization when staging is deleted.
// query_db during import_backs correctly falls through to central DB.
const PROCESSING_PHASES = new Set(['database', 'output_finalize']);

/**
 * Open the active database for reading.
 * During processing phases: uses staging DB (errors if it doesn't exist yet).
 * In query tab / no phase: uses central DB.
 * Returns { db, label } so callers can report which DB was used.
 */
function openDb(): { db: Database.Database; label: string } {
  const stagingPath = getStagingDbPath();

  // During processing phases, enforce staging DB
  if (currentPhase && PROCESSING_PHASES.has(currentPhase)) {
    if (stagingPath) {
      return { db: new Database(stagingPath, { readonly: true }), label: 'staging' };
    }
    // Staging doesn't exist yet — don't silently fall through to central
    throw new Error(
      `Staging database not found (phase: ${currentPhase}). ` +
      `Run build_database first to create the staging DB.`
    );
  }

  // Outside processing: prefer staging if it exists, otherwise central
  if (stagingPath) {
    return { db: new Database(stagingPath, { readonly: true }), label: 'staging' };
  }

  const centralPath = getCentralDbPath();
  if (!fs.existsSync(centralPath)) {
    throw new Error(`Database not found. No staging database and no central database at ${centralPath}. Run a meet processing first.`);
  }
  return { db: new Database(centralPath, { readonly: true }), label: 'central' };
}

function isSelectOnly(sql: string): boolean {
  // Strip comments and normalize whitespace
  const cleaned = sql
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim();
  // Check that the first keyword is SELECT or WITH (for CTEs)
  const firstWord = cleaned.split(/\s+/)[0].toUpperCase();
  if (firstWord !== 'SELECT' && firstWord !== 'WITH') {
    return false;
  }
  // Reject dangerous keywords that could appear in subqueries or CTEs
  const dangerous = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|REPLACE|ATTACH|DETACH|PRAGMA)\b/i;
  return !dangerous.test(cleaned);
}

function formatTable(columns: string[], rows: Record<string, unknown>[]): string {
  if (rows.length === 0) {
    return 'No results.';
  }

  // Calculate column widths
  const widths = columns.map(col => {
    const values = rows.map(r => String(r[col] ?? 'NULL'));
    return Math.max(col.length, ...values.map(v => v.length));
  });

  // Cap columns for readability, but give meet_name extra room to avoid truncation
  // that causes the agent to use wrong names in subsequent tool calls
  const cappedWidths = widths.map((w, i) => {
    const col = columns[i].toLowerCase();
    if (col === 'meet_name' || col === 'name') return Math.min(w, 80);
    return Math.min(w, 40);
  });

  const header = columns.map((col, i) => col.padEnd(cappedWidths[i])).join(' | ');
  const separator = cappedWidths.map(w => '-'.repeat(w)).join('-+-');
  const dataRows = rows.map(row =>
    columns.map((col, i) => {
      const val = String(row[col] ?? 'NULL');
      return val.substring(0, cappedWidths[i]).padEnd(cappedWidths[i]);
    }).join(' | ')
  );

  return [header, separator, ...dataRows].join('\n');
}

export const dbToolExecutors: Record<string, (args: Record<string, unknown>) => Promise<string>> = {
  query_db: async (args) => {
    try {
      const sql = requireString(args, 'sql');
      if (!isSelectOnly(sql)) {
        return 'Error: Only SELECT queries are allowed. INSERT, UPDATE, DELETE, DROP, and other modification statements are not permitted.';
      }

      const { db, label } = openDb();
      try {
        const stmt = db.prepare(sql);
        const rows = stmt.all() as Record<string, unknown>[];

        if (rows.length === 0) {
          return `[${label}] Query returned 0 rows.`;
        }

        const columns = Object.keys(rows[0]);
        const displayRows = rows.slice(0, 50);
        let result = `[${label}] ` + formatTable(columns, displayRows);

        if (rows.length > 50) {
          result += `\n\nShowing 50 of ${rows.length} rows.`;
        } else {
          result += `\n\n${rows.length} row${rows.length === 1 ? '' : 's'} returned.`;
        }

        return result;
      } finally {
        db.close();
      }
    } catch (err) {
      return `Error querying database: ${err instanceof Error ? err.message : String(err)}`;
    }
  },

  query_db_to_file: async (args) => {
    try {
      const sql = requireString(args, 'sql');
      const filename = requireString(args, 'filename');
      if (!isSelectOnly(sql)) {
        return 'Error: Only SELECT queries are allowed.';
      }

      const { db, label } = openDb();
      try {
        const stmt = db.prepare(sql);
        const rows = stmt.all() as Record<string, unknown>[];

        if (rows.length === 0) {
          return 'Query returned 0 rows. No file created.';
        }

        const columns = Object.keys(rows[0]);

        // Build CSV
        const escapeCsv = (val: unknown): string => {
          const s = String(val ?? '');
          if (s.includes(',') || s.includes('"') || s.includes('\n')) {
            return `"${s.replace(/"/g, '""')}"`;
          }
          return s;
        };

        const csvLines = [
          columns.map(escapeCsv).join(','),
          ...rows.map(row => columns.map(col => escapeCsv(row[col])).join(','))
        ];
        const csvContent = csvLines.join('\n');

        const meetName = optionalString(args, 'meet_name') ?? 'query-output';
        const outDir = getOutputDir(meetName);
        const filepath = path.join(outDir, filename);
        const resolvedPath = path.resolve(filepath);
        if (!resolvedPath.startsWith(path.resolve(outDir))) {
          return 'Error: filename must not escape the output directory.';
        }
        const dir = path.dirname(filepath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(filepath, csvContent, 'utf8');

        return `[${label}] Saved ${rows.length} rows to ${filepath}`;
      } finally {
        db.close();
      }
    } catch (err) {
      return `Error exporting query: ${err instanceof Error ? err.message : String(err)}`;
    }
  },

  list_meets: async () => {
    try {
      const { db, label } = openDb();
      try {
        const rows = db.prepare(
          `SELECT state, meet_name, association, COUNT(*) as result_count
           FROM results
           GROUP BY state, meet_name, association
           ORDER BY state, meet_name`
        ).all() as Record<string, unknown>[];

        if (rows.length === 0) {
          return 'No meets found in the database.';
        }

        const columns = ['state', 'meet_name', 'association', 'result_count'];
        return `[${label}] Meets in database:\n\n${formatTable(columns, rows)}`;
      } finally {
        db.close();
      }
    } catch (err) {
      return `Error listing meets: ${err instanceof Error ? err.message : String(err)}`;
    }
  },

  get_meet_summary: async (args) => {
    try {
      const meetName = requireString(args, 'meet_name');

      const { db, label } = openDb();
      try {
        // Total results and unique athletes
        const counts = db.prepare(
          `SELECT
            COUNT(*) as total_results,
            COUNT(DISTINCT name) as unique_athletes,
            COUNT(DISTINCT gym) as unique_gyms
           FROM results
           WHERE meet_name = ?`
        ).get(meetName) as Record<string, unknown> | undefined;

        if (!counts || (counts.total_results as number) === 0) {
          return `No results found for meet "${meetName}".`;
        }

        // Session/level/division breakdown
        const breakdown = db.prepare(
          `SELECT session, level, division, COUNT(*) as count
           FROM results
           WHERE meet_name = ?
           GROUP BY session, level, division
           ORDER BY session, level, division`
        ).all(meetName) as Record<string, unknown>[];

        // Winner counts from winners table
        const winners = db.prepare(
          `SELECT COUNT(*) as winner_count
           FROM winners
           WHERE meet_name = ?`
        ).get(meetName) as Record<string, unknown> | undefined;

        // Tie count from winners table
        const ties = db.prepare(
          `SELECT COUNT(*) as tie_count
           FROM winners
           WHERE meet_name = ? AND is_tie = 1`
        ).get(meetName) as Record<string, unknown> | undefined;

        let summary = `[${label}] Meet Summary: ${meetName}\n`;
        summary += `${'='.repeat(40)}\n\n`;
        summary += `Total results: ${counts.total_results}\n`;
        summary += `Unique athletes: ${counts.unique_athletes}\n`;
        summary += `Unique gyms: ${counts.unique_gyms}\n`;
        summary += `Winners: ${winners?.winner_count ?? 0}\n`;
        summary += `Tied winners: ${ties?.tie_count ?? 0}\n`;
        summary += `\nSession / Level / Division breakdown:\n`;
        summary += formatTable(['session', 'level', 'division', 'count'], breakdown);

        return summary;
      } finally {
        db.close();
      }
    } catch (err) {
      return `Error getting meet summary: ${err instanceof Error ? err.message : String(err)}`;
    }
  },

  rename_gym: async (args) => {
    try {
      const meetName = requireString(args, 'meet_name');
      const oldName = requireString(args, 'old_name');
      const newName = requireString(args, 'new_name');

      if (oldName === newName) {
        return 'Error: old_name and new_name are identical.';
      }

      // Update local database (staging if exists, otherwise central)
      const stagingPath = getStagingDbPath();
      const centralPath = getCentralDbPath();
      const dbPath = stagingPath || centralPath;

      if (!fs.existsSync(dbPath)) {
        return 'Error: No database found.';
      }

      const db = new Database(dbPath);
      let resultsChanged = 0;
      let winnersChanged = 0;
      try {
        const rename = db.transaction(() => {
          const r = db.prepare('UPDATE results SET gym = ? WHERE meet_name = ? AND gym = ?')
            .run(newName, meetName, oldName);
          resultsChanged = r.changes;
          const w = db.prepare('UPDATE winners SET gym = ? WHERE meet_name = ? AND gym = ?')
            .run(newName, meetName, oldName);
          winnersChanged = w.changes;
        });
        rename();
      } finally {
        db.close();
      }

      if (resultsChanged === 0 && winnersChanged === 0) {
        return `No rows matched gym "${oldName}" for meet "${meetName}". Check the spelling.`;
      }

      let msg = `Renamed "${oldName}" → "${newName}" locally: ${resultsChanged} results, ${winnersChanged} winners updated.`;

      // Also update Supabase so pull_meet won't overwrite the fix
      // Skip Supabase sync when operating on a staging DB — staging data is not yet canonical
      if (getStagingDbPath()) {
        msg += ' Skipped Supabase sync — operating on staging DB.';
      } else if (isSupabaseEnabled()) {
        try {
          const supabase = await getSupabaseClient();
          if (supabase) {
            const { error: rErr } = await supabase
              .from('results')
              .update({ gym: newName })
              .eq('meet_name', meetName)
              .eq('gym', oldName);
            const { error: wErr } = await supabase
              .from('winners')
              .update({ gym: newName })
              .eq('meet_name', meetName)
              .eq('gym', oldName);

            if (rErr || wErr) {
              msg += ` Supabase update failed: ${rErr?.message || wErr?.message}. Local DB is correct but pull_meet may overwrite.`;
            } else {
              msg += ` Also updated in Supabase — pull_meet will now use the corrected name.`;
            }
          }
        } catch (err) {
          msg += ` Supabase sync failed: ${err instanceof Error ? err.message : String(err)}. Local DB is correct.`;
        }
      }

      return msg;
    } catch (err) {
      return `Error renaming gym: ${err instanceof Error ? err.message : String(err)}`;
    }
  },

  fix_names: async (args) => {
    const meetName = typeof args.meet_name === 'string' ? args.meet_name.trim() : '';
    if (!meetName) {
      return 'Error: meet_name is required. Pass the meet name to apply corrections to.';
    }

    let corrections: Array<{ original: string; corrected: string }>;
    try {
      const raw = typeof args.corrections === 'string' ? JSON.parse(args.corrections) : args.corrections;
      if (!Array.isArray(raw) || raw.length === 0) {
        return 'No corrections to apply. Pass a JSON array of {original, corrected} objects.';
      }
      // Validate shape of each correction
      const valid = raw.every((item: unknown) =>
        typeof item === 'object' && item !== null &&
        typeof (item as Record<string, unknown>).original === 'string' &&
        typeof (item as Record<string, unknown>).corrected === 'string'
      );
      if (!valid) {
        return 'Error: Each correction must have {original: string, corrected: string} properties.';
      }
      corrections = raw as Array<{ original: string; corrected: string }>;
    } catch {
      return 'Error: corrections must be a valid JSON array of {original, corrected} objects.';
    }

    const stagingPath = getStagingDbPath();
    const centralPath = getCentralDbPath();
    const dbPath = stagingPath || centralPath;

    if (!fs.existsSync(dbPath)) {
      return 'Error: No database found (no staging or central DB).';
    }

    const db = new Database(dbPath);
    try {
      const applied: string[] = [];
      const skipped: string[] = [];

      db.exec('BEGIN IMMEDIATE');
      const updateStmt = db.prepare('UPDATE results SET name = ? WHERE name = ? AND meet_name = ?');

      for (const { original, corrected } of corrections) {
        if (!original || !corrected || original === corrected) {
          skipped.push(`"${original}" — no change needed`);
          continue;
        }
        const result = updateStmt.run(corrected, original, meetName);
        if (result.changes > 0) {
          applied.push(`"${original}" → "${corrected}" (${result.changes} rows)`);
        } else {
          skipped.push(`"${original}" — not found in database`);
        }
      }

      // Update winners table to stay in sync with corrected names
      const updateWinnersStmt = db.prepare('UPDATE winners SET name = ? WHERE name = ? AND meet_name = ?');
      for (const { original, corrected } of corrections) {
        if (original && corrected && original !== corrected) {
          updateWinnersStmt.run(corrected, original, meetName);
        }
      }

      db.exec('COMMIT');

      let msg = `Fixed ${applied.length} name(s) in ${stagingPath ? 'staging' : 'central'} DB for meet "${meetName}".`;
      if (applied.length > 0) msg += '\n\nApplied:\n' + applied.map(a => `  ✓ ${a}`).join('\n');
      if (skipped.length > 0) msg += '\n\nSkipped:\n' + skipped.map(s => `  - ${s}`).join('\n');
      msg += '\n\nBoth results and winners tables updated. You can now call regenerate_output.';
      return msg;
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      return `Error fixing names: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      db.close();
    }
  },
};
