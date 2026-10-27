import type { CellValue, EngineId } from '../../shared/ipc';
import type { StoredConnection } from './types';

export function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function normalizeCell(value: unknown, maxChars = 100_000): CellValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return truncateText(`0x${value.toString('hex')}`, maxChars);
  if (typeof value === 'string') return truncateText(value, maxChars);
  if (typeof value === 'object') {
    try {
      return truncateText(JSON.stringify(value), maxChars);
    } catch {
      return truncateText(String(value), maxChars);
    }
  }
  return truncateText(String(value), maxChars);
}

export function normalizeRow(values: readonly unknown[], maxChars?: number): CellValue[] {
  return values.map((value) => normalizeCell(value, maxChars));
}

export function quoteIdent(engine: EngineId, name: string): string {
  if (engine === 'mysql') {
    return `\`${name.split('`').join('``')}\``;
  }
  if (engine === 'mssql') {
    return `[${name.split(']').join(']]')}]`;
  }
  return `"${name.split('"').join('""')}"`;
}

export function tableRef(engine: EngineId, schema: string, table: string): string {
  if (engine === 'sqlite') {
    return quoteIdent(engine, table);
  }
  return `${quoteIdent(engine, schema)}.${quoteIdent(engine, table)}`;
}

export function quoteLiteral(value: string): string {
  return `'${value.split("'").join("''")}'`;
}

export function describeTarget(connection: StoredConnection): string {
  if (connection.engine === 'sqlite') {
    return connection.filePath ?? 'SQLite database';
  }
  const host = connection.host ?? 'localhost';
  const port = connection.port ? `:${connection.port}` : '';
  const database = connection.database ? `/${connection.database}` : '';
  const user = connection.username ? `${connection.username}@` : '';
  return `${user}${host}${port}${database}`;
}
