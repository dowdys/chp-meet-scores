export type {
  ActivityLogEntry,
  OutputFile,
  AppSettings,
  AskUserRequest,
  ElectronAPI,
  CloudMeet,
  CloudMeetFile,
  LocalMeet,
  UnifiedMeet,
} from '../shared/types';

import type { ElectronAPI } from '../shared/types';

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
