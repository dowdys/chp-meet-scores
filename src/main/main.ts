import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { execFileSync } from 'child_process';
import { chromeController } from './chrome-controller';
import { configStore } from './config-store';
import { LLMClient } from './llm-client';
import { AgentLoop } from './agent-loop';
import { allToolExecutors, setAskUserHandler } from './tools/index';
import { resetStagingDb } from './tools/python-tools';
import { getDataDir } from './paths';
import { autoUpdater } from 'electron-updater';

let mainWindow: BrowserWindow | null = null;
let activeAgentLoop: AgentLoop | null = null;
let agentRunning = false;

// Single instance lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'Gymnastics Meet Scores',
  });
  // Show maximized for best usability (especially on high-DPI displays)
  mainWindow.maximize();
  mainWindow.show();

  // Load the built renderer HTML
  if (process.env.WEBPACK_DEV_SERVER === 'true') {
    mainWindow.loadURL('http://localhost:9000');
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Supabase auth token refresh lifecycle (required for non-browser environments)
  import('./supabase-client').then(({ setupAutoRefreshLifecycle }) => {
    if (mainWindow) setupAutoRefreshLifecycle(mainWindow);
  }).catch(() => { /* supabase-client may fail to load in some envs */ });
}

function sendActivityLog(message: string, level: 'info' | 'success' | 'error' | 'warning' = 'info'): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('activity-log', {
      timestamp: new Date().toISOString(),
      message,
      level,
    });
  }
}

/**
 * Ask the user to choose from a list of options.
 * Sends an IPC event to the renderer and waits for the response.
 */
function askUserForChoice(question: string, options: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      resolve(options[0] || 'No window available');
      return;
    }

    const cleanup = () => {
      ipcMain.removeListener('user-choice-response', handler);
      if (mainWindow) {
        mainWindow.removeListener('closed', onWindowClosed);
      }
    };

    const onWindowClosed = () => {
      cleanup();
      reject(new Error('Window closed'));
    };

    // Listen for the user's response (one-time)
    const handler = (_event: Electron.IpcMainEvent, response: { choice: string }) => {
      cleanup();
      resolve(response.choice);
    };
    ipcMain.on('user-choice-response', handler);
    mainWindow.on('closed', onWindowClosed);

    // Send the question to the renderer
    mainWindow.webContents.send('ask-user', { question, options });

    sendActivityLog(`Waiting for your input...`, 'warning');
  });
}

// Wire up the ask_user tool to the IPC bridge
setAskUserHandler(askUserForChoice);

/**
 * Create an LLMClient from the current settings.
 */
function createLLMClient(): LLMClient {
  const settings = configStore.getAll();

  if (settings.apiProvider !== 'subscription' && !settings.apiKey) {
    throw new Error('API key is not configured. Please set it in Settings, or use Claude Subscription mode.');
  }

  return new LLMClient({
    provider: settings.apiProvider,
    apiKey: settings.apiKey,
    model: settings.model,
  });
}

/**
 * Get or create the agent loop, reusing it for query conversation persistence.
 */
function getOrCreateAgentLoop(): AgentLoop {
  if (!activeAgentLoop) {
    const llmClient = createLLMClient();
    activeAgentLoop = new AgentLoop(llmClient, allToolExecutors, sendActivityLog);
  }
  return activeAgentLoop;
}

// IPC Handlers
function setupIPC(): void {
  // Process a meet
  ipcMain.handle('process-meet', async (_event, meetName: string) => {
    try {
      sendActivityLog(`Starting to process meet: ${meetName}`);

      // Check for saved progress — ask user before resuming
      const dataDir = getDataDir();
      const progressFile = path.join(dataDir, 'agent_progress.json');

      if (fs.existsSync(progressFile)) {
        try {
          const raw = fs.readFileSync(progressFile, 'utf-8');
          const progress = JSON.parse(raw);
          if (progress.meet_name === meetName) {
            const timestamp = progress.timestamp
              ? new Date(progress.timestamp).toLocaleString()
              : 'unknown time';
            const choice = await askUserForChoice(
              `Found saved progress for "${meetName}" from ${timestamp}.\n\nResume where you left off, or start fresh?`,
              ['Resume previous run', 'Start fresh (discard old progress)']
            );
            if (choice.includes('fresh') || choice.includes('Fresh')) {
              fs.unlinkSync(progressFile);
              sendActivityLog('Previous progress discarded. Starting fresh.', 'info');
            } else {
              sendActivityLog('Resuming from saved progress.', 'info');
            }
          }
        } catch {
          // If progress file is corrupt, just delete it
          try { fs.unlinkSync(progressFile); } catch { /* ignore */ }
        }
      }

      const llmClient = createLLMClient();
      const agentLoop = new AgentLoop(llmClient, allToolExecutors, sendActivityLog);
      // Store as the active loop so query tab can reuse it
      activeAgentLoop = agentLoop;
      agentRunning = true;

      const result = await agentLoop.processMeet(meetName);
      agentRunning = false;

      // Notify renderer that a meet finished processing
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('meet-processed', { meetName: result.outputName || meetName });
      }

      if (result.success) {
        sendActivityLog(`Meet "${meetName}" processing completed.`, 'success');
      } else {
        sendActivityLog(`Meet "${meetName}" processing failed: ${result.message}`, 'error');
      }

      return { success: result.success, message: result.message, outputName: result.outputName };
    } catch (err) {
      agentRunning = false;
      const message = err instanceof Error ? err.message : String(err);
      sendActivityLog(`Error: ${message}`, 'error');
      return { success: false, error: message };
    }
  });

  // Continue conversation after processing completes
  ipcMain.handle('continue-conversation', async (_event, message: string) => {
    if (!activeAgentLoop) {
      return { success: false, error: 'No previous conversation to continue.' };
    }
    try {
      sendActivityLog(`Continuing conversation...`, 'info');

      // Re-attach activity log listener for this continuation
      const result = await activeAgentLoop.continueConversation(message);

      if (result.success) {
        sendActivityLog('Follow-up complete.', 'success');
      } else {
        sendActivityLog(`Follow-up failed: ${result.message}`, 'error');
      }

      return { success: result.success, message: result.message };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      sendActivityLog(`Error: ${errMsg}`, 'error');
      return { success: false, error: errMsg };
    }
  });

  // Stop a running agent
  ipcMain.handle('agent:stop-request', async () => {
    if (activeAgentLoop) {
      activeAgentLoop.requestStop();
      sendActivityLog('Stop request sent to agent.', 'warning');
      return { success: true };
    }
    return { success: false, error: 'No active agent to stop' };
  });

  // Query results
  ipcMain.handle('query-results', async (_event, question: string) => {
    try {
      sendActivityLog(`Query: ${question}`, 'info');

      const agentLoop = getOrCreateAgentLoop();
      const result = await agentLoop.queryResults(question);

      if (result.success) {
        return { success: true, answer: result.answer };
      } else {
        return { success: false, error: result.answer };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });

  // Get settings
  ipcMain.handle('get-settings', async () => {
    return configStore.getAll();
  });

  // Save settings
  ipcMain.handle('save-settings', async (_event, settings: Partial<import('./config-store').AppConfig>) => {
    try {
      configStore.setAll(settings);
      // Reset agent loop so it picks up new settings
      activeAgentLoop = null;
      // Reset Supabase client so it picks up new credentials
      const { resetSupabaseClient } = await import('./supabase-client');
      resetSupabaseClient();
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });

  // Test Supabase connection
  ipcMain.handle('test-supabase-connection', async () => {
    const { testConnection } = await import('./supabase-client');
    return testConnection();
  });

  // List all meets in the central Supabase database
  ipcMain.handle('list-cloud-meets', async () => {
    try {
      const { getSupabaseClient } = await import('./supabase-client');
      const supabase = await getSupabaseClient();
      if (!supabase) return { success: false, error: 'Supabase not available' };
      const { data, error } = await supabase
        .from('meets')
        .select('meet_name, state, year, association, source, dates, version, athlete_count, winner_count, published_at, published_by')
        .order('published_at', { ascending: false });
      if (error) return { success: false, error: error.message };
      return { success: true, meets: data };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Get files for a specific cloud meet
  ipcMain.handle('get-cloud-meet-files', async (_event, meetName: string) => {
    try {
      const { getSupabaseClient } = await import('./supabase-client');
      const supabase = await getSupabaseClient();
      if (!supabase) return { success: false, error: 'Supabase not available' };
      const { data, error } = await supabase
        .from('meet_files')
        .select('filename, storage_path, file_size, uploaded_at')
        .eq('meet_name', meetName)
        .order('filename');
      if (error) return { success: false, error: error.message };
      return { success: true, files: data };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Download a file from Supabase Storage to the local output directory
  ipcMain.handle('download-cloud-file', async (_event, meetName: string, storagePath: string, filename: string) => {
    try {
      const { getSupabaseClient } = await import('./supabase-client');
      const { getOutputDir, assertSafeMeetName, assertSafeFilename } = await import('./paths');
      assertSafeMeetName(meetName);
      assertSafeFilename(filename);
      const supabase = await getSupabaseClient();
      if (!supabase) return { success: false, error: 'Supabase not available' };
      const { data, error } = await supabase.storage
        .from('meet-documents')
        .download(storagePath);
      if (error) return { success: false, error: error.message };
      if (!data) return { success: false, error: 'No data returned' };
      const buffer = Buffer.from(await data.arrayBuffer());
      const outputDir = getOutputDir(meetName);
      const localPath = path.join(outputDir, filename);
      fs.writeFileSync(localPath, buffer);
      return { success: true, localPath };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Pull a published meet's data from Supabase into the local database
  ipcMain.handle('pull-cloud-meet', async (_event, meetName: string) => {
    try {
      const { pullMeetData } = await import('./supabase-sync');
      const result = await pullMeetData(meetName);
      return result;
    } catch (err) {
      return { success: false, reason: err instanceof Error ? err.message : String(err) };
    }
  });

  // List all meets from local filesystem + cloud, merged into a unified list
  ipcMain.handle('list-unified-meets', async () => {
    try {
      const { getOutputBase, RECOGNIZED_OUTPUT_FILES } = await import('./paths');
      const outputBase = getOutputBase();

      // Scan local meets
      type LocalMeet = { meet_name: string; fileCount: number; modified: string };
      const localMeets: LocalMeet[] = [];
      if (fs.existsSync(outputBase)) {
        const entries = fs.readdirSync(outputBase, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const meetDir = path.join(outputBase, entry.name);
          const files = fs.readdirSync(meetDir);
          const recognized = files.filter((f: string) => RECOGNIZED_OUTPUT_FILES.includes(f));
          if (recognized.length === 0) continue;
          // Get most recent modification time
          let latestMtime = 0;
          for (const f of recognized) {
            try {
              const stat = fs.statSync(path.join(meetDir, f));
              if (stat.mtimeMs > latestMtime) latestMtime = stat.mtimeMs;
            } catch { /* skip files we can't stat */ }
          }
          localMeets.push({
            meet_name: entry.name,
            fileCount: recognized.length,
            modified: latestMtime ? new Date(latestMtime).toISOString() : new Date().toISOString(),
          });
        }
      }

      // Fetch cloud meets (if Supabase enabled)
      type CloudMeetRow = { meet_name: string; state: string; year: string; association: string | null; source: string | null; dates: string | null; version: number; athlete_count: number; winner_count: number; published_at: string; published_by: string | null };
      let cloudMeets: CloudMeetRow[] = [];
      let cloudError: string | undefined;
      if (configStore.get('supabaseEnabled')) {
        try {
          const { getSupabaseClient } = await import('./supabase-client');
          const supabase = await getSupabaseClient();
          if (supabase) {
            const { data, error } = await supabase
              .from('meets')
              .select('meet_name, state, year, association, source, dates, version, athlete_count, winner_count, published_at, published_by')
              .order('published_at', { ascending: false });
            if (error) cloudError = error.message;
            else if (data) cloudMeets = data;
          }
        } catch (err) {
          cloudError = err instanceof Error ? err.message : String(err);
        }
      }

      // Merge by exact meet_name match
      const cloudMap = new Map(cloudMeets.map(m => [m.meet_name, m]));
      const seen = new Set<string>();
      type UnifiedMeet =
        | { meet_name: string; source: 'local'; local: LocalMeet; cloud?: never }
        | { meet_name: string; source: 'cloud'; cloud: CloudMeetRow; local?: never }
        | { meet_name: string; source: 'both'; local: LocalMeet; cloud: CloudMeetRow };
      const unified: UnifiedMeet[] = [];

      // Add local meets (check for cloud match)
      for (const local of localMeets) {
        seen.add(local.meet_name);
        const cloud = cloudMap.get(local.meet_name);
        if (cloud) {
          unified.push({ meet_name: local.meet_name, source: 'both', local, cloud });
        } else {
          unified.push({ meet_name: local.meet_name, source: 'local', local });
        }
      }

      // Add cloud-only meets
      for (const cloud of cloudMeets) {
        if (!seen.has(cloud.meet_name)) {
          unified.push({ meet_name: cloud.meet_name, source: 'cloud', cloud });
        }
      }

      // Sort by most recent (local modified or cloud published_at)
      unified.sort((a, b) => {
        const dateA = a.local?.modified || a.cloud?.published_at || '';
        const dateB = b.local?.modified || b.cloud?.published_at || '';
        return dateB.localeCompare(dateA);
      });

      return { success: true, meets: unified, cloudError };
    } catch (err) {
      return { success: true, meets: [], cloudError: err instanceof Error ? err.message : String(err) };
    }
  });

  // Print a PDF file via Windows print dialog
  ipcMain.handle('print-file', async (_event, meetName: string, filename: string) => {
    try {
      const { assertSafeMeetName, assertSafeFilename, getOutputBase } = await import('./paths');
      assertSafeMeetName(meetName);
      assertSafeFilename(filename);
      const filePath = path.join(getOutputBase(), meetName, filename);
      if (!filePath.endsWith('.pdf')) return { success: false, error: 'Only PDF files can be printed' };
      if (!fs.existsSync(filePath)) return { success: false, error: 'File not found' };

      const { spawn } = await import('child_process');
      const child = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        'Start-Process', '-FilePath', filePath, '-Verb', 'Print',
      ], { detached: true, stdio: 'ignore' });

      child.on('error', () => { /* print dialog is async, errors are not surfaced */ });
      child.unref();
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Send IDML files to the designer via email
  ipcMain.handle('send-to-designer', async (_event, meetName: string) => {
    try {
      const { assertSafeMeetName, getOutputBase } = await import('./paths');
      assertSafeMeetName(meetName);

      // Check email config
      const smtpHost = configStore.get('smtpHost');
      const smtpUser = configStore.get('smtpUser');
      const smtpPassword = configStore.get('smtpPassword');
      const designerEmail = configStore.get('designerEmail');
      if (!smtpHost || !smtpUser || !smtpPassword || !designerEmail) {
        return { success: false, error: 'Email not configured. Set up SMTP settings in the Settings tab.' };
      }

      // Find IDML files in the meet directory
      const meetDir = path.join(getOutputBase(), meetName);
      if (!fs.existsSync(meetDir)) {
        return { success: false, error: 'Meet output directory not found.' };
      }
      const idmlFiles = fs.readdirSync(meetDir).filter((f: string) => f.endsWith('.idml'));
      if (idmlFiles.length === 0) {
        return { success: false, error: 'No IDML files found for this meet.' };
      }
      const idmlPaths = idmlFiles.map((f: string) => path.join(meetDir, f));

      const { sendDesignerEmail } = await import('./smtp-service');
      return await sendDesignerEmail(
        { host: smtpHost, port: configStore.get('smtpPort'), user: smtpUser, password: smtpPassword },
        designerEmail,
        meetName,
        idmlPaths
      );
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Test email configuration
  ipcMain.handle('test-email', async () => {
    try {
      const smtpHost = configStore.get('smtpHost');
      const smtpUser = configStore.get('smtpUser');
      const smtpPassword = configStore.get('smtpPassword');
      const designerEmail = configStore.get('designerEmail');
      if (!smtpHost || !smtpUser || !smtpPassword || !designerEmail) {
        return { success: false, error: 'Email not configured. Fill in all SMTP fields first.' };
      }

      const { sendTestEmail } = await import('./smtp-service');
      return await sendTestEmail(
        { host: smtpHost, port: configStore.get('smtpPort'), user: smtpUser, password: smtpPassword },
        designerEmail
      );
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Check if the agent loop is currently running
  ipcMain.handle('is-agent-running', async () => {
    return { success: true, running: agentRunning };
  });

  // Open an output file by meet name + filename (safe — no raw paths from renderer)
  ipcMain.handle('open-file', async (_event, meetName: string, filename: string) => {
    try {
      const { assertSafeMeetName, assertSafeFilename, getOutputBase } = await import('./paths');
      assertSafeMeetName(meetName);
      assertSafeFilename(filename);
      const filePath = path.join(getOutputBase(), meetName, filename);
      const errorMsg = await shell.openPath(filePath);
      return { success: !errorMsg, error: errorMsg || undefined };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Show an output file in the system file explorer
  ipcMain.handle('show-in-folder', async (_event, meetName: string, filename: string) => {
    try {
      const { assertSafeMeetName, assertSafeFilename, getOutputBase } = await import('./paths');
      assertSafeMeetName(meetName);
      assertSafeFilename(filename);
      const filePath = path.join(getOutputBase(), meetName, filename);
      shell.showItemInFolder(filePath);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Get output files for a meet
  ipcMain.handle('get-output-files', async (_event, meetName: string) => {
    try {
      const { assertSafeMeetName } = await import('./paths');
      assertSafeMeetName(meetName);
      const outputDir = configStore.get('outputDir');
      const meetDir = path.join(outputDir, meetName);

      if (!fs.existsSync(meetDir)) {
        return { success: true, files: [] };
      }

      const files = fs.readdirSync(meetDir).map((name: string) => {
        const filePath = path.join(meetDir, name);
        const stats = fs.statSync(filePath);
        return {
          name,
          path: filePath,
          size: stats.size,
          modified: stats.mtime.toISOString(),
        };
      });

      return { success: true, files };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message, files: [] };
    }
  });

  // Open output folder
  ipcMain.handle('open-output-folder', async (_event, meetName: string) => {
    const { assertSafeMeetName } = await import('./paths');
    assertSafeMeetName(meetName);
    const outputDir = configStore.get('outputDir');
    const meetDir = path.join(outputDir, meetName);

    if (!fs.existsSync(meetDir)) {
      fs.mkdirSync(meetDir, { recursive: true });
    }

    // On WSL, convert Linux path to Windows UNC path for Explorer
    if (process.platform === 'linux' && meetDir.startsWith('/')) {
      try {
        const winPath = execFileSync('wslpath', ['-w', meetDir], { encoding: 'utf-8' }).trim();
        execFileSync('explorer.exe', [winPath]);
      } catch {
        shell.openPath(meetDir);
      }
    } else {
      shell.openPath(meetDir);
    }
    return { success: true };
  });

  // Open logs directory
  ipcMain.handle('open-logs-folder', async () => {
    const logsDir = path.join(getDataDir(), 'logs');
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    if (process.platform === 'linux' && logsDir.startsWith('/')) {
      try {
        const winPath = execFileSync('wslpath', ['-w', logsDir], { encoding: 'utf-8' }).trim();
        execFileSync('explorer.exe', [winPath]);
      } catch {
        shell.openPath(logsDir);
      }
    } else {
      shell.openPath(logsDir);
    }
    return { success: true };
  });

  ipcMain.handle('browse-folder', async () => {
    if (!mainWindow) return { cancelled: true };
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: 'Select Output Directory',
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { cancelled: true };
    }
    return { cancelled: false, path: result.filePaths[0] };
  });

  ipcMain.handle('browse-file', async (_event, filters?: { name: string; extensions: string[] }[]) => {
    if (!mainWindow) return { cancelled: true };
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      title: 'Select File',
      filters: filters || [
        { name: 'IDML Files', extensions: ['idml'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { cancelled: true };
    }
    return { cancelled: false, path: result.filePaths[0] };
  });

  // Browse for multiple files (for PDF import — select multiple backs at once)
  ipcMain.handle('browse-files', async (_event, filters?: { name: string; extensions: string[] }[]) => {
    if (!mainWindow) return { cancelled: true };
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      title: 'Select PDF Files',
      filters: filters || [
        { name: 'PDF Files', extensions: ['pdf'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { cancelled: true };
    }
    return { cancelled: false, paths: result.filePaths };
  });

  // Reset session — clear temp files, progress, Chrome state
  ipcMain.handle('reset-session', async () => {
    try {
      const dataDir = getDataDir();

      let deleted = 0;

      // Delete agent_progress.json
      const progressFile = path.join(dataDir, 'agent_progress.json');
      if (fs.existsSync(progressFile)) {
        fs.unlinkSync(progressFile);
        deleted++;
      }

      // Delete temp data files (js_result_*, http_result_*, staging_*) but NOT logs/
      if (fs.existsSync(dataDir)) {
        const files = fs.readdirSync(dataDir);
        for (const file of files) {
          if (file.startsWith('js_result_') || file.startsWith('http_result_') || file.startsWith('mso_extract_') || file.startsWith('scorecat_extract_') || file.startsWith('staging_')) {
            fs.unlinkSync(path.join(dataDir, file));
            deleted++;
          }
        }
      }

      // Reset staging DB module state
      resetStagingDb();

      // Navigate Chrome to blank page if connected
      if (chromeController.isConnected()) {
        try {
          await chromeController.navigate('about:blank');
        } catch {
          // Chrome might not be responsive — that's fine
        }
      }

      // Reset agent loop (clears query conversation)
      activeAgentLoop = null;

      sendActivityLog(`Session cleared (${deleted} temp files removed). Ready for a fresh run.`, 'success');
      return { success: true, deleted };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });

  // Check for updates
  let updateDownloaded = false;
  let lastLoggedPercent = 0;
  autoUpdater.on('download-progress', (progress) => {
    const pct = Math.round(progress.percent);
    if (mainWindow) {
      mainWindow.webContents.send('update-progress', {
        percent: pct,
        bytesPerSecond: progress.bytesPerSecond,
        transferred: progress.transferred,
        total: progress.total,
      });
    }
    // Log progress to activity log at 25% intervals so user sees it on any tab
    if (pct >= lastLoggedPercent + 25 || pct === 100) {
      const mbDown = (progress.transferred / 1024 / 1024).toFixed(1);
      const mbTotal = (progress.total / 1024 / 1024).toFixed(1);
      sendActivityLog(`Downloading update... ${pct}% (${mbDown}/${mbTotal} MB)`, 'info');
      lastLoggedPercent = pct;
    }
  });
  autoUpdater.on('update-downloaded', () => {
    updateDownloaded = true;
    if (mainWindow) {
      mainWindow.webContents.send('update-ready');
    }
    sendActivityLog('Update downloaded. Restarting to apply...', 'success');
    // Auto-relaunch after a short delay (whether user-triggered or background)
    setTimeout(() => {
      autoUpdater.quitAndInstall();
    }, 2000);
  });

  ipcMain.handle('get-version', () => {
    // In dev mode, app.getVersion() returns the Electron version (e.g. 28.3.3)
    // instead of the app version. Read from package.json as fallback.
    const version = app.getVersion();
    if (!app.isPackaged && version.startsWith('28.')) {
      try {
        const pkgPath = path.join(__dirname, '..', '..', 'package.json');
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        return pkg.version || version;
      } catch {
        return version;
      }
    }
    return version;
  });

  ipcMain.handle('check-for-updates', async () => {
    if (!app.isPackaged) {
      return { status: 'dev', message: 'Updates are not available in dev mode.' };
    }
    if (updateDownloaded) {
      // Update already downloaded — restart immediately
      setTimeout(() => autoUpdater.quitAndInstall(), 1500);
      return { status: 'ready', message: 'Update is ready to install.' };
    }
    try {
      const result = await autoUpdater.checkForUpdates();
      if (result && result.updateInfo && result.updateInfo.version !== app.getVersion()) {
        return { status: 'available', message: `Version ${result.updateInfo.version} is available and downloading.` };
      }
      return { status: 'current', message: `You are on the latest version (${app.getVersion()}).` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { status: 'error', message: `Could not check for updates: ${msg}` };
    }
  });

  ipcMain.handle('restart-and-update', () => {
    autoUpdater.quitAndInstall();
  });

  // Check model availability
  ipcMain.handle('check-model', async (_event, provider: string, model: string) => {
    try {
      const settings = configStore.getAll();
      const apiKey = settings.apiKey;

      if (provider === 'subscription') {
        const validModels = ['claude-opus-4-6', 'claude-sonnet-4-6'];
        return { available: validModels.includes(model) };
      }

      if (!apiKey) {
        // No key configured — fall back to known model list
        if (provider === 'anthropic') {
          const validModels = ['claude-opus-4-6', 'claude-sonnet-4-6'];
          return { available: validModels.includes(model) };
        }
        return { available: true };
      }

      const llmClient = new LLMClient({
        provider: provider as 'anthropic' | 'openrouter',
        apiKey,
        model,
      });

      const available = await llmClient.checkModelAvailability(model);
      return { available };
    } catch {
      // On error, be permissive
      return { available: true };
    }
  });
}

app.whenReady().then(() => {
  setupIPC();
  createWindow();

  // Auto-update: silently check GitHub Releases for a newer version
  if (app.isPackaged) {
    const updaterToken = process.env.UPDATER_TOKEN;
    if (updaterToken) {
      autoUpdater.setFeedURL({
        provider: 'github',
        owner: 'dowdys',
        repo: 'chp-meet-scores',
        private: true,
        token: updaterToken,
      });
    }
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('update-available', (info) => {
      sendActivityLog(`Update v${info.version} available. Downloading in the background...`, 'info');
    });
    autoUpdater.on('error', (err) => {
      console.error('Auto-update error:', err.message);
    });
    autoUpdater.checkForUpdatesAndNotify();
  }
});

app.on('window-all-closed', () => {
  chromeController.close();
  app.quit();
});

app.on('before-quit', () => {
  chromeController.close();
});
