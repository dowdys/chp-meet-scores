/**
 * Context-aware tool implementations extracted from AgentLoop.
 * These tools need access to the agent context (meetName, loadedSkills, etc.)
 * but do not depend on the AgentLoop class itself.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { shell } from 'electron';
import Database from 'better-sqlite3';
import { ToolResultContent, ImageContentPart, TextContentPart } from './llm-client';
import { pythonManager } from './python-manager';
import { getStagingDbPath } from './tools/python-tools';
import { getDataDir, getOutputDir, getProjectRoot } from './paths';

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
}

export interface ProgressData {
  summary: string;
  next_steps: string;
  loaded_skills: string[];
  meet_name: string;
  timestamp: string;
  data_files?: Array<{ path: string; description: string }>;
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

// --- Tool implementations ---

export async function toolRunPython(
  meetName: string,
  args: string,
  context: { outputName?: string },
  onActivity: (message: string, level: 'info' | 'success' | 'error' | 'warning') => void
): Promise<string> {
  // Convert Windows paths to WSL paths only when running under WSL/Linux.
  if (process.platform === 'linux') {
    args = args.replace(/([A-Za-z]):\\([\w\\. -]+)/g, (_match, drive, rest) => {
      return `/mnt/${drive.toLowerCase()}/${rest.replace(/\\/g, '/')}`;
    });
  }

  // Split args respecting quoted strings
  const argParts = (args.match(/(?:[^\s"]+|"[^"]*")+/g) || [])
    .map(a => a.replace(/^"(.*)"$/, '$1'));

  // ALWAYS enforce --db and --output to the correct paths.
  const stripFlags = ['--db', '--output'];
  for (const flag of stripFlags) {
    const idx = argParts.indexOf(flag);
    if (idx !== -1) {
      argParts.splice(idx, 2);
    }
  }

  // Check if this is an --import-idml call
  const importIdx = argParts.indexOf('--import-idml');
  if (importIdx !== -1 && importIdx + 1 < argParts.length) {
    // IDML import mode: pre-read metadata to get meet name, use central DB
    const idmlPath = argParts[importIdx + 1];
    let outputMeetName = 'IDML Import';

    // Extract metadata from IDML to identify the meet
    const dataDir = getDataDir();
    const metaScriptPath = path.join(dataDir, `tmp_idml_meta_${Date.now()}.py`);
    const metaCode = [
      'import zipfile, json, os, sys',
      'from xml.etree import ElementTree as ET',
      'idml_path = os.environ.get("IDML_PATH", "")',
      'meta = {}',
      'try:',
      '    with zipfile.ZipFile(idml_path, "r") as zf:',
      '        for name in zf.namelist():',
      '            if name.startswith("Stories/") and name.endswith(".xml"):',
      '                xml = zf.read(name).decode("utf-8")',
      '                if "CHP_METADATA" in xml:',
      '                    root = ET.fromstring(xml)',
      '                    for c in root.iter("Content"):',
      '                        t = c.text or ""',
      '                        if t.startswith("CHP_METADATA:"):',
      '                            meta = json.loads(t[len("CHP_METADATA:"):])',
      '                            break',
      '                    if meta: break',
      'except Exception:',
      '    pass',
      'print(json.dumps(meta))',
    ].join('\n');
    fs.writeFileSync(metaScriptPath, metaCode, 'utf8');

    try {
      const metaResult = await pythonManager.runScript(
        'process_meet.py',
        ['--exec-script', metaScriptPath],
        undefined,
        { IDML_PATH: idmlPath },
        10000
      );
      const metaJson = JSON.parse(metaResult.stdout.trim() || '{}');
      if (metaJson.meet_name) {
        outputMeetName = metaJson.meet_name;
        context.outputName = outputMeetName;
        onActivity(`IDML metadata: meet="${metaJson.meet_name}", state="${metaJson.state || '?'}"`, 'info');
      } else {
        onActivity('No embedded metadata found in IDML — using fallback folder', 'warning');
      }
    } catch {
      onActivity('Could not read IDML metadata — using fallback folder', 'warning');
    }

    try { fs.unlinkSync(metaScriptPath); } catch { /* ignore */ }

    // Prefer central DB, but fall back to staging DB if central doesn't have this meet.
    let dbPathForImport = getDbPath();
    const centralExists = fs.existsSync(dbPathForImport);
    let centralHasMeet = false;
    if (centralExists) {
      try {
        const checkDb = new Database(dbPathForImport, { readonly: true });
        const row = checkDb.prepare('SELECT COUNT(*) as cnt FROM winners WHERE meet_name = ?').get(outputMeetName) as { cnt: number } | undefined;
        centralHasMeet = (row?.cnt ?? 0) > 0;
        checkDb.close();
      } catch { /* table might not exist */ }
    }
    if (!centralHasMeet) {
      const dataDir = getDataDir();
      const stagingFiles = fs.readdirSync(dataDir)
        .filter(f => f.startsWith('staging_') && f.endsWith('.db'))
        .sort()
        .reverse();
      for (const sf of stagingFiles) {
        const sfPath = path.join(dataDir, sf);
        try {
          const sDb = new Database(sfPath, { readonly: true });
          const row = sDb.prepare('SELECT COUNT(*) as cnt FROM winners WHERE meet_name = ?').get(outputMeetName) as { cnt: number } | undefined;
          sDb.close();
          if ((row?.cnt ?? 0) > 0) {
            dbPathForImport = sfPath;
            onActivity(`Using staging DB for import: ${sf}`, 'info');
            break;
          }
        } catch { /* skip unreadable DBs */ }
      }
    }
    argParts.push('--db', dbPathForImport);
    argParts.push('--output', getOutputDir(outputMeetName));
  } else {
    // Check if --regenerate is in args — use central DB for regeneration
    const isRegenerate = argParts.includes('--regenerate');
    const outputMeetName = meetName;
    if (isRegenerate) {
      const stagingPath = getStagingDbPath();
      const centralPath = getDbPath();
      argParts.push('--db', (fs.existsSync(stagingPath) ? stagingPath : centralPath));
    } else {
      argParts.push('--db', getStagingDbPath());
    }
    argParts.push('--output', getOutputDir(outputMeetName));
  }

  const result = await pythonManager.runScript('process_meet.py', argParts, (line) => {
    onActivity(`[python] ${line}`, 'info');
  });

  if (result.exitCode !== 0) {
    return `Python script failed (exit code ${result.exitCode}).\nstdout: ${result.stdout}\nstderr: ${result.stderr}`;
  }
  return result.stdout || 'Script completed successfully (no output).';
}

export async function toolRenderPdfPage(
  pdfPath: string | undefined,
  pageNumber: number | undefined,
  meetName: string
): Promise<ToolResultContent> {
  const page = pageNumber ?? 1;
  const resolvedPath = pdfPath || path.join(getOutputDir(meetName), 'back_of_shirt.pdf');

  if (!fs.existsSync(resolvedPath)) {
    return `Error: PDF file not found at ${resolvedPath}. Generate the PDF first with run_python.`;
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
      text: `Rendered page ${page} of ${resolvedPath} (200 DPI). Inspect the layout — if names are too small, spacing too tight/loose, or the page is too full/empty, re-run run_python with adjusted --line-spacing, --level-gap, --max-fill, or --min-font-size values.`,
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
  const dir = getOutputDir(meetName);
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

export async function toolLoadSkillDetail(detailName: string, context: AgentContext): Promise<string> {
  if (!/^[a-zA-Z0-9_-]+$/.test(detailName)) {
    return 'Error: invalid skill name.';
  }
  const detailKey = `details/${detailName}`;
  if (context.loadedSkills.includes(detailKey)) {
    return `Detail skill "${detailName}" is already loaded.`;
  }

  const detailPath = path.join(getSkillsDir(), 'details', `${detailName}.md`);
  if (!fs.existsSync(detailPath)) {
    return `Error: Detail skill "${detailName}" not found at ${detailPath}.`;
  }

  const content = fs.readFileSync(detailPath, 'utf-8');
  context.loadedSkills.push(detailKey);

  return `--- Detail Skill: ${detailName} ---\n\n${content}`;
}

export async function toolSaveDraftSkill(platformName: string, content: string): Promise<string> {
  const draftsDir = path.join(getSkillsDir(), 'drafts');
  if (!fs.existsSync(draftsDir)) {
    fs.mkdirSync(draftsDir, { recursive: true });
  }

  const filePath = path.join(draftsDir, `${platformName}.md`);
  const resolvedDraft = path.resolve(filePath);
  if (!resolvedDraft.startsWith(path.resolve(draftsDir))) {
    return 'Error: platform name must not escape the drafts directory.';
  }
  fs.writeFileSync(filePath, content, 'utf-8');
  return `Draft skill saved to ${filePath}`;
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
  };

  const filePath = getProgressFilePath();
  fs.writeFileSync(filePath, JSON.stringify(progressData, null, 2), 'utf-8');
  context.onActivity(`Progress auto-saved to ${filePath}`, 'info');
}
