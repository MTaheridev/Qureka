import type { EngineId, RelationEdge, SchemaSnapshot } from '../../shared/ipc';

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

function qualify(schema: string | undefined, name: string): string {
  if (schema && schema !== 'main' && schema.length > 0) return `${schema}.${name}`;
  return name;
}

function formatRelation(edge: RelationEdge): string {
  const from = `${qualify(edge.fromSchema, edge.fromTable)}.${edge.fromColumn}`;
  const to = `${qualify(edge.toSchema, edge.toTable)}.${edge.toColumn}`;
  const tag = edge.kind === 'inferred' ? 'INFERRED' : 'FK';
  return `  - [${tag}] ${from} -> ${to}`;
}

function collectRelations(snapshot: SchemaSnapshot): RelationEdge[] {
  if (snapshot.relations && snapshot.relations.length > 0) return snapshot.relations;

  const edges: RelationEdge[] = [];
  for (const table of snapshot.tables) {
    for (const column of table.columns) {
      if (!column.references) continue;
      edges.push({
        fromSchema: table.schema,
        fromTable: table.name,
        fromColumn: column.name,
        toSchema: column.references.schema,
        toTable: column.references.table,
        toColumn: column.references.column,
        kind: column.references.kind ?? 'fk',
      });
    }
  }
  return edges;
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
  lines.push('Review every table below. Prefer declared FK relations; treat INFERRED joins as assumptions to confirm.');

  const relations = collectRelations(snapshot);
  if (relations.length > 0) {
    lines.push('');
    lines.push('RELATIONS');
    const declared = relations.filter((edge) => edge.kind === 'fk');
    const inferred = relations.filter((edge) => edge.kind === 'inferred');
    for (const edge of declared) lines.push(formatRelation(edge));
    for (const edge of inferred) lines.push(formatRelation(edge));
  }

  for (const table of snapshot.tables) {
    const qualified = qualify(table.schema, table.name);
    const rows = table.rowCount === null ? 'unknown rows' : `~${table.rowCount} rows`;
    lines.push('');
    lines.push(`TABLE ${qualified} (${rows})`);

    for (const column of table.columns) {
      const ref = column.references;
      const fkFlag =
        ref && (ref.kind ?? 'fk') === 'fk'
          ? `FK -> ${qualify(ref.schema, ref.table)}.${ref.column}`
          : null;
      const inferredFlag =
        ref && ref.kind === 'inferred'
          ? `INFERRED -> ${qualify(ref.schema, ref.table)}.${ref.column}`
          : null;
      const flags = [
        column.primaryKey ? 'PK' : null,
        column.nullable ? null : 'NOT NULL',
        fkFlag,
        inferredFlag,
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
