'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { AppLanguage, AppSettings, AppSettingsPatch, AppTheme } from '../../shared/ipc';
import { dirFor, t, type I18nKey } from './i18n';

const DEFAULTS: AppSettings = {
  language: 'en',
  theme: 'dark',
};

type SettingsContextValue = {
  settings: AppSettings;
  ready: boolean;
  language: AppLanguage;
  theme: AppTheme;
  dir: 'ltr' | 'rtl';
  tr: (key: I18nKey, vars?: Record<string, string>) => string;
  update: (patch: AppSettingsPatch) => Promise<AppSettings>;
};

const SettingsContext = createContext<SettingsContextValue | null>(null);

function applyDocument(settings: AppSettings) {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = settings.language === 'fa' ? 'fa' : 'en';
  document.documentElement.dir = dirFor(settings.language);
  document.documentElement.dataset.theme = settings.theme;
  document.documentElement.dataset.lang = settings.language;
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(DEFAULTS);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const bridge = window.easyReporter;
          if (!bridge?.getSettings) {
            applyDocument(DEFAULTS);
            if (!cancelled) setReady(true);
            return;
          }
          const loaded = await bridge.getSettings();
          if (!cancelled) {
            setSettings(loaded);
            applyDocument(loaded);
            setReady(true);
          }
        } catch {
          applyDocument(DEFAULTS);
          if (!cancelled) setReady(true);
        }
      })();
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  const update = useCallback(async (patch: AppSettingsPatch) => {
    const bridge = window.easyReporter;
    const localNext: AppSettings = { ...DEFAULTS, ...settings, ...patch };
    try {
      const next = bridge?.setSettings ? await bridge.setSettings(patch) : localNext;
      setSettings(next);
      applyDocument(next);
      return next;
    } catch {
      // Bridge/IPC can lag a stale Electron main after code changes — still apply locally.
      setSettings(localNext);
      applyDocument(localNext);
      return localNext;
    }
  }, [settings]);

  const value = useMemo<SettingsContextValue>(
    () => ({
      settings,
      ready,
      language: settings.language,
      theme: settings.theme,
      dir: dirFor(settings.language),
      tr: (key, vars) => t(settings.language, key, vars),
      update,
    }),
    [settings, ready, update],
  );

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) {
    throw new Error('useSettings must be used inside SettingsProvider');
  }
  return ctx;
}
