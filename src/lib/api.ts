import type { QurekaApi } from '../../shared/ipc';

export function getApi(): QurekaApi {
  const bridge = window.qureka;
  if (!bridge) {
    throw new Error('The desktop bridge is unavailable. Open Qureka through the desktop app.');
  }
  return bridge;
}

export function errorMessage(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'Something went wrong.';
  return raw
    .replace(/^Error invoking remote method '[^']*':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim();
}
