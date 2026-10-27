import type { ConnectionStatus, EngineId } from '../../shared/ipc';

export const ENGINE_LABELS: Record<EngineId, string> = {
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  mssql: 'SQL Server',
  sqlite: 'SQLite',
};

export const ENGINE_PORTS: Record<EngineId, number> = {
  postgres: 5432,
  mysql: 3306,
  mssql: 1433,
  sqlite: 0,
};

const STATUS_LABELS: Record<ConnectionStatus, string> = {
  draft: 'Draft',
  questions: 'Questions',
  ready: 'Ready',
  failed: 'Needs attention',
};

export function statusLabel(status: ConnectionStatus): string {
  return STATUS_LABELS[status] ?? status;
}

export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return value.toLocaleString();
}

export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return kb < 1024 ? `${kb.toFixed(1)} KB` : `${(kb / 1024).toFixed(2)} MB`;
}
