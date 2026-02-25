import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { configStore } from '../config-store';
import { getStagingDbPath } from './python-tools';

function getProjectRoot(): string {
  return app.isPackaged ? process.resourcesPath! : path.join(app.getAppPath(), '..', '..');
}

function getCentralDbPath(): string {
  return path.join(getProjectRoot(), 'data', 'chp_results.db');
}

function getOutputDir(meetName: string): string {
  const outputBase = configStore.get('outputDir') || path.join(app.getPath('documents'), 'Gymnastics Champions');
  return path.join(outputBase, meetName);
}

/**
 * Open the active database for reading.
 * During processing: uses the staging DB (if it exists).
 * In query tab (no staging): uses the central DB.
 */
function openDb(): Database.Database {
  // Check if a staging DB exists — prefer it during processing
  const stagingPath = getStagingDbPath();
  if (fs.existsSync(stagingPath)) {
    return new Database(stagingPath, { readonly: true });
  }

  // Fall back to central DB
  const centralPath = getCentralDbPath();
  if (!fs.existsSync(centralPath)) {
    throw new Error(`Database not found. No staging database and no central database at ${centralPath}. Run a meet processing first.`);
  }
  return new Database(centralPath, { readonly: true });
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

  // Cap each column at 40 chars for readability
  const cappedWidths = widths.map(w => Math.min(w, 40));

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
      const sql = args.sql as string;
      if (!sql) {
        return 'Error: sql parameter is required';
      }
      if (!isSelectOnly(sql)) {
        return 'Error: Only SELECT queries are allowed. INSERT, UPDATE, DELETE, DROP, and other modification statements are not permitted.';
      }

      const db = openDb();
      try {
        const stmt = db.prepare(sql);
        const rows = stmt.all() as Record<string, unknown>[];

        if (rows.length === 0) {
          return 'Query returned 0 rows.';
        }

        const columns = Object.keys(rows[0]);
        const displayRows = rows.slice(0, 50);
        let result = formatTable(columns, displayRows);

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
      const sql = args.sql as string;
      const filename = args.filename as string;
      if (!sql || !filename) {
        return 'Error: sql and filename parameters are required';
      }
      if (!isSelectOnly(sql)) {
        return 'Error: Only SELECT queries are allowed.';
      }

      const db = openDb();
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

        const meetName = (args.meet_name as string) || 'query-output';
        const outDir = getOutputDir(meetName);
        const filepath = path.join(outDir, filename);
        const dir = path.dirname(filepath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(filepath, csvContent, 'utf8');

        return `Saved ${rows.length} rows to ${filepath}`;
      } finally {
        db.close();
      }
    } catch (err) {
      return `Error exporting query: ${err instanceof Error ? err.message : String(err)}`;
    }
  },

  list_meets: async () => {
    try {
      const db = openDb();
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
        return `Meets in database:\n\n${formatTable(columns, rows)}`;
      } finally {
        db.close();
      }
    } catch (err) {
      return `Error listing meets: ${err instanceof Error ? err.message : String(err)}`;
    }
  },

  get_meet_summary: async (args) => {
    try {
      const meetName = args.meet_name as string;
      if (!meetName) {
        return 'Error: meet_name parameter is required';
      }

      const db = openDb();
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

        let summary = `Meet Summary: ${meetName}\n`;
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
};
