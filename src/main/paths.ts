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
  const appPath = app.getAppPath();
  // When launched as `electron <project-dir>`, appPath IS the project root.
  // When launched as `electron dist/main/main.js`, appPath is dist/main.
  if (fs.existsSync(path.join(appPath, 'package.json'))) {
    return appPath;
  }
  return path.join(appPath, '..', '..');
}

/** Recognized output filenames that the pipeline generates. */
export const RECOGNIZED_OUTPUT_FILES = [
  'back_of_shirt.pdf', 'back_of_shirt_8.5x14.pdf',
  'back_of_shirt.idml', 'back_of_shirt_8.5x14.idml',
  'order_forms.pdf',
  'gym_highlights.pdf', 'gym_highlights_8.5x14.pdf',
  'meet_summary.txt',
];

/** Validate that a meet name is safe for use in file paths (no traversal). */
export function assertSafeMeetName(meetName: string): void {
  if (!meetName || typeof meetName !== 'string') throw new Error('Invalid meet name');
  if (meetName.includes('/') || meetName.includes('\\') || meetName.includes('..')) {
    throw new Error('Invalid meet name: path separators not allowed');
  }
}

/** Validate that a filename is safe (no traversal, allowed extensions only). */
export function assertSafeFilename(filename: string): void {
  if (!filename || typeof filename !== 'string') throw new Error('Invalid filename');
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
    throw new Error('Invalid filename: path separators not allowed');
  }
  const allowedExtensions = ['.pdf', '.idml', '.txt', '.csv', '.xlsx'];
  const ext = path.extname(filename).toLowerCase();
  if (!allowedExtensions.includes(ext)) {
    throw new Error(`Invalid filename: unsupported extension ${ext}`);
  }
}

/** Get the output base directory (parent of all meet folders). */
export function getOutputBase(): string {
  return configStore.get('outputDir') || path.join(app.getPath('documents'), 'Gymnastics Champions');
}

export function getOutputDir(meetName: string, createIfMissing = true): string {
  const outputBase = configStore.get('outputDir') || path.join(app.getPath('documents'), 'Gymnastics Champions');
  const meetDir = path.join(outputBase, meetName);
  if (createIfMissing && !fs.existsSync(meetDir)) {
    fs.mkdirSync(meetDir, { recursive: true });
  }
  return meetDir;
}

export function getCentralDbPath(): string {
  return path.join(getDataDir(), 'chp_results.db');
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
