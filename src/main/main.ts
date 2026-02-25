import { app, BrowserWindow, ipcMain, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
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
  return new Promise((resolve) => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      resolve(options[0] || 'No window available');
      return;
    }

    // Listen for the user's response (one-time)
    const handler = (_event: Electron.IpcMainEvent, response: { choice: string }) => {
      ipcMain.removeListener('user-choice-response', handler);
      resolve(response.choice);
    };
    ipcMain.on('user-choice-response', handler);

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

      const result = await agentLoop.processMeet(meetName);

      if (result.success) {
        sendActivityLog(`Meet "${meetName}" processing completed.`, 'success');
      } else {
        sendActivityLog(`Meet "${meetName}" processing failed: ${result.message}`, 'error');
      }

      return { success: result.success, message: result.message };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendActivityLog(`Error: ${message}`, 'error');
      return { success: false, error: message };
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
  ipcMain.handle('save-settings', async (_event, settings: Record<string, unknown>) => {
    try {
      configStore.setAll(settings);
      // Reset agent loop so it picks up new settings
      activeAgentLoop = null;
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });

  // Get output files for a meet
  ipcMain.handle('get-output-files', async (_event, meetName: string) => {
    try {
      const outputDir = configStore.get('outputDir');
      const meetDir = path.join(outputDir, meetName);
      const fs = await import('fs');

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
    const outputDir = configStore.get('outputDir');
    const meetDir = path.join(outputDir, meetName);
    const fs = await import('fs');

    if (!fs.existsSync(meetDir)) {
      fs.mkdirSync(meetDir, { recursive: true });
    }

    // On WSL, convert Linux path to Windows UNC path for Explorer
    if (process.platform === 'linux' && meetDir.startsWith('/')) {
      const { execSync } = await import('child_process');
      try {
        const winPath = execSync(`wslpath -w "${meetDir}"`).toString().trim();
        execSync(`explorer.exe "${winPath}"`);
      } catch {
        shell.openPath(meetDir);
      }
    } else {
      shell.openPath(meetDir);
    }
    return { success: true };
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
  autoUpdater.on('update-downloaded', () => {
    updateDownloaded = true;
  });

  ipcMain.handle('check-for-updates', async () => {
    if (!app.isPackaged) {
      return { status: 'dev', message: 'Updates are not available in dev mode.' };
    }
    if (updateDownloaded) {
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
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('update-available', (info) => {
      sendActivityLog(`Update v${info.version} available. Downloading in the background...`, 'info');
    });
    autoUpdater.on('update-downloaded', () => {
      sendActivityLog('Update downloaded. It will install when you close the app.', 'success');
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
