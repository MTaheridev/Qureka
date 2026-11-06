import path from 'node:path';
import { BrowserWindow, shell } from 'electron';

const DEV_SERVER_URL = process.env.QUREKA_DEV_URL ?? process.env.EASYREPORTER_DEV_URL ?? 'http://localhost:3000/';
const isDev = process.env.QUREKA_DEV === '1' || process.env.EASYREPORTER_DEV === '1';

const reportWindows = new Map<string, BrowserWindow>();

function guardNavigation(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    const devBase = DEV_SERVER_URL.replace(/\/$/, '');
    const allowed = isDev ? url.startsWith(devBase) : url.startsWith('file://');
    if (!allowed) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });
}

export function openReportWindow(runId: string): void {
  const id = String(runId ?? '').trim();
  if (!id) throw new Error('This report is missing.');

  const existing = reportWindows.get(id);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    return;
  }

  const window = new BrowserWindow({
    title: 'Qureka Report',
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: !isDev,
    },
  });

  reportWindows.set(id, window);
  window.on('closed', () => {
    if (reportWindows.get(id) === window) reportWindows.delete(id);
  });
  window.once('ready-to-show', () => window.show());
  guardNavigation(window);

  if (isDev) {
    const base = DEV_SERVER_URL.endsWith('/') ? DEV_SERVER_URL : `${DEV_SERVER_URL}/`;
    void window.loadURL(`${base}report/?runId=${encodeURIComponent(id)}`);
    return;
  }

  void window.loadFile(path.join(__dirname, '..', 'out', 'report', 'index.html'), {
    query: { runId: id },
  });
}
