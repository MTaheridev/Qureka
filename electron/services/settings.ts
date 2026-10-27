import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { AppSettings, AppSettingsPatch } from '../../shared/ipc';

const DEFAULTS: AppSettings = {
  language: 'en',
  theme: 'dark',
};

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'app-settings.json');
}

function normalize(raw: unknown): AppSettings {
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    language: value.language === 'fa' ? 'fa' : 'en',
    theme: value.theme === 'light' ? 'light' : 'dark',
  };
}

export function getSettings(): AppSettings {
  try {
    const file = settingsPath();
    if (!fs.existsSync(file)) return { ...DEFAULTS };
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return normalize(parsed);
  } catch {
    return { ...DEFAULTS };
  }
}

export function setSettings(patch: AppSettingsPatch): AppSettings {
  const next = normalize({ ...getSettings(), ...patch });
  const file = settingsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}
