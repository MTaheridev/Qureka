import type { RelationEdge, RelationKind } from '../../shared/ipc';
import type { RawColumn, RawSchema, RawTable } from './types';

function tableKey(schema: string, name: string): string {
  return `${schema}\u0000${name.toLowerCase()}`;
}

function normalizeType(dataType: string): string {
  return dataType.toLowerCase().replace(/\([^)]*\)/g, '').replace(/\s+/g, '').trim();
}

function typesCompatible(a: string, b: string): boolean {
  const left = normalizeType(a);
  const right = normalizeType(b);
  if (left === right) return true;
  const intish = /^(int|integer|bigint|smallint|tinyint|serial|bigserial|number|numeric|decimal)$/;
  if (intish.test(left) && intish.test(right)) return true;
  const textish = /^(varchar|nvarchar|char|nchar|text|string|uuid|uniqueidentifier)$/;
  if (textish.test(left) && textish.test(right)) return true;
  return false;
}

/** Crude singularization for English table names used in FK-style columns. */
function singularize(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('ies') && lower.length > 3) return `${lower.slice(0, -3)}y`;
  if (lower.endsWith('sses') || lower.endsWith('xes') || lower.endsWith('zes') || lower.endsWith('ches') || lower.endsWith('shes')) {
    return lower.slice(0, -2);
  }
  if (lower.endsWith('s') && !lower.endsWith('ss') && lower.length > 2) return lower.slice(0, -1);
  return lower;
}

function stripIdSuffix(column: string): string | null {
  const name = column.toLowerCase();
  if (name === 'id') return null;
  if (name.endsWith('_id') && name.length > 3) return name.slice(0, -3);
  if (name.endsWith('id') && name.length > 2 && /[a-z]id$/.test(name)) {
    const base = name.slice(0, -2);
    if (base.length >= 2) return base;
  }
  return null;
}

function primaryKeyColumn(table: RawTable): RawColumn | null {
  const pks = table.columns.filter((column) => column.primaryKey);
  if (pks.length === 1) return pks[0] ?? null;
  const id = table.columns.find((column) => column.name.toLowerCase() === 'id');
  return id ?? null;
}

function findTargetTable(
  tables: RawTable[],
  hint: string,
  fromSchema: string,
): RawTable | null {
  const hintLower = hint.toLowerCase();
  const singular = singularize(hintLower);
  const candidates = tables.filter((table) => {
    const name = table.name.toLowerCase();
    return name === hintLower || name === singular || singularize(name) === hintLower || singularize(name) === singular;
  });
  if (candidates.length === 0) return null;
  const sameSchema = candidates.find((table) => table.schema === fromSchema);
  return sameSchema ?? candidates[0] ?? null;
}

function edgeKey(edge: RelationEdge): string {
  return [
    edge.fromSchema,
    edge.fromTable,
    edge.fromColumn,
    edge.toSchema ?? '',
    edge.toTable,
    edge.toColumn,
  ]
    .join('\u0000')
    .toLowerCase();
}

function declaredEdges(tables: RawTable[]): RelationEdge[] {
  const edges: RelationEdge[] = [];
  for (const table of tables) {
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

function markDeclaredReferences(tables: RawTable[]): void {
  for (const table of tables) {
    for (const column of table.columns) {
      if (column.references && !column.references.kind) {
        column.references = { ...column.references, kind: 'fk' };
      }
    }
  }
}

/**
 * Enrich a raw schema with declared FK edges plus name/type-inferred joins.
 * Mutates column.references for inferred edges when no FK exists.
 */
export function enrichSchemaRelations(schema: RawSchema): RawSchema {
  markDeclaredReferences(schema.tables);

  const existing = new Map<string, RelationEdge>();
  for (const edge of declaredEdges(schema.tables)) {
    existing.set(edgeKey(edge), edge);
  }

  for (const table of schema.tables) {
    for (const column of table.columns) {
      if (column.references) continue;
      if (column.primaryKey) continue;

      const hint = stripIdSuffix(column.name);
      if (!hint) continue;

      const target = findTargetTable(schema.tables, hint, table.schema);
      if (!target) continue;
      if (tableKey(target.schema, target.name) === tableKey(table.schema, table.name)) continue;

      const pk = primaryKeyColumn(target);
      if (!pk) continue;
      if (!typesCompatible(column.dataType, pk.dataType)) continue;

      const edge: RelationEdge = {
        fromSchema: table.schema,
        fromTable: table.name,
        fromColumn: column.name,
        toSchema: target.schema,
        toTable: target.name,
        toColumn: pk.name,
        kind: 'inferred',
      };
      const key = edgeKey(edge);
      if (existing.has(key)) continue;

      column.references = {
        table: target.name,
        column: pk.name,
        schema: target.schema,
        kind: 'inferred',
      };
      existing.set(key, edge);
    }
  }

  // Same-named non-PK column matching a single-column PK on another table (weaker).
  for (const table of schema.tables) {
    for (const column of table.columns) {
      if (column.references || column.primaryKey) continue;
      const colName = column.name.toLowerCase();
      if (colName === 'id' || colName === 'name' || colName === 'type' || colName === 'status') continue;

      for (const other of schema.tables) {
        if (tableKey(other.schema, other.name) === tableKey(table.schema, table.name)) continue;
        const pk = primaryKeyColumn(other);
        if (!pk || pk.name.toLowerCase() !== colName) continue;
        if (!typesCompatible(column.dataType, pk.dataType)) continue;

        const edge: RelationEdge = {
          fromSchema: table.schema,
          fromTable: table.name,
          fromColumn: column.name,
          toSchema: other.schema,
          toTable: other.name,
          toColumn: pk.name,
          kind: 'inferred',
        };
        const key = edgeKey(edge);
        if (existing.has(key)) continue;

        column.references = {
          table: other.name,
          column: pk.name,
          schema: other.schema,
          kind: 'inferred',
        };
        existing.set(key, edge);
        break;
      }
    }
  }

  return {
    ...schema,
    relations: Array.from(existing.values()),
  };
}

export type { RelationKind };
