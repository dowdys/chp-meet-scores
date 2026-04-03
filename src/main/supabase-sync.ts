/**
 * Supabase sync module: publishes finalized meet data and files to the cloud.
 *
 * All Supabase operations go through this module. The Python pipeline
 * is unaware of Supabase -- it writes to local SQLite and files, and
 * this module handles the cloud sync afterward.
 */
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { getSupabaseClient, isSupabaseEnabled } from './supabase-client';
import { configStore } from './config-store';
import { getOutputDir, getCentralDbPath } from './paths';

export type PublishResult =
  | { success: true; version: number; resultsCount: number; winnersCount: number }
  | { success: false; reason: string };

export type PullResult =
  | { success: true; resultsCount: number; winnersCount: number }
  | { success: false; reason: string };

/** Known output filenames that should be uploaded to Supabase Storage. */
const UPLOADABLE_FILES = [
  'back_of_shirt.pdf',
  'back_of_shirt.idml',
  'back_of_shirt_8.5x14.pdf',
  'back_of_shirt_8.5x14.idml',
  'order_forms.pdf',
  'gym_highlights.pdf',
  'gym_highlights_8.5x14.pdf',
  'meet_summary.txt',
];

/**
 * Sanitize a meet name into a URL-safe storage path segment.
 */
function sanitizeMeetName(meetName: string): string {
  return meetName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Round a number to 3 decimal places to prevent float-to-NUMERIC precision loss.
 */
function roundScore(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  if (isNaN(num)) return null;
  return Math.round(num * 1000) / 1000;
}

/**
 * Publish finalized meet data to Supabase via the publish_meet RPC.
 * Reads from the local central SQLite database.
 */
export async function publishMeetData(meetName: string): Promise<PublishResult> {
  if (!isSupabaseEnabled()) {
    return { success: false, reason: 'Supabase sync disabled' };
  }

  const supabase = await getSupabaseClient();
  if (!supabase) {
    return { success: false, reason: 'Supabase client not available' };
  }

  const centralPath = getCentralDbPath();
  if (!fs.existsSync(centralPath)) {
    return { success: false, reason: 'Central database not found' };
  }

  const db = new Database(centralPath, { readonly: true });
  try {
    // Read meet metadata
    const meetRow = db.prepare('SELECT * FROM meets WHERE meet_name = ?').get(meetName) as Record<string, unknown> | undefined;
    if (!meetRow) {
      return { success: false, reason: `Meet "${meetName}" not found in central database` };
    }

    // Read results with score rounding
    const results = db.prepare('SELECT * FROM results WHERE meet_name = ?').all(meetName) as Record<string, unknown>[];
    const roundedResults = results.map(r => ({
      ...r,
      gym: r.gym || '',  // Coalesce NULL gym to empty string
      club_num: r.club_num || '',
      vault: roundScore(r.vault),
      bars: roundScore(r.bars),
      beam: roundScore(r.beam),
      floor: roundScore(r.floor),
      aa: roundScore(r.aa),
    }));

    // Read winners with score rounding and boolean conversion
    const winners = db.prepare('SELECT * FROM winners WHERE meet_name = ?').all(meetName) as Record<string, unknown>[];
    const convertedWinners = winners.map(w => ({
      ...w,
      gym: w.gym || '',
      score: roundScore(w.score),
      is_tie: !!w.is_tie,  // SQLite INTEGER 0/1 -> boolean
    }));

    // Build meet metadata for RPC
    const meetData = {
      meet_name: meetRow.meet_name,
      source: meetRow.source || null,
      source_id: meetRow.source_id || null,
      source_name: meetRow.source_name || null,
      state: meetRow.state,
      association: meetRow.association || null,
      year: meetRow.year,
      dates: meetRow.dates || null,
      published_by: configStore.get('installationId'),
    };

    // Call the atomic publish RPC
    const { data, error } = await supabase.rpc('publish_meet_v2', {
      p_meet: meetData,
      p_results: roundedResults,
      p_winners: convertedWinners,
    });

    if (error) {
      return { success: false, reason: error.message };
    }

    // publish_meet_v2 returns meet_id via RETURNING clause (migration 006)
    const result = data as { version: number; results_count: number; winners_count: number; meet_id: string };
    return {
      success: true,
      version: result.version,
      resultsCount: result.results_count,
      winnersCount: result.winners_count,
    };
  } finally {
    db.close();
  }
}

/**
 * Upload output files for a meet to Supabase Storage.
 * Only uploads files from the known UPLOADABLE_FILES list to prevent
 * uploading stale or unrelated files (learning: stale-extract-files-cause-data-bloat).
 */
export async function uploadMeetFiles(meetName: string): Promise<{ uploaded: string[]; failed: string[] }> {
  const uploaded: string[] = [];
  const failed: string[] = [];

  if (!isSupabaseEnabled()) return { uploaded, failed };

  const supabase = await getSupabaseClient();
  if (!supabase) return { uploaded, failed };

  const outputDir = getOutputDir(meetName, false);
  if (!fs.existsSync(outputDir)) return { uploaded, failed };

  // Determine storage path: STATE/year/sanitized-name/
  const centralPath = getCentralDbPath();
  let state = 'XX';
  let year = new Date().getFullYear().toString();
  if (fs.existsSync(centralPath)) {
    const db = new Database(centralPath, { readonly: true });
    try {
      const row = db.prepare('SELECT state, year FROM meets WHERE meet_name = ?').get(meetName) as { state: string; year: string } | undefined;
      if (row) {
        state = row.state || 'XX';
        year = row.year || year;
      }
    } finally {
      db.close();
    }
  }

  const storagePath = `${state.toUpperCase()}/${year}/${sanitizeMeetName(meetName)}`;

  // Clean up orphaned blobs before uploading (prevents stale files from previous versions)
  try {
    const { data: existingFiles } = await supabase.storage
      .from('meet-documents')
      .list(storagePath);
    if (existingFiles?.length) {
      const newFilenames = new Set(UPLOADABLE_FILES.filter(f =>
        fs.existsSync(path.join(outputDir, f))
      ));
      const orphaned = existingFiles
        .filter(f => !newFilenames.has(f.name))
        .map(f => `${storagePath}/${f.name}`);
      if (orphaned.length > 0) {
        await supabase.storage.from('meet-documents').remove(orphaned);
        console.log(`[supabase-sync] Removed ${orphaned.length} orphaned files from storage`);
      }
    }
  } catch (err) {
    console.warn('[supabase-sync] Blob cleanup failed (non-fatal):', err);
  }

  // Upload files sequentially (bandwidth-bound; sequential gives clean per-file error handling)
  for (const filename of UPLOADABLE_FILES) {
    const filePath = path.join(outputDir, filename);
    if (!fs.existsSync(filePath)) continue;

    try {
      const fileBuffer = fs.readFileSync(filePath);
      const contentType = filename.endsWith('.pdf') ? 'application/pdf'
        : filename.endsWith('.idml') ? 'application/xml'
        : filename.endsWith('.txt') ? 'text/plain'
        : 'application/octet-stream';

      const { error } = await supabase.storage
        .from('meet-documents')
        .upload(`${storagePath}/${filename}`, fileBuffer, {
          contentType,
          upsert: true,
        });

      if (error) {
        console.warn(`[supabase-sync] Upload failed for ${filename}:`, error.message);
        failed.push(filename);
      } else {
        // Record file metadata in meet_files table
        const { error: upsertError } = await supabase.from('meet_files').upsert({
          meet_name: meetName,
          filename,
          storage_path: `${storagePath}/${filename}`,
          file_size: fileBuffer.length,
        }, { onConflict: 'meet_name,filename' });

        if (upsertError) {
          console.warn(`[supabase-sync] meet_files upsert failed for ${filename}:`, upsertError.message);
          failed.push(filename);
        } else {
          uploaded.push(filename);
        }
      }
    } catch (err) {
      console.warn(`[supabase-sync] Upload error for ${filename}:`, err);
      failed.push(filename);
    }
  }

  return { uploaded, failed };
}

/**
 * Publish a complete meet: data + files.
 * This is the main entry point called from finalize_meet and import_pdf_backs.
 */
export async function publishMeet(meetName: string): Promise<PublishResult> {
  // Publish structured data first
  const dataResult = await publishMeetData(meetName);
  if (!dataResult.success) return dataResult;

  // Upload output files (non-fatal failures)
  const fileResult = await uploadMeetFiles(meetName);
  if (fileResult.failed.length > 0) {
    console.warn(`[supabase-sync] ${fileResult.failed.length} files failed to upload for "${meetName}"`);
  }

  // Update local meets table with published_at
  try {
    const centralPath = getCentralDbPath();
    const db = new Database(centralPath);
    try {
      // Migration: add columns if they don't exist (idempotent)
      for (const col of ['published_at', 'published_by', 'sync_status']) {
        try { db.exec(`ALTER TABLE meets ADD COLUMN ${col} TEXT`); } catch { /* already exists */ }
      }
      db.prepare(
        'UPDATE meets SET published_at = ?, published_by = ?, sync_status = ? WHERE meet_name = ?'
      ).run(new Date().toISOString(), configStore.get('installationId'), 'published', meetName);
    } finally {
      db.close();
    }
  } catch (err) {
    console.warn('[supabase-sync] Failed to update local published_at:', err);
  }

  return dataResult;
}

/**
 * Pull a published meet's data from Supabase into the local central SQLite database.
 * This is the inverse of publishMeetData() — enables local output regeneration
 * after cloud-side corrections (e.g., gym name fixes) or on a different machine.
 */
export async function pullMeetData(meetName: string): Promise<PullResult> {
  if (!isSupabaseEnabled()) {
    return { success: false, reason: 'Supabase sync disabled' };
  }

  const supabase = await getSupabaseClient();
  if (!supabase) {
    return { success: false, reason: 'Supabase client not available' };
  }

  // 1. Fetch meet metadata
  const { data: meetRow, error: meetErr } = await supabase
    .from('meets')
    .select('meet_name, source, source_id, source_name, state, association, year, dates')
    .eq('meet_name', meetName)
    .single();
  if (meetErr || !meetRow) {
    return { success: false, reason: `Meet "${meetName}" not found in Supabase` };
  }

  // 2. Fetch all results (paginated to avoid PostgREST 1000-row truncation)
  const allResults: Record<string, unknown>[] = [];
  const PAGE_SIZE = 1000;
  let offset = 0;
  while (true) {
    const { data: batch, error: rErr } = await supabase
      .from('results')
      .select('state, meet_name, association, name, gym, session, level, division, vault, bars, beam, floor, aa, rank, num')
      .eq('meet_name', meetName)
      .range(offset, offset + PAGE_SIZE - 1);
    if (rErr) {
      return { success: false, reason: `Failed to fetch results: ${rErr.message}` };
    }
    allResults.push(...(batch || []));
    if (!batch || batch.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  // 3. Fetch all winners (paginated)
  const allWinners: Record<string, unknown>[] = [];
  offset = 0;
  while (true) {
    const { data: batch, error: wErr } = await supabase
      .from('winners')
      .select('state, meet_name, association, name, gym, session, level, division, event, score, is_tie')
      .eq('meet_name', meetName)
      .range(offset, offset + PAGE_SIZE - 1);
    if (wErr) {
      return { success: false, reason: `Failed to fetch winners: ${wErr.message}` };
    }
    allWinners.push(...(batch || []));
    if (!batch || batch.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  // 4. Write to local central DB in a transaction
  const centralPath = getCentralDbPath();
  const db = new Database(centralPath);
  try {
    // Ensure tables exist (same schema as finalize_meet)
    db.exec(`
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
      CREATE UNIQUE INDEX IF NOT EXISTS idx_results_unique
        ON results(meet_name, name, gym, session, level, division);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_winners_unique
        ON winners(meet_name, name, gym, session, level, division, event);
      CREATE TABLE IF NOT EXISTS meets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        meet_name TEXT UNIQUE, source TEXT, source_id TEXT, source_name TEXT,
        state TEXT, association TEXT, year TEXT, dates TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);

    const transaction = db.transaction(() => {
      // Delete existing data for this meet
      db.prepare('DELETE FROM results WHERE meet_name = ?').run(meetName);
      db.prepare('DELETE FROM winners WHERE meet_name = ?').run(meetName);
      db.prepare('DELETE FROM meets WHERE meet_name = ?').run(meetName);

      // Insert meet metadata
      db.prepare(
        `INSERT INTO meets (meet_name, source, source_id, source_name, state, association, year, dates)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(meetRow.meet_name, meetRow.source, meetRow.source_id, meetRow.source_name,
            meetRow.state, meetRow.association, meetRow.year, meetRow.dates);

      // Insert results
      const insertResult = db.prepare(
        `INSERT OR REPLACE INTO results (state, meet_name, association, name, gym, session, level, division,
         vault, bars, beam, floor, aa, rank, num)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const r of allResults) {
        insertResult.run(
          r.state, r.meet_name, r.association, r.name, r.gym || '',
          r.session, r.level, r.division,
          r.vault, r.bars, r.beam, r.floor, r.aa, r.rank, r.num
        );
      }

      // Insert winners
      const insertWinner = db.prepare(
        `INSERT OR REPLACE INTO winners (state, meet_name, association, name, gym, session, level, division,
         event, score, is_tie)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const w of allWinners) {
        insertWinner.run(
          w.state, w.meet_name, w.association, w.name, w.gym || '',
          w.session, w.level, w.division,
          w.event, w.score, w.is_tie ? 1 : 0
        );
      }
    });

    transaction();
  } finally {
    db.close();
  }

  console.log(`[supabase-sync] Pulled "${meetName}": ${allResults.length} results, ${allWinners.length} winners`);
  return { success: true, resultsCount: allResults.length, winnersCount: allWinners.length };
}
