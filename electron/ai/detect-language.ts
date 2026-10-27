import type { AppLanguage } from '../../shared/ipc';

const ARABIC_SCRIPT = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g;

/**
 * Detect reply language from the user's latest message.
 * Persian (fa) when Arabic-script letters dominate letters; otherwise English.
 */
export function detectLanguage(text: string): AppLanguage {
  const raw = String(text ?? '');
  const arabic = raw.match(ARABIC_SCRIPT)?.length ?? 0;
  const letters = raw.match(/\p{L}/gu)?.length ?? 0;
  if (letters === 0) return 'en';
  if (arabic / letters >= 0.3) return 'fa';
  return 'en';
}
