import path from 'node:path';
import { app, BrowserWindow, dialog, shell } from 'electron';
import { registerIpcHandlers } from './ipc/register';
import { disconnectPrisma } from './db/client';
import { runMigrations } from './db/migrate';

const DEV_SERVER_URL = process.env.EASYREPORTER_DEV_URL ?? 'http://localhost:3000/';
const isDev = process.env.EASYREPORTER_DEV === '1';

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    title: 'EasyReporter',
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Sandbox breaks Next.js App Router hydration under `next dev` (Turbopack/webpack)
      // in Electron; keep it on for packaged builds.
      sandbox: !isDev,
    },
  });

  window.once('ready-to-show', () => window.show());

  // Keep the renderer inside the app: external links leave through the OS browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    const allowed = isDev
      ? url.startsWith(DEV_SERVER_URL.replace(/\/$/, ''))
      : url.startsWith('file://');
    if (!allowed) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  if (isDev) {
    void window.loadURL(DEV_SERVER_URL);
  } else {
    void window.loadFile(path.join(__dirname, '..', 'out', 'index.html'));
  }

  return window;
}

const singleInstanceLock = app.requestSingleInstanceLock();

if (!singleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const focused = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    if (focused) {
      if (focused.isMinimized()) focused.restore();
      focused.focus();
    }
  });

  app.whenReady().then(async () => {
    app.setAboutPanelOptions({
      applicationName: 'EasyReporter',
      applicationVersion: app.getVersion(),
      authors: ['Mohammad Taheri'],
      website: 'https://taheri.vercel.app',
    });

    try {
      await runMigrations();
    } catch (error) {
      dialog.showErrorBox(
        'EasyReporter could not start',
        `The local database could not be prepared.\n\n${error instanceof Error ? error.message : String(error)}`,
      );
      app.quit();
      return;
    }

    registerIpcHandlers();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    void disconnectPrisma();
  });
}
