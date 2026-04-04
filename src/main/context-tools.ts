/**
 * Context-aware tool implementations extracted from AgentLoop.
 * These tools need access to the agent context (meetName, loadedSkills, etc.)
 * but do not depend on the AgentLoop class itself.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { shell } from 'electron';
import { ToolResultContent, ImageContentPart, TextContentPart } from './llm-client';
import { pythonManager } from './python-manager';
import Database from 'better-sqlite3';
import { getStagingDbPath, getOrCreateStagingDbPath } from './tools/python-tools';
import { setDbToolsPhase } from './tools/db-tools';
import { getDataDir, getOutputDir, getProjectRoot } from './paths';
import { uploadMeetFiles } from './supabase-sync';
import { isSupabaseEnabled } from './supabase-client';
import { WorkflowPhase, getToolHomePhase, getAllPhases, getPhaseDefinition } from './workflow-phases';
import { requireString, requireArray, optionalString } from './tools/validation';

// --- Types ---

export interface AgentContext {
  meetName: string;
  outputName?: string;
  state?: string;
  systemPrompt: string;
  loadedSkills: string[];
  messages: import('./llm-client').LLMMessage[];
  totalInputTokens: number;
  totalOutputTokens: number;
  onActivity: (message: string, level: 'info' | 'success' | 'error' | 'warning') => void;
  abortRequested: boolean;
  logPath?: string;
  iterationCount: number;
  /** Index into messages[] up to which the process log has been written (for append-only logging). */
  lastLoggedMessageIndex?: number;
  /** Current workflow phase */
  currentPhase: WorkflowPhase;
  /** Tools temporarily unlocked from other phases */
  unlockedTools: string[];
  /** Set to true after an IDML import — prevents build_database from running */
  idmlImported?: boolean;
  /** Set to true after context pruning — forces the next end_turn to nudge instead of exit */
  justPruned?: boolean;
  /** Deadline dates — stored from tool args, auto-injected when agent omits them */
  postmarkDate?: string;
  onlineDate?: string;
  shipDate?: string;
  /** Meet IDs discovered by search_meets — extraction tools reject IDs not in this set */
  discoveredMeetIds?: string[];
  /** Set when search_meets returns non-empty results — gates Chrome tools in discovery */
  searchMeetsReturned?: boolean;
  /** Tracks search_meets call count */
  searchMeetsCallCount?: number;
  /** Set when build_database fails — blocks phase advancement to output_finalize/import_backs */
  buildDatabaseFailed?: boolean;
  /** Suspicious names detected by regenerate_output — gates subsequent regeneration */
  suspiciousNames?: Array<{ raw: string; cleaned: string }>;
  /** Division order — persisted and auto-injected on regenerate_output, like dates */
  divisionOrder?: string[];
}

export interface ProgressData {
  summary: string;
  next_steps: string;
  loaded_skills: string[];
  meet_name: string;
  timestamp: string;
  data_files?: Array<{ path: string; description: string }>;
  current_phase?: WorkflowPhase;
  idml_imported?: boolean;
  output_name?: string;
  state?: string;
  postmark_date?: string;
  online_date?: string;
  ship_date?: string;
  build_database_failed?: boolean;
  suspicious_names?: Array<{ raw: string; cleaned: string }>;
  discovered_meet_ids?: string[];
  division_order?: string[];
  search_meets_returned?: boolean;
}

// --- Helper functions ---

function getDbPath(): string {
  return path.join(getDataDir(), 'chp_results.db');
}

function getProgressFilePath(): string {
  return path.join(getDataDir(), 'agent_progress.json');
}

/** Delete the progress file if it exists. Called after successful finalize_meet. */
export function clearProgressFile(): void {
  const filePath = getProgressFilePath();
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (err) {
    console.warn(`Failed to clear progress file: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function getSkillsDir(): string {
  return path.join(getProjectRoot(), 'skills');
}

/**
 * Convert Windows paths to WSL paths when running under Linux/WSL.
 */
function convertWindowsPaths(input: string): string {
  if (process.platform === 'linux') {
    return input.replace(/([A-Za-z]):\\([\w\\. -]+)/g, (_match, drive, rest) => {
      return `/mnt/${drive.toLowerCase()}/${rest.replace(/\\/g, '/')}`;
    });
  }
  return input;
}

// Supabase credentials for Python gym alias loading (single source of truth)
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-client';
const SUPABASE_ENV = { SUPABASE_URL, SUPABASE_KEY: SUPABASE_ANON_KEY };

/**
 * Run process_meet.py with the given args and return stdout.
 */
async function runPython(
  argParts: string[],
  onActivity: (message: string, level: 'info' | 'success' | 'error' | 'warning') => void
): Promise<string> {
  const result = await pythonManager.runScript('process_meet.py', argParts, (line) => {
    onActivity(`[python] ${line}`, 'info');
  }, SUPABASE_ENV);

  if (result.exitCode !== 0) {
    return `Python script failed (exit code ${result.exitCode}).\nstdout: ${result.stdout}\nstderr: ${result.stderr}`;
  }
  return result.stdout || 'Script completed successfully (no output).';
}

// --- Phase management tools ---

export function toolSetPhase(
  phase: WorkflowPhase,
  reason: string,
  context: AgentContext
): string {
  const validPhases = getAllPhases();
  if (!validPhases.includes(phase)) {
    return `Error: Invalid phase "${phase}". Valid phases: ${validPhases.join(', ')}`;
  }

  // Block advancement past database if build_database failed
  if (context.buildDatabaseFailed && (phase === 'output_finalize' || phase === 'import_backs')) {
    return 'Error: Cannot advance — build_database has not completed successfully. Fix the build error and re-run build_database.';
  }

  // --- Phase transition precondition guards ---
  const warnings: string[] = [];
  const dataDir = getDataDir();

  // Hard block: database phase requires extraction data files
  if (phase === 'database') {
    const extractionFiles = fs.readdirSync(dataDir).filter(f =>
      f.endsWith('.json') && (f.startsWith('mso_extract') || f.startsWith('scorecat_extract') || f.startsWith('extract'))
    );
    if (extractionFiles.length === 0) {
      return 'Error: Cannot enter database phase — no extraction data files found. Complete extraction first.';
    }
    // Soft warn: no discovered meet IDs
    if (!context.discoveredMeetIds || context.discoveredMeetIds.length === 0) {
      warnings.push('Warning: No meet IDs were recorded during discovery. Proceeding anyway.');
    }
  }

  // Hard block: output_finalize requires staging DB
  if (phase === 'output_finalize') {
    if (!getStagingDbPath()) {
      return 'Error: Cannot enter output_finalize phase — no staging database found. Run build_database first.';
    }
  }

  // Hard block: import_backs requires staging DB
  if (phase === 'import_backs') {
    if (!getStagingDbPath()) {
      return 'Error: Cannot enter import_backs phase — no staging database found. Run build_database first.';
    }
  }

  // Soft warn: extraction phase without output name set
  if (phase === 'extraction' && !context.outputName) {
    warnings.push('Warning: Output name not set. Call set_output_name before extraction completes.');
  }

  const oldPhase = context.currentPhase;
  context.currentPhase = phase;
  context.unlockedTools = []; // Clear unlocked tools on phase change
  setDbToolsPhase(phase); // Keep db-tools aware of current phase for staging/central routing
  context.onActivity(`Phase: ${oldPhase} → ${phase} (${reason})`, 'info');

  const phaseDef = getPhaseDefinition(phase);
  let result = `Transitioned to phase: ${phase} — ${phaseDef.description}\n\nAvailable tools for this phase are now active. Previous unlocked tools have been cleared.`;
  if (warnings.length > 0) {
    result = warnings.join('\n') + '\n\n' + result;
  }
  return result;
}

export function toolUnlockTool(
  toolName: string,
  reason: string,
  context: AgentContext
): string {
  const homePhase = getToolHomePhase(toolName);
  if (homePhase === undefined) {
    return `Error: Tool "${toolName}" does not exist. Check the spelling and try again.`;
  }
  if (homePhase === null) {
    return `Tool "${toolName}" is already available in all phases.`;
  }

  if (context.unlockedTools.includes(toolName)) {
    return `Tool "${toolName}" is already unlocked.`;
  }

  context.unlockedTools.push(toolName);
  context.onActivity(`Unlocked tool: ${toolName} (${reason})`, 'info');
  return `Tool "${toolName}" (from ${homePhase} phase) is now available in the current phase.`;
}

// --- Split tool implementations ---

/**
 * build_database: Parse extracted data and build SQLite database.
 * Replaces run_python --source ... --data ... --state ... --meet ...
 */
export async function toolBuildDatabase(
  args: Record<string, unknown>,
  context: AgentContext
): Promise<string> {
  // Enforce outputName is set
  if (!context.outputName) {
    return 'Error: You must call set_output_name first to set a clean folder name before building the database.';
  }

  // Enforce IDML protection
  if (context.idmlImported) {
    return 'Error: Cannot run build_database after an IDML import — this would overwrite the designer\'s edits. Use regenerate_output for specific outputs instead.';
  }

  const source = requireString(args, 'source');
  const state = requireString(args, 'state');
  let meetName = requireString(args, 'meet_name');

  // Backfill context.state from tool args
  context.state = state;

  // Enforce name consistency: auto-override meet_name if it doesn't match outputName
  let nameWarning = '';
  if (context.outputName && meetName !== context.outputName) {
    nameWarning = `Note: meet_name "${meetName}" auto-corrected to match output name "${context.outputName}".\n`;
    meetName = context.outputName;
  }

  // data_path: single path or comma-separated paths for multi-source builds
  const rawDataPath = requireString(args, 'data_path');
  const dataPaths: string[] = rawDataPath.includes(',')
    ? rawDataPath.split(',').map(p => convertWindowsPaths(p.trim()))
    : [convertWindowsPaths(rawDataPath)];

  const argParts: string[] = [
    '--source', source,
    ...dataPaths.flatMap(p => ['--data', p]),
    '--state', state,
    '--meet', meetName,
  ];

  const association = optionalString(args, 'association');
  if (association) argParts.push('--association', association);
  if (args.year !== undefined && args.year !== null) argParts.push('--year', String(args.year));
  const gymMap = optionalString(args, 'gym_map');
  if (gymMap) argParts.push('--gym-map', convertWindowsPaths(gymMap));
  const stateAbbrev = optionalString(args, 'state_abbrev');
  if (stateAbbrev) argParts.push('--state-abbrev', stateAbbrev);
  // Division order — store on context and auto-inject from context when agent omits it
  const divisionOrderStr = optionalString(args, 'division_order');
  if (divisionOrderStr) {
    argParts.push('--division-order', divisionOrderStr);
    context.divisionOrder = divisionOrderStr.split(',').map(s => s.trim()).filter(Boolean);
  } else if (context.divisionOrder?.length) {
    argParts.push('--division-order', context.divisionOrder.join(','));
  }

  // Date params — store on context and auto-inject from context when agent omits them
  const postmarkDate = optionalString(args, 'postmark_date') || context.postmarkDate;
  if (postmarkDate) { argParts.push('--postmark-date', postmarkDate); context.postmarkDate = postmarkDate; }
  const onlineDate = optionalString(args, 'online_date') || context.onlineDate;
  if (onlineDate) { argParts.push('--online-date', onlineDate); context.onlineDate = onlineDate; }
  const shipDate = optionalString(args, 'ship_date') || context.shipDate;
  if (shipDate) { argParts.push('--ship-date', shipDate); context.shipDate = shipDate; }

  // Always use staging DB for full pipeline (getOrCreateStagingDbPath creates on first use)
  const stagingPath = getOrCreateStagingDbPath();
  argParts.push('--db', stagingPath);
  argParts.push('--output', getOutputDir(context.outputName));

  const result = await runPython(argParts, context.onActivity);

  // Check for build failure — block phase advancement until resolved
  if (result.includes('Python script failed')) {
    context.buildDatabaseFailed = true;
    return nameWarning ? nameWarning + result : result;
  }
  context.buildDatabaseFailed = false;

  // Populate meets metadata table in the staging DB (only after successful build)
  try {
    const sourceId = optionalString(args, 'source_id') || '';
    const sourceName = optionalString(args, 'source_name') || '';
    const meetDates = optionalString(args, 'meet_dates') || '';
    const yearStr = args.year !== undefined ? String(args.year) : '';
    if (fs.existsSync(stagingPath)) {
      const db = new Database(stagingPath);
      db.exec(`CREATE TABLE IF NOT EXISTS meets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        meet_name TEXT UNIQUE, source TEXT, source_id TEXT, source_name TEXT,
        state TEXT, association TEXT, year TEXT, dates TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )`);
      db.prepare(
        `INSERT OR REPLACE INTO meets (meet_name, source, source_id, source_name, state, association, year, dates)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(meetName, source, sourceId, sourceName, state, association || 'USAG', yearStr, meetDates);
      db.close();
    }
  } catch (err) {
    console.warn('toolBuildDatabase: meets metadata insert failed:', err instanceof Error ? err.message : String(err));
  }

  return nameWarning ? nameWarning + result : result;
}

/**
 * regenerate_output: Regenerate specific outputs from existing database.
 * Replaces run_python --regenerate ...
 */
export async function toolRegenerateOutput(
  args: Record<string, unknown>,
  context: AgentContext
): Promise<string> {
  const state = requireString(args, 'state');
  let meetName = requireString(args, 'meet_name');

  // Backfill context.state
  context.state = state;

  // Auto-correct meet_name to match outputName (prevent folder split)
  if (context.outputName && meetName !== context.outputName) {
    meetName = context.outputName;
  }

  const outputs = requireArray(args, 'outputs') as string[];

  // Guard: prevent regenerating shirt/all after IDML import (destroys designer edits)
  if (context.idmlImported && outputs.some(o => o === 'shirt' || o === 'all')) {
    return 'Error: Cannot regenerate shirt or all outputs after an IDML import — this would overwrite the designer\'s edits. Safe outputs after import: order_forms, gym_highlights, summary.';
  }

  const argParts: string[] = [
    '--state', state,
    '--meet', meetName,
    '--regenerate', outputs.join(','),
  ];

  // Layout params
  const layoutFlags: Array<[string, string]> = [
    ['line_spacing', '--line-spacing'],
    ['level_gap', '--level-gap'],
    ['max_fill', '--max-fill'],
    ['min_font_size', '--min-font-size'],
    ['max_font_size', '--max-font-size'],
    ['max_shirt_pages', '--max-shirt-pages'],
    ['level_groups', '--level-groups'],
    ['page_size_legal', '--page-size-legal'],
    ['exclude_levels', '--exclude-levels'],
    ['accent_color', '--accent-color'],
    ['font_family', '--font-family'],
    ['title1_size', '--title1-size'],
    ['title2_size', '--title2-size'],
    ['header_size', '--header-size'],
    ['divider_size', '--divider-size'],
    ['copyright', '--copyright'],
    ['sport', '--sport'],
    ['title_prefix', '--title-prefix'],
    ['name_sort', '--name-sort'],
    ['state_abbrev', '--state-abbrev'],
    ['gym_map', '--gym-map'],
  ];

  for (const [key, flag] of layoutFlags) {
    if (args[key] !== undefined && args[key] !== null) {
      const value = String(args[key]);
      if (key === 'page_size_legal') {
        // --page-size-legal uses nargs='*', so split comma-separated values into separate args
        argParts.push(flag, ...value.split(',').map(v => v.trim()).filter(Boolean));
      } else if (key === 'gym_map') {
        argParts.push(flag, convertWindowsPaths(value));
      } else {
        argParts.push(flag, value);
      }
    }
  }

  // Division order — store on context when provided, auto-inject when omitted
  const divisionOrderStr = optionalString(args, 'division_order');
  if (divisionOrderStr) {
    context.divisionOrder = divisionOrderStr.split(',').map(s => s.trim()).filter(Boolean);
    argParts.push('--division-order', divisionOrderStr);
  } else if (context.divisionOrder?.length && !argParts.includes('--division-order')) {
    argParts.push('--division-order', context.divisionOrder.join(','));
  }

  // Date params — auto-inject from context when agent omits them
  const postmarkDate = optionalString(args, 'postmark_date') || context.postmarkDate;
  if (postmarkDate) { argParts.push('--postmark-date', postmarkDate); context.postmarkDate = postmarkDate; }
  const onlineDate = optionalString(args, 'online_date') || context.onlineDate;
  if (onlineDate) { argParts.push('--online-date', onlineDate); context.onlineDate = onlineDate; }
  const shipDate = optionalString(args, 'ship_date') || context.shipDate;
  if (shipDate) { argParts.push('--ship-date', shipDate); context.shipDate = shipDate; }

  // Force flag
  if (args.force) argParts.push('--force');

  // Block if suspicious names were detected on a PREVIOUS call and not yet fixed
  if (context.suspiciousNames && context.suspiciousNames.length > 0) {
    const nameList = context.suspiciousNames.map(n =>
      `  { original: "${n.raw}", corrected: "${n.cleaned}" }`
    ).join('\n');
    return `Error: Regeneration blocked — suspicious names from previous run are unfixed.\n\nReview each name below. For each one, decide if the correction is right (event code suffixes like BB, VT should be removed, but be careful with names like "Cobb" that end in real letters).\n\nSuggested corrections:\n${nameList}\n\nUse the fix_names tool with your corrections array, then call regenerate_output again.`;
  }

  // Use staging DB if it exists on disk, otherwise central
  const stagingPath = getStagingDbPath();
  const centralPath = getDbPath();
  argParts.push('--db', stagingPath || centralPath);
  argParts.push('--output', getOutputDir(context.outputName || meetName));

  const result = await runPython(argParts, context.onActivity);

  // Parse SUSPICIOUS_NAMES_JSON from Python output — set gate for next call
  const jsonMatch = result.match(/SUSPICIOUS_NAMES_JSON:\s*(\[.*\])/);
  if (jsonMatch) {
    try {
      context.suspiciousNames = JSON.parse(jsonMatch[1]);
    } catch (err) {
      console.warn('[AGENT] suspiciousNames JSON parse failed:', err instanceof Error ? err.message : String(err));
    }
  } else {
    context.suspiciousNames = undefined;
  }

  // First detection: warn with fix commands but return the full result
  if (context.suspiciousNames && context.suspiciousNames.length > 0) {
    const nameList = context.suspiciousNames.map(n =>
      `  { original: "${n.raw}", corrected: "${n.cleaned}" }`
    ).join('\n');
    return result + `\n\nSUSPICIOUS_NAMES detected — these names have event code suffixes that will appear on the shirt.\nReview each name carefully (e.g., "Anna NicklowBB" should be "Anna Nicklow", but "Emily Cobb" should NOT be changed).\n\nSuggested corrections:\n${nameList}\n\nUse the fix_names tool with your corrections, then call regenerate_output again.`;
  }

  return result;
}

/**
 * import_pdf_backs: Import designer-edited PDF backs from InDesign.
 * Accepts any number of PDFs. System auto-detects letter vs legal from page size.
 * For order forms, legal pages are scaled to letter unless a letter equivalent exists.
 */
export async function toolImportPdfBacks(
  args: Record<string, unknown>,
  context: AgentContext
): Promise<string> {
  const pdfPaths = requireArray(args, 'pdf_paths') as string[];
  const state = requireString(args, 'state');
  let meetName = requireString(args, 'meet_name');

  // Backfill context.state
  context.state = state;

  // Auto-correct meet_name to match outputName (prevent folder split)
  if (context.outputName && meetName !== context.outputName) {
    console.log(`[AGENT] import_pdf_backs meet_name "${meetName}" auto-corrected to "${context.outputName}"`);
    meetName = context.outputName;
  }

  if (pdfPaths.length === 0) {
    return 'Error: pdf_paths must contain at least one PDF file path.';
  }

  // Set output name from meet_name
  context.outputName = meetName;

  // Convert all paths and pass as repeated --import-pdf args
  const argParts: string[] = [];
  for (const p of pdfPaths) {
    argParts.push('--import-pdf', convertWindowsPaths(p));
  }

  argParts.push('--state', state);
  argParts.push('--meet', meetName);

  // Date params — auto-inject from context when agent omits them
  const postmarkDate = optionalString(args, 'postmark_date') || context.postmarkDate;
  if (postmarkDate) { argParts.push('--postmark-date', postmarkDate); context.postmarkDate = postmarkDate; }
  const onlineDate = optionalString(args, 'online_date') || context.onlineDate;
  if (onlineDate) { argParts.push('--online-date', onlineDate); context.onlineDate = onlineDate; }
  const shipDate = optionalString(args, 'ship_date') || context.shipDate;
  if (shipDate) { argParts.push('--ship-date', shipDate); context.shipDate = shipDate; }

  // DB: use staging DB if it exists on disk, otherwise central
  const stagingPath = getStagingDbPath();
  const centralPath = getDbPath();
  argParts.push('--db', stagingPath || centralPath);
  argParts.push('--output', getOutputDir(meetName));

  const result = await runPython(argParts, context.onActivity);

  // Set import protection flag — only on success (failed import shouldn't permanently block)
  if (!result.includes('Python script failed') && !result.includes('Error:')) {
    context.idmlImported = true;
  }

  // Re-upload updated files to Supabase Storage (non-blocking)
  if (isSupabaseEnabled() && meetName) {
    try {
      const fileResult = await uploadMeetFiles(meetName);
      if (fileResult.uploaded.length > 0) {
        return result + ` Re-uploaded ${fileResult.uploaded.length} files to cloud.`;
      }
    } catch (err) {
      console.warn('[import_pdf_backs] Cloud re-upload failed:', err);
    }
  }

  return result;
}

// --- Existing tool implementations ---

export async function toolRenderPdfPage(
  pdfPath: string | undefined,
  pageNumber: number | undefined,
  meetName: string
): Promise<ToolResultContent> {
  const page = pageNumber ?? 1;
  const resolvedPath = pdfPath || path.join(getOutputDir(meetName), 'back_of_shirt.pdf');

  if (!fs.existsSync(resolvedPath)) {
    return `Error: PDF file not found at ${resolvedPath}. Generate the PDF first with regenerate_output.`;
  }

  try {
    const result = await pythonManager.runScript(
      'process_meet.py',
      ['--render-pdf', resolvedPath, String(page)],
      undefined,
      undefined,
      30000
    );

    if (result.exitCode !== 0 || !result.stdout.trim()) {
      return `Error rendering PDF page: ${result.stderr || result.stdout || 'No output from Python'}`;
    }

    const base64Data = result.stdout.trim();
    const textPart: TextContentPart = {
      type: 'text',
      text: `Rendered page ${page} of ${resolvedPath} (200 DPI). Inspect the layout — if adjustments are needed, use regenerate_output with adjusted layout parameters.`,
    };
    const imagePart: ImageContentPart = {
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: base64Data,
      },
    };

    return [textPart, imagePart];
  } catch (err) {
    return `Error rendering PDF page: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function toolOpenFile(filePath: string, meetName: string): Promise<string> {
  let resolvedPath = filePath;
  if (!path.isAbsolute(filePath)) {
    resolvedPath = path.join(getOutputDir(meetName, false), filePath);
  }

  if (!fs.existsSync(resolvedPath)) {
    return `Error: File not found at ${resolvedPath}`;
  }

  // On WSL, convert to Windows path for shell.openPath
  let openPath = resolvedPath;
  if (process.platform === 'linux' && resolvedPath.startsWith('/')) {
    try {
      const winPath = execFileSync('wslpath', ['-w', resolvedPath], { encoding: 'utf-8' }).trim();
      if (winPath) openPath = winPath;
    } catch {
      // Fall through with Linux path
    }
  }

  try {
    const errorMessage = await shell.openPath(openPath);
    if (errorMessage) {
      return `Error opening file: ${errorMessage}`;
    }
    return `Opened ${path.basename(resolvedPath)} in the user's default application. Wait a few seconds for them to review it before asking for feedback.`;
  } catch (err) {
    return `Error opening file: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function toolListOutputFiles(meetName: string): Promise<string> {
  const dir = getOutputDir(meetName, false);
  if (!fs.existsSync(dir)) {
    return 'Output directory does not exist yet.';
  }

  const files = fs.readdirSync(dir);
  if (files.length === 0) {
    return 'Output directory is empty.';
  }

  const lines = files.map((f) => {
    const stats = fs.statSync(path.join(dir, f));
    const sizeKB = (stats.size / 1024).toFixed(1);
    return `  ${f} (${sizeKB} KB)`;
  });
  return `Files in ${dir}:\n${lines.join('\n')}`;
}

export async function toolListSkills(): Promise<string> {
  const skillsDir = getSkillsDir();
  if (!fs.existsSync(skillsDir)) {
    return 'No skills directory found.';
  }

  const files = fs.readdirSync(skillsDir)
    .filter(f => f.endsWith('.md') && fs.statSync(path.join(skillsDir, f)).isFile())
    .map(f => f.replace(/\.md$/, ''));

  if (files.length === 0) return 'No skills available.';
  return `Available skills: ${files.join(', ')}`;
}

export async function toolLoadSkill(skillName: string, context: AgentContext): Promise<string> {
  if (!/^[a-zA-Z0-9_-]+$/.test(skillName)) {
    return 'Error: invalid skill name.';
  }
  if (context.loadedSkills.includes(skillName)) {
    return `Skill "${skillName}" is already loaded.`;
  }

  const skillPath = path.join(getSkillsDir(), `${skillName}.md`);
  if (!fs.existsSync(skillPath)) {
    return `Error: Skill "${skillName}" not found at ${skillPath}. Available skills can be found in the skills/ directory.`;
  }

  const content = fs.readFileSync(skillPath, 'utf-8');
  context.loadedSkills.push(skillName);

  return `--- Skill: ${skillName} ---\n\n${content}`;
}

export async function toolSaveProgress(
  context: AgentContext,
  summary: string,
  nextSteps: string,
  dataFilesJson?: string
): Promise<string> {
  let dataFiles: Array<{ path: string; description: string }> | undefined;
  if (dataFilesJson) {
    try {
      dataFiles = JSON.parse(dataFilesJson);
    } catch {
      // Ignore parse errors — data_files is optional
    }
  }

  const progressData: ProgressData = {
    summary,
    next_steps: nextSteps,
    loaded_skills: context.loadedSkills,
    meet_name: context.meetName,
    timestamp: new Date().toISOString(),
    data_files: dataFiles,
    current_phase: context.currentPhase,
    idml_imported: context.idmlImported || undefined,
    output_name: context.outputName,
    state: context.state,
    postmark_date: context.postmarkDate,
    online_date: context.onlineDate,
    ship_date: context.shipDate,
    build_database_failed: context.buildDatabaseFailed || undefined,
    suspicious_names: context.suspiciousNames?.length ? context.suspiciousNames : undefined,
    discovered_meet_ids: context.discoveredMeetIds?.length ? context.discoveredMeetIds : undefined,
    division_order: context.divisionOrder?.length ? context.divisionOrder : undefined,
    search_meets_returned: context.searchMeetsReturned || undefined,
  };

  const filePath = getProgressFilePath();
  fs.writeFileSync(filePath, JSON.stringify(progressData, null, 2), 'utf-8');
  return `Progress saved to ${filePath}`;
}

export async function toolLoadProgress(): Promise<string> {
  const filePath = getProgressFilePath();
  if (!fs.existsSync(filePath)) {
    return 'No saved progress found.';
  }

  const data = fs.readFileSync(filePath, 'utf-8');
  return `Saved progress:\n${data}`;
}

/**
 * Load progress from a previous invocation.
 */
export async function loadProgressData(): Promise<ProgressData | null> {
  const filePath = getProgressFilePath();
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as ProgressData;
  } catch {
    return null;
  }
}

/**
 * Auto-save progress when approaching context limit.
 */
export async function autoSaveProgress(
  context: AgentContext,
  summary: string,
  nextSteps: string
): Promise<void> {
  const progressData: ProgressData = {
    summary,
    next_steps: nextSteps,
    loaded_skills: context.loadedSkills,
    meet_name: context.meetName,
    timestamp: new Date().toISOString(),
    current_phase: context.currentPhase,
    idml_imported: context.idmlImported || undefined,
    output_name: context.outputName,
    state: context.state,
    postmark_date: context.postmarkDate,
    online_date: context.onlineDate,
    ship_date: context.shipDate,
    build_database_failed: context.buildDatabaseFailed || undefined,
    suspicious_names: context.suspiciousNames?.length ? context.suspiciousNames : undefined,
    discovered_meet_ids: context.discoveredMeetIds?.length ? context.discoveredMeetIds : undefined,
    division_order: context.divisionOrder?.length ? context.divisionOrder : undefined,
    search_meets_returned: context.searchMeetsReturned || undefined,
  };

  const filePath = getProgressFilePath();
  fs.writeFileSync(filePath, JSON.stringify(progressData, null, 2), 'utf-8');
  context.onActivity(`Progress auto-saved to ${filePath}`, 'info');
}
