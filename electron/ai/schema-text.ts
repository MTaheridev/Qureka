import type { EngineId, SchemaSnapshot } from '../../shared/ipc';

const ENGINE_LABELS: Record<EngineId, string> = {
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  mssql: 'Microsoft SQL Server (T-SQL)',
  sqlite: 'SQLite',
};

export function engineLabel(engine: EngineId): string {
  return ENGINE_LABELS[engine] ?? engine;
}

interface SchemaTextOptions {
  maxChars?: number;
  includeSamples?: boolean;
}

export function schemaToText(
  engine: EngineId,
  snapshot: SchemaSnapshot,
  options: SchemaTextOptions = {},
): string {
  const maxChars = options.maxChars ?? 60_000;
  const includeSamples = options.includeSamples ?? true;
  const lines: string[] = [];

  lines.push(`Engine: ${engineLabel(engine)}`);
  lines.push(`Tables: ${snapshot.tables.length}${snapshot.truncated ? ' (list truncated)' : ''}`);

  for (const table of snapshot.tables) {
    const qualified = table.schema && table.schema !== 'main' ? `${table.schema}.${table.name}` : table.name;
    const rows = table.rowCount === null ? 'unknown rows' : `~${table.rowCount} rows`;
    lines.push('');
    lines.push(`TABLE ${qualified} (${rows})`);

    for (const column of table.columns) {
      const flags = [
        column.primaryKey ? 'PK' : null,
        column.nullable ? null : 'NOT NULL',
        column.references ? `FK -> ${column.references.table}.${column.references.column}` : null,
      ].filter((value): value is string => value !== null);
      lines.push(`  - ${column.name} ${column.dataType}${flags.length > 0 ? ` [${flags.join(', ')}]` : ''}`);
    }

    if (includeSamples && table.sampleRows.length > 0) {
      lines.push('  sample rows:');
      for (const row of table.sampleRows) {
        const pairs = table.sampleColumns.map((column, index) => `${column}=${formatSample(row[index])}`);
        lines.push(`    { ${pairs.join(', ')} }`);
      }
    }

    if (lines.join('\n').length > maxChars) {
      lines.push('');
      lines.push('[schema truncated because it is too large]');
      break;
    }
  }

  const text = lines.join('\n');
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n[schema truncated]` : text;
}

function formatSample(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'string') {
    const compact = value.replace(/\s+/g, ' ').trim();
    return compact.length > 60 ? JSON.stringify(`${compact.slice(0, 59)}…`) : JSON.stringify(compact);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}
