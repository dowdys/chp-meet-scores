import { contextBridge, ipcRenderer } from 'electron';
import { ActivityLogEntry, AskUserRequest, AppSettings, ElectronAPI } from '../shared/types';

// Re-export types for backward compatibility
export type { ActivityLogEntry, OutputFile, AppSettings, AskUserRequest, ElectronAPI } from '../shared/types';

contextBridge.exposeInMainWorld('electronAPI', {
  processMeet: (meetName: string) => {
    return ipcRenderer.invoke('process-meet', meetName);
  },

  continueConversation: (message: string) => {
    return ipcRenderer.invoke('continue-conversation', message);
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

  browseFolder: () => {
    return ipcRenderer.invoke('browse-folder');
  },

  browseFile: (filters?: { name: string; extensions: string[] }[]) => {
    return ipcRenderer.invoke('browse-file', filters);
  },

  browseFiles: (filters?: { name: string; extensions: string[] }[]) => {
    return ipcRenderer.invoke('browse-files', filters);
  },

  getOutputFiles: (meetName: string) => {
    return ipcRenderer.invoke('get-output-files', meetName);
  },

  openOutputFolder: (meetName: string) => {
    return ipcRenderer.invoke('open-output-folder', meetName);
  },

  openLogsFolder: () => {
    return ipcRenderer.invoke('open-logs-folder');
  },

  checkModelAvailability: (provider: string, model: string) => {
    return ipcRenderer.invoke('check-model', provider, model);
  },
  getVersion: () => {
    return ipcRenderer.invoke('get-version');
  },
  checkForUpdates: () => {
    return ipcRenderer.invoke('check-for-updates');
  },
  onUpdateProgress: (callback: (progress: { percent: number; bytesPerSecond: number; transferred: number; total: number }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: { percent: number; bytesPerSecond: number; transferred: number; total: number }) => {
      callback(progress);
    };
    ipcRenderer.on('update-progress', handler);
    return () => { ipcRenderer.removeListener('update-progress', handler); };
  },
  onUpdateReady: (callback: () => void) => {
    const handler = () => { callback(); };
    ipcRenderer.on('update-ready', handler);
    return () => { ipcRenderer.removeListener('update-ready', handler); };
  },
  restartAndUpdate: () => {
    return ipcRenderer.invoke('restart-and-update');
  },
  testSupabaseConnection: () => {
    return ipcRenderer.invoke('test-supabase-connection');
  },
  listCloudMeets: () => {
    return ipcRenderer.invoke('list-cloud-meets');
  },
  getCloudMeetFiles: (meetName: string) => {
    return ipcRenderer.invoke('get-cloud-meet-files', meetName);
  },
  downloadCloudFile: (meetName: string, storagePath: string, filename: string) => {
    return ipcRenderer.invoke('download-cloud-file', meetName, storagePath, filename);
  },
  pullCloudMeet: (meetName: string) => {
    return ipcRenderer.invoke('pull-cloud-meet', meetName);
  },
  openFile: (meetName: string, filename: string) => {
    return ipcRenderer.invoke('open-file', meetName, filename);
  },
  showInFolder: (meetName: string, filename: string) => {
    return ipcRenderer.invoke('show-in-folder', meetName, filename);
  },
  listUnifiedMeets: () => {
    return ipcRenderer.invoke('list-unified-meets');
  },
  printFile: (meetName: string, filename: string) => {
    return ipcRenderer.invoke('print-file', meetName, filename);
  },
  sendToDesigner: (meetName: string) => {
    return ipcRenderer.invoke('send-to-designer', meetName);
  },
  sendReportIssue: (meetName: string, note: string, logSource: 'meet' | 'active') => {
    return ipcRenderer.invoke('send-report-issue', meetName, note, logSource);
  },
  isAgentRunning: () => {
    return ipcRenderer.invoke('is-agent-running');
  },
  onMeetProcessed: (callback: (data: { meetName: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { meetName: string }) => {
      callback(data);
    };
    ipcRenderer.on('meet-processed', handler);
    return () => {
      ipcRenderer.removeListener('meet-processed', handler);
    };
  },
} as ElectronAPI);
