export type {
  ActivityLogEntry,
  OutputFile,
  AppSettings,
  AskUserRequest,
  ElectronAPI,
} from '../shared/types';

import type { ElectronAPI } from '../shared/types';

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
