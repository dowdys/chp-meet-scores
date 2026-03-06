/**
 * Shared path helpers for packaged vs dev mode.
 *
 * - getProjectRoot(): read-only resources (skills/, python .exe). In packaged mode
 *   this is inside Program Files (process.resourcesPath). In dev it's the repo root.
 *
 * - getDataDir(): writable data directory (database, temp files, logs, progress).
 *   In packaged mode this is AppData/Roaming (app.getPath('userData')/data/).
 *   In dev it's the repo's data/ directory.
 */

import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';
import { configStore } from './config-store';

export function getProjectRoot(): string {
  if (app.isPackaged) {
    return process.resourcesPath!;
  }
  // dev: app.getAppPath() is dist/main, go up 2 levels to repo root
  return path.join(app.getAppPath(), '..', '..');
}

export function getOutputDir(meetName: string, createIfMissing = true): string {
  const outputBase = configStore.get('outputDir') || path.join(app.getPath('documents'), 'Gymnastics Champions');
  const meetDir = path.join(outputBase, meetName);
  if (createIfMissing && !fs.existsSync(meetDir)) {
    fs.mkdirSync(meetDir, { recursive: true });
  }
  return meetDir;
}

export function getDataDir(): string {
  let dataDir: string;
  if (app.isPackaged) {
    dataDir = path.join(app.getPath('userData'), 'data');
  } else {
    dataDir = path.join(getProjectRoot(), 'data');
  }
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  return dataDir;
}
