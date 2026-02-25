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

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
