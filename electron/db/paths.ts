import path from 'node:path';
import { app } from 'electron';

// Keep legacy filename so existing local DBs keep working after the product rename.
export const DATABASE_FILE_NAME = 'easy-reporter.db';

/**
 * Unpackaged builds run from dist-electron/main.js. Prefer that folder's parent
 * over app.getAppPath(), which can point at the wrong place depending on how
 * Electron was launched.
 */
export function projectRoot(): string {
  if (app.isPackaged) {
    return process.resourcesPath;
  }
  return path.join(__dirname, '..');
}

export function databaseDirectory(): string {
  return app.isPackaged ? app.getPath('userData') : path.join(projectRoot(), 'prisma');
}

export function databaseFilePath(): string {
  return path.join(databaseDirectory(), DATABASE_FILE_NAME);
}

export function migrationsDirectory(): string {
  return path.join(projectRoot(), 'prisma', 'migrations');
}

export function runsDirectory(): string {
  return path.join(app.getPath('userData'), 'runs');
}

export function exportsDirectory(): string {
  return path.join(app.getPath('userData'), 'exports');
}
