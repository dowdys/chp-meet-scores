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
import { getStagingDbPath } from './tools/python-tools';
import { setDbToolsPhase } from './tools/db-tools';
import { getDataDir, getOutputDir, getProjectRoot } from './paths';
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
  /** Set when search_meets finds a clear match — gates discovery tools */
  discoveryMatchFound?: boolean;
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
}

// --- Helper functions ---

function getDbPath(): string {
  return path.join(getDataDir(), 'chp_results.db');
}

function getProgressFilePath(): string {
  return path.join(getDataDir(), 'agent_progress.json');
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

/**
 * Run process_meet.py with the given args and return stdout.
 */
async function runPython(
  argParts: string[],
  onActivity: (message: string, level: 'info' | 'success' | 'error' | 'warning') => void
): Promise<string> {
  const result = await pythonManager.runScript('process_meet.py', argParts, (line) => {
    onActivity(`[python] ${line}`, 'info');
  });

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

  const oldPhase = context.currentPhase;
  context.currentPhase = phase;
  context.unlockedTools = []; // Clear unlocked tools on phase change
  setDbToolsPhase(phase); // Keep db-tools aware of current phase for staging/central routing
  context.onActivity(`Phase: ${oldPhase} → ${phase} (${reason})`, 'info');

  const phaseDef = getPhaseDefinition(phase);
  return `Transitioned to phase: ${phase} — ${phaseDef.description}\n\nAvailable tools for this phase are now active. Previous unlocked tools have been cleared.`;
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
  const divisionOrder = optionalString(args, 'division_order');
  if (divisionOrder) argParts.push('--division-order', divisionOrder);

  // Date params — store on context and auto-inject from context when agent omits them
  const postmarkDate = optionalString(args, 'postmark_date') || context.postmarkDate;
  if (postmarkDate) { argParts.push('--postmark-date', postmarkDate); context.postmarkDate = postmarkDate; }
  const onlineDate = optionalString(args, 'online_date') || context.onlineDate;
  if (onlineDate) { argParts.push('--online-date', onlineDate); context.onlineDate = onlineDate; }
  const shipDate = optionalString(args, 'ship_date') || context.shipDate;
  if (shipDate) { argParts.push('--ship-date', shipDate); context.shipDate = shipDate; }

  // Always use staging DB for full pipeline
  const stagingPath = getStagingDbPath();
  argParts.push('--db', stagingPath);
  argParts.push('--output', getOutputDir(context.outputName));

  const result = await runPython(argParts, context.onActivity);

  // Populate meets metadata table in the staging DB
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
    // Non-fatal but log it — silent failure here causes metadata loss during finalize
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
    ['division_order', '--division-order'],
    ['name_sort', '--name-sort'],
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

  // Date params — auto-inject from context when agent omits them
  const postmarkDate = optionalString(args, 'postmark_date') || context.postmarkDate;
  if (postmarkDate) { argParts.push('--postmark-date', postmarkDate); context.postmarkDate = postmarkDate; }
  const onlineDate = optionalString(args, 'online_date') || context.onlineDate;
  if (onlineDate) { argParts.push('--online-date', onlineDate); context.onlineDate = onlineDate; }
  const shipDate = optionalString(args, 'ship_date') || context.shipDate;
  if (shipDate) { argParts.push('--ship-date', shipDate); context.shipDate = shipDate; }

  // Force flag
  if (args.force) argParts.push('--force');

  // Use staging DB if available, otherwise central
  const stagingPath = getStagingDbPath();
  const centralPath = getDbPath();
  argParts.push('--db', fs.existsSync(stagingPath) ? stagingPath : centralPath);
  argParts.push('--output', getOutputDir(context.outputName || meetName));

  return runPython(argParts, context.onActivity);
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
  const meetName = requireString(args, 'meet_name');

  // Backfill context.state
  context.state = state;

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

  // DB: use staging DB if it exists (meet not yet finalized), otherwise central
  const stagingPath = getStagingDbPath();
  const centralPath = getDbPath();
  const dbPath = fs.existsSync(stagingPath) ? stagingPath : centralPath;
  argParts.push('--db', dbPath);
  argParts.push('--output', getOutputDir(meetName));

  const result = await runPython(argParts, context.onActivity);

  // Set import protection flag
  context.idmlImported = true;

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
  };

  const filePath = getProgressFilePath();
  fs.writeFileSync(filePath, JSON.stringify(progressData, null, 2), 'utf-8');
  context.onActivity(`Progress auto-saved to ${filePath}`, 'info');
}
