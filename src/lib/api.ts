import type { EasyReporterApi } from '../../shared/ipc';

export function getApi(): EasyReporterApi {
  const bridge = window.easyReporter;
  if (!bridge) {
    throw new Error('The desktop bridge is unavailable. Open EasyReporter through the desktop app.');
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
