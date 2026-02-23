import { app, BrowserWindow, ipcMain, shell } from 'electron';
import * as path from 'path';
import { chromeController } from './chrome-controller';
import { configStore } from './config-store';
import { LLMClient } from './llm-client';
import { AgentLoop } from './agent-loop';

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
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'Gymnastics Meet Scores',
  });

  // In development, load from webpack dev server; in production, load the built file
  if (process.env.NODE_ENV === 'development' || !app.isPackaged) {
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
 * Create an LLMClient from the current settings.
 */
function createLLMClient(): LLMClient {
  const settings = configStore.getAll();

  if (!settings.apiKey) {
    throw new Error('API key is not configured. Please set it in Settings.');
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
    activeAgentLoop = new AgentLoop(llmClient, {}, sendActivityLog);
  }
  return activeAgentLoop;
}

// IPC Handlers
function setupIPC(): void {
  // Process a meet
  ipcMain.handle('process-meet', async (_event, meetName: string) => {
    try {
      sendActivityLog(`Starting to process meet: ${meetName}`);

      const llmClient = createLLMClient();
      const agentLoop = new AgentLoop(llmClient, {}, sendActivityLog);
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

    shell.openPath(meetDir);
    return { success: true };
  });

  // Check model availability
  ipcMain.handle('check-model', async (_event, provider: string, model: string) => {
    try {
      const settings = configStore.getAll();
      const apiKey = settings.apiKey;

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
});

app.on('window-all-closed', () => {
  chromeController.close();
  app.quit();
});

app.on('before-quit', () => {
  chromeController.close();
});
