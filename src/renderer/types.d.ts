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

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
