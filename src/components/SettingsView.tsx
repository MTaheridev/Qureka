'use client';

import { useState } from 'react';
import { FadeIn } from '@/components/bits';
import { Icon, Notice } from '@/components/ui';
import { useSettings } from '@/lib/settings';
import type { AppLanguage, AppTheme } from '../../shared/ipc';

export function SettingsView() {
  const { settings, tr, update } = useSettings();
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function patch(next: Parameters<typeof update>[0]) {
    setSaving(true);
    setNote(null);
    try {
      await update(next);
      setNote(tr('saved'));
    } catch (error) {
      setNote(error instanceof Error ? error.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <FadeIn className="page">
      <header className="page-head">
        <div>
          <h1>{tr('settingsTitle')}</h1>
          <p className="subtitle">{tr('settingsSubtitle')}</p>
        </div>
      </header>

      {note ? (
        <Notice tone="ok">
          <Icon name="check" size={16} />
          <span>{note}</span>
        </Notice>
      ) : null}

      <section className="panel settings-panel">
        <h2>{tr('language')}</h2>
        <p className="muted small">{tr('languageHint')}</p>
        <div className="segmented settings-segmented">
          {([
            ['en', tr('languageEn')],
            ['fa', tr('languageFa')],
          ] as [AppLanguage, string][]).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={settings.language === value ? 'active' : ''}
              disabled={saving}
              onClick={() => void patch({ language: value })}
            >
              {label}
            </button>
          ))}
        </div>
      </section>

      <section className="panel settings-panel">
        <h2>{tr('theme')}</h2>
        <div className="segmented settings-segmented">
          {([
            ['dark', tr('themeDark')],
            ['light', tr('themeLight')],
          ] as [AppTheme, string][]).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={settings.theme === value ? 'active' : ''}
              disabled={saving}
              onClick={() => void patch({ theme: value })}
            >
              {label}
            </button>
          ))}
        </div>
      </section>
    </FadeIn>
  );
}
