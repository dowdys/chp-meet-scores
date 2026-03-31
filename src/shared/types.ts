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
  perplexityApiKey: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseEnabled: boolean;
  installationId: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPassword: string;
  designerEmail: string;
}

export interface CloudMeet {
  meet_name: string;
  state: string;
  year: string;
  association: string | null;
  source: string | null;
  dates: string | null;
  version: number;
  athlete_count: number;
  winner_count: number;
  published_at: string;
  published_by: string | null;
}

export interface CloudMeetFile {
  filename: string;
  storage_path: string;
  file_size: number | null;
  uploaded_at: string;
}

export interface LocalMeet {
  meet_name: string;
  fileCount: number;
  modified: string; // ISO date of most recent file
}

export type UnifiedMeet =
  | { meet_name: string; source: 'local';  local: LocalMeet; cloud?: never }
  | { meet_name: string; source: 'cloud';  cloud: CloudMeet; local?: never }
  | { meet_name: string; source: 'both';   local: LocalMeet; cloud: CloudMeet };

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
  testSupabaseConnection: () => Promise<{ success: boolean; error?: string }>;
  listCloudMeets: () => Promise<{ success: boolean; meets?: CloudMeet[]; error?: string }>;
  getCloudMeetFiles: (meetName: string) => Promise<{ success: boolean; files?: CloudMeetFile[]; error?: string }>;
  downloadCloudFile: (meetName: string, storagePath: string, filename: string) => Promise<{ success: boolean; localPath?: string; error?: string }>;
  pullCloudMeet: (meetName: string) => Promise<{ success: boolean; reason?: string; resultsCount?: number; winnersCount?: number }>;
  openFile: (meetName: string, filename: string) => Promise<{ success: boolean; error?: string }>;
  showInFolder: (meetName: string, filename: string) => Promise<{ success: boolean; error?: string }>;
  listUnifiedMeets: () => Promise<{ success: boolean; meets: UnifiedMeet[]; cloudError?: string }>;
  printFile: (meetName: string, filename: string) => Promise<{ success: boolean; error?: string }>;
  sendToDesigner: (meetName: string) => Promise<{ success: boolean; error?: string }>;
  testEmail: () => Promise<{ success: boolean; error?: string }>;
  isAgentRunning: () => Promise<{ success: boolean; running: boolean }>;
  onMeetProcessed: (callback: (data: { meetName: string }) => void) => () => void;
}
