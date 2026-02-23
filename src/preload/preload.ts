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
  apiProvider: 'anthropic' | 'openrouter';
  apiKey: string;
  model: string;
  githubToken: string;
  outputDir: string;
}

export interface ElectronAPI {
  processMeet: (meetName: string) => Promise<{ success: boolean; message?: string; error?: string }>;
  queryResults: (question: string) => Promise<{ success: boolean; answer?: string; error?: string }>;
  onActivityLog: (callback: (entry: ActivityLogEntry) => void) => () => void;
  getSettings: () => Promise<AppSettings>;
  saveSettings: (settings: Partial<AppSettings>) => Promise<{ success: boolean; error?: string }>;
  getOutputFiles: (meetName: string) => Promise<{ success: boolean; files: OutputFile[]; error?: string }>;
  openOutputFolder: (meetName: string) => Promise<{ success: boolean }>;
  checkModelAvailability: (provider: string, model: string) => Promise<{ available: boolean }>;
}

contextBridge.exposeInMainWorld('electronAPI', {
  processMeet: (meetName: string) => {
    return ipcRenderer.invoke('process-meet', meetName);
  },

  queryResults: (question: string) => {
    return ipcRenderer.invoke('query-results', question);
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
} as ElectronAPI);
