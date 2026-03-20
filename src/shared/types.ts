/**
 * Shared types used by both main process (preload) and renderer.
 * Single source of truth — import from here instead of duplicating.
 */

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
  processMeet: (meetName: string) => Promise<{ success: boolean; message?: string; error?: string; outputName?: string }>;
  continueConversation: (message: string) => Promise<{ success: boolean; message?: string; error?: string }>;
  queryResults: (question: string) => Promise<{ success: boolean; answer?: string; error?: string }>;
  resetSession: () => Promise<{ success: boolean; deleted?: number; error?: string }>;
  stopRun: () => Promise<{ success: boolean; error?: string }>;
  onActivityLog: (callback: (entry: ActivityLogEntry) => void) => () => void;
  onAskUser: (callback: (request: AskUserRequest) => void) => () => void;
  respondToAskUser: (choice: string) => void;
  getSettings: () => Promise<AppSettings>;
  saveSettings: (settings: Partial<AppSettings>) => Promise<{ success: boolean; error?: string }>;
  browseFolder: () => Promise<{ cancelled: boolean; path?: string }>;
  browseFile: (filters?: { name: string; extensions: string[] }[]) => Promise<{ cancelled: boolean; path?: string }>;
  browseFiles: (filters?: { name: string; extensions: string[] }[]) => Promise<{ cancelled: boolean; paths?: string[] }>;
  getOutputFiles: (meetName: string) => Promise<{ success: boolean; files: OutputFile[]; error?: string }>;
  openOutputFolder: (meetName: string) => Promise<{ success: boolean }>;
  openLogsFolder: () => Promise<{ success: boolean }>;
  checkModelAvailability: (provider: string, model: string) => Promise<{ available: boolean }>;
  getVersion: () => Promise<string>;
  checkForUpdates: () => Promise<{ status: string; message: string }>;
  onUpdateProgress: (callback: (progress: { percent: number; bytesPerSecond: number; transferred: number; total: number }) => void) => () => void;
  onUpdateReady: (callback: () => void) => () => void;
  restartAndUpdate: () => Promise<void>;
}
