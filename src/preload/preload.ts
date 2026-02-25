import { contextBridge, ipcRenderer } from 'electron';

export interface ActivityLogEntry {
  timestamp: string;
  message: string;
  level: 'info' | 'success' | 'error' | 'warning';
}

export interface OutputFile {
  name: string;
  path: string;
  size: number;
  modified: string;
}

export interface AppSettings {
  apiProvider: 'anthropic' | 'openrouter' | 'subscription';
  apiKey: string;
  model: string;
  githubToken: string;
  outputDir: string;
}

export interface AskUserRequest {
  question: string;
  options: string[];
}

export interface ElectronAPI {
  processMeet: (meetName: string) => Promise<{ success: boolean; message?: string; error?: string }>;
  queryResults: (question: string) => Promise<{ success: boolean; answer?: string; error?: string }>;
  resetSession: () => Promise<{ success: boolean; deleted?: number; error?: string }>;
  stopRun: () => Promise<{ success: boolean; error?: string }>;
  onActivityLog: (callback: (entry: ActivityLogEntry) => void) => () => void;
  onAskUser: (callback: (request: AskUserRequest) => void) => () => void;
  respondToAskUser: (choice: string) => void;
  getSettings: () => Promise<AppSettings>;
  saveSettings: (settings: Partial<AppSettings>) => Promise<{ success: boolean; error?: string }>;
  getOutputFiles: (meetName: string) => Promise<{ success: boolean; files: OutputFile[]; error?: string }>;
  openOutputFolder: (meetName: string) => Promise<{ success: boolean }>;
  checkModelAvailability: (provider: string, model: string) => Promise<{ available: boolean }>;
  checkForUpdates: () => Promise<{ status: string; message: string }>;
}

contextBridge.exposeInMainWorld('electronAPI', {
  processMeet: (meetName: string) => {
    return ipcRenderer.invoke('process-meet', meetName);
  },

  queryResults: (question: string) => {
    return ipcRenderer.invoke('query-results', question);
  },

  resetSession: () => {
    return ipcRenderer.invoke('reset-session');
  },

  stopRun: () => {
    return ipcRenderer.invoke('agent:stop-request');
  },

  onActivityLog: (callback: (entry: ActivityLogEntry) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, entry: ActivityLogEntry) => {
      callback(entry);
    };
    ipcRenderer.on('activity-log', handler);
    // Return cleanup function
    return () => {
      ipcRenderer.removeListener('activity-log', handler);
    };
  },

  onAskUser: (callback: (request: AskUserRequest) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, request: AskUserRequest) => {
      callback(request);
    };
    ipcRenderer.on('ask-user', handler);
    return () => {
      ipcRenderer.removeListener('ask-user', handler);
    };
  },

  respondToAskUser: (choice: string) => {
    ipcRenderer.send('user-choice-response', { choice });
  },

  getSettings: () => {
    return ipcRenderer.invoke('get-settings');
  },

  saveSettings: (settings: Partial<AppSettings>) => {
    return ipcRenderer.invoke('save-settings', settings);
  },

  getOutputFiles: (meetName: string) => {
    return ipcRenderer.invoke('get-output-files', meetName);
  },

  openOutputFolder: (meetName: string) => {
    return ipcRenderer.invoke('open-output-folder', meetName);
  },

  checkModelAvailability: (provider: string, model: string) => {
    return ipcRenderer.invoke('check-model', provider, model);
  },
  checkForUpdates: () => {
    return ipcRenderer.invoke('check-for-updates');
  },
} as ElectronAPI);
