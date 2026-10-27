import { safeStorage } from 'electron';

const PREFIX = 'er:v1:';
const FALLBACK = 'b64:';

export function encryptSecret(value: string | null | undefined): string | null {
  const plain = value?.trim();
  if (!plain) return null;

  if (safeStorage.isEncryptionAvailable()) {
    try {
      return `${PREFIX}${safeStorage.encryptString(plain).toString('base64')}`;
    } catch {
      // Fall through to the portable encoding below.
    }
  }

  return `${PREFIX}${FALLBACK}${Buffer.from(plain, 'utf8').toString('base64')}`;
}

export function decryptSecret(value: string | null | undefined): string | null {
  if (!value) return null;
  if (!value.startsWith(PREFIX)) return value;

  const payload = value.slice(PREFIX.length);
  if (payload.startsWith(FALLBACK)) {
    return Buffer.from(payload.slice(FALLBACK.length), 'base64').toString('utf8');
  }

  try {
    return safeStorage.decryptString(Buffer.from(payload, 'base64'));
  } catch {
    return null;
  }
}

export function keyStorageLabel(): string {
  if (!safeStorage.isEncryptionAvailable()) {
    return 'Portable encoding (OS key storage unavailable)';
  }
  if (process.platform === 'linux') {
    try {
      const backend = safeStorage.getSelectedStorageBackend();
      return backend === 'basic_text' ? 'Linux basic_text (no keyring detected)' : `OS keyring (${backend})`;
    } catch {
      return 'OS keyring';
    }
  }
  return 'OS keyring';
}
