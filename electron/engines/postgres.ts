import { Client, type ClientConfig } from 'pg';
import QueryStream from 'pg-query-stream';
import type { ReadOnlyCheck, ReadOnlyReport } from '../../shared/ipc';
import { LIMITS } from './constants';
import { assertReadOnlySql } from './sql-guard';
import { withTimeout } from './timeout';
import {
  ConnectionProbeError,
  type EngineAdapter,
  type RawColumn,
  type RawSchema,
  type RawTable,
  type RunOptions,
  type RunOutput,
  type SamplingLimits,
  type StoredConnection,
} from './types';
import { normalizeRow, tableRef } from './values';

const TABLE_KINDS = "('r', 'p', 'v', 'm', 'f')";
const SYSTEM_SCHEMAS = "('pg_catalog', 'information_schema')";

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function tableKey(schema: string, name: string): string {
  return `${schema}\u0000${name}`;
}

export class PostgresAdapter implements EngineAdapter {
  private client: Client | null = null;

  constructor(private readonly connection: StoredConnection) {}

  private config(): ClientConfig {
    return {
      host: this.connection.host ?? undefined,
      port: this.connection.port ?? undefined,
      database: this.connection.database ?? undefined,
      user: this.connection.username ?? undefined,
      password: this.connection.password ?? undefined,
      ssl: this.connection.ssl ? { rejectUnauthorized: false } : undefined,
      connectionTimeoutMillis: LIMITS.connectTimeoutMs,
      query_timeout: LIMITS.statementTimeoutMs,
      application_name: 'EasyReporter',
    };
  }

  private async open(): Promise<Client> {
    if (this.client) return this.client;
    if (!this.connection.host) {
      throw new ConnectionProbeError('No PostgreSQL host was provided.');
    }
    const client = new Client(this.config());
    try {
      await client.connect();
      await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
      await client.query(`SET statement_timeout = ${LIMITS.statementTimeoutMs}`);
      await client.query(`SET idle_in_transaction_session_timeout = ${LIMITS.statementTimeoutMs}`);
    } catch (error) {
      await client.end().catch(() => undefined);
      throw new ConnectionProbeError(describeError(error, 'Could not connect to PostgreSQL.'));
    }
    this.client = client;
    return client;
  }

  async probeReadOnly(): Promise<ReadOnlyReport> {
    const client = await this.open();
    const checks: ReadOnlyCheck[] = [];

    try {
      const identity = await client.query<{
        user: string;
        version: string;
        rolsuper: boolean;
        rolcreaterole: boolean;
        rolcreatedb: boolean;
        rolbypassrls: boolean;
        rolreplication: boolean;
      }>(
        `SELECT current_user AS user, version() AS version,
                r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolbypassrls, r.rolreplication
         FROM pg_roles r WHERE r.rolname = current_user`,
      );
      const role = identity.rows[0];
      const serverVersion = (role?.version ?? '').split(',')[0];

      checks.push({
        label: 'Authenticated',
        ok: true,
        detail: `${role?.user ?? 'unknown user'} — ${serverVersion}`,
      });

      const elevated = [
        role?.rolsuper ? 'SUPERUSER' : null,
        role?.rolcreaterole ? 'CREATEROLE' : null,
        role?.rolcreatedb ? 'CREATEDB' : null,
        role?.rolbypassrls ? 'BYPASSRLS' : null,
        role?.rolreplication ? 'REPLICATION' : null,
      ].filter((value): value is string => value !== null);

      checks.push({
        label: 'No elevated role attributes',
        ok: elevated.length === 0,
        detail: elevated.length === 0
          ? 'The role has no SUPERUSER, CREATEROLE, CREATEDB, BYPASSRLS or REPLICATION attribute.'
          : `The role has elevated attributes: ${elevated.join(', ')}.`,
      });

      const schemaWrites = await client.query<{ schema: string }>(
        `SELECT n.nspname AS schema
         FROM pg_namespace n
         WHERE n.nspname NOT IN ${SYSTEM_SCHEMAS}
           AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
           AND has_schema_privilege(current_user, n.oid, 'CREATE')
         ORDER BY n.nspname`,
      );
      checks.push({
        label: 'No CREATE privilege on schemas',
        ok: schemaWrites.rowCount === 0,
        detail: schemaWrites.rowCount === 0
          ? 'The role cannot create objects in any user schema.'
          : `The role can create objects in: ${schemaWrites.rows.map((row) => row.schema).join(', ')}.`,
      });

      const tableWrites = await client.query<{ name: string }>(
        `SELECT n.nspname || '.' || c.relname AS name
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind IN ${TABLE_KINDS}
           AND n.nspname NOT IN ${SYSTEM_SCHEMAS}
           AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
           AND (
             has_table_privilege(current_user, c.oid, 'INSERT')
             OR has_table_privilege(current_user, c.oid, 'UPDATE')
             OR has_table_privilege(current_user, c.oid, 'DELETE')
             OR has_any_column_privilege(current_user, c.oid, 'INSERT')
             OR has_any_column_privilege(current_user, c.oid, 'UPDATE')
             OR (c.relkind IN ('r', 'p', 'f', 'm') AND has_table_privilege(current_user, c.oid, 'TRUNCATE'))
           )
         ORDER BY 1
         LIMIT 10`,
      );
      checks.push({
        label: 'No write privileges on tables',
        ok: tableWrites.rowCount === 0,
        detail: tableWrites.rowCount === 0
          ? 'The role has no INSERT, UPDATE, DELETE or TRUNCATE privilege on any table or view.'
          : `The role can write to: ${tableWrites.rows.map((row) => row.name).join(', ')}${tableWrites.rowCount === 10 ? '…' : ''}.`,
      });

      const session = await client.query<{ transaction_read_only: string }>('SHOW transaction_read_only');
      const enforced = session.rows[0]?.transaction_read_only === 'on';
      checks.push({
        label: 'Read-only session enforced',
        ok: enforced,
        detail: enforced
          ? 'Every transaction on this session is READ ONLY, so the server rejects writes even if a statement slipped through.'
          : 'The session could not be switched to READ ONLY.',
      });
    } catch (error) {
      checks.push({
        label: 'Privilege inspection',
        ok: false,
        detail: describeError(error, 'The read-only checks could not be completed.'),
      });
    }

    return {
      verdict: checks.every((check) => check.ok) ? 'read-only' : 'writable',
      engine: 'postgres',
      checks,
      checkedAt: new Date().toISOString(),
    };
  }

  async introspect(limits: SamplingLimits, onProgress?: (message: string) => void): Promise<RawSchema> {
    const client = await this.open();
    onProgress?.('Reading the PostgreSQL catalog');

    const relationRows = await withTimeout(
      client.query<{ schema: string; name: string; row_estimate: string | null }>(
        `SELECT n.nspname AS schema, c.relname AS name,
                CASE WHEN c.relkind IN ('r', 'p', 'f', 'm') AND c.reltuples >= 0
                     THEN c.reltuples::bigint::text ELSE NULL END AS row_estimate
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind IN ${TABLE_KINDS}
           AND n.nspname NOT IN ${SYSTEM_SCHEMAS}
           AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
         ORDER BY n.nspname, c.relname
         LIMIT $1`,
        [limits.maxTables + 1],
      ),
      LIMITS.statementTimeoutMs,
      () => this.reset(),
    );

    const truncated = relationRows.rows.length > limits.maxTables;
    const selected = relationRows.rows.slice(0, limits.maxTables);
    const names = selected.map((row) => row.name);
    const schemas = selected.map((row) => row.schema);
    const selectedKeys = new Set(selected.map((row) => tableKey(row.schema, row.name)));

    const columnsByTable = new Map<string, RawColumn[]>();
    const references = new Map<string, Map<string, { table: string; column: string }>>();

    if (selected.length > 0) {
      const columns = await withTimeout(
        client.query<{ table_schema: string; table_name: string; column_name: string; data_type: string; is_nullable: string }>(
          `SELECT c.table_schema, c.table_name, c.column_name,
                  CASE WHEN c.data_type = 'USER-DEFINED' THEN c.udt_name ELSE c.data_type END AS data_type,
                  c.is_nullable
           FROM information_schema.columns c
           JOIN (SELECT * FROM unnest($1::text[], $2::text[]) AS t(schema_name, table_name)) sel
             ON sel.schema_name = c.table_schema AND sel.table_name = c.table_name
           ORDER BY c.table_schema, c.table_name, c.ordinal_position`,
          [schemas, names],
        ),
        LIMITS.statementTimeoutMs,
        () => this.reset(),
      );

      for (const row of columns.rows) {
        const key = tableKey(row.table_schema, row.table_name);
        const list = columnsByTable.get(key) ?? [];
        list.push({
          name: row.column_name,
          dataType: row.data_type,
          nullable: row.is_nullable === 'YES',
          primaryKey: false,
          references: null,
        });
        columnsByTable.set(key, list);
      }

      const primaryKeys = await withTimeout(
        client.query<{ table_schema: string; table_name: string; column_name: string }>(
          `SELECT tc.table_schema, tc.table_name, kcu.column_name
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON kcu.constraint_name = tc.constraint_name AND kcu.constraint_schema = tc.constraint_schema
           WHERE tc.constraint_type = 'PRIMARY KEY'
             AND (tc.table_schema, tc.table_name) IN (
               SELECT * FROM unnest($1::text[], $2::text[]) AS t(schema_name, table_name)
             )`,
          [schemas, names],
        ),
        LIMITS.statementTimeoutMs,
        () => this.reset(),
      );
      for (const row of primaryKeys.rows) {
        const key = tableKey(row.table_schema, row.table_name);
        const column = columnsByTable.get(key)?.find((item) => item.name === row.column_name);
        if (column) column.primaryKey = true;
      }

      const foreignKeys = await withTimeout(
        client.query<{ schema: string; table_name: string; column_name: string; foreign_table: string; foreign_column: string }>(
          `SELECT ns.nspname AS schema, cl.relname AS table_name, att.attname AS column_name,
                  fcl.relname AS foreign_table, fatt.attname AS foreign_column
           FROM pg_constraint con
           JOIN pg_class cl ON cl.oid = con.conrelid
           JOIN pg_namespace ns ON ns.oid = cl.relnamespace
           JOIN pg_class fcl ON fcl.oid = con.confrelid
           JOIN LATERAL unnest(con.conkey, con.confkey) AS keys(attnum, fattnum) ON true
           JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = keys.attnum
           JOIN pg_attribute fatt ON fatt.attrelid = con.confrelid AND fatt.attnum = keys.fattnum
           WHERE con.contype = 'f' AND ns.nspname = ANY($1::text[])`,
          [schemas],
        ),
        LIMITS.statementTimeoutMs,
        () => this.reset(),
      );
      for (const row of foreignKeys.rows) {
        const key = tableKey(row.schema, row.table_name);
        if (!selectedKeys.has(key)) continue;
        const map = references.get(key) ?? new Map();
        if (!map.has(row.column_name)) {
          map.set(row.column_name, { table: row.foreign_table, column: row.foreign_column });
        }
        references.set(key, map);
      }

      for (const [key, list] of columnsByTable) {
        const map = references.get(key);
        if (!map) continue;
        for (const column of list) {
          column.references = map.get(column.name) ?? null;
        }
      }
    }

    const tables: RawTable[] = [];
    for (let index = 0; index < selected.length; index += 1) {
      const relation = selected[index];
      onProgress?.(`Sampling ${relation.schema}.${relation.name} (${index + 1}/${selected.length})`);
      const key = tableKey(relation.schema, relation.name);
      const table: RawTable = {
        schema: relation.schema,
        name: relation.name,
        rowCount: toNumber(relation.row_estimate),
        columns: columnsByTable.get(key) ?? [],
        sampleColumns: (columnsByTable.get(key) ?? []).map((column) => column.name),
        sampleRows: [],
      };

      try {
        const reference = tableRef('postgres', relation.schema, relation.name);
        const sample = await withTimeout(
          client.query({ text: `SELECT * FROM ${reference} LIMIT $1`, rowMode: 'array' }, [limits.sampleRows]),
          LIMITS.sampleTimeoutMs,
          () => this.reset(),
        );
        table.sampleColumns = sample.fields.map((field) => field.name);
        table.sampleRows = sample.rows.map((row: unknown[]) => normalizeRow(row, limits.maxCellChars));
      } catch {
        // Skip tables the role cannot read; the schema and columns remain.
      }

      tables.push(table);
    }

    return { tables, truncated };
  }

  async runSelect(sql: string, options: RunOptions): Promise<RunOutput> {
    const statement = assertReadOnlySql(sql);
    const client = await this.open();
    const started = Date.now();

    await client.query('BEGIN TRANSACTION READ ONLY');

    let columns: string[] = [];
    let rowCount = 0;
    let truncated = false;

    try {
      const stream = new QueryStream(statement, [], { batchSize: 200, rowMode: 'array' });

      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error) reject(error);
          else resolve();
        };

        const timer = setTimeout(() => {
          stream.destroy(new Error(`The query timed out after ${Math.round(options.timeoutMs / 1000)} seconds.`));
        }, options.timeoutMs);

        stream.on('data', (row: unknown[]) => {
          if (rowCount >= options.maxRows) {
            truncated = true;
            stream.destroy();
            return;
          }
          options.onRow?.(normalizeRow(row));
          rowCount += 1;
        });
        stream.on('end', () => finish());
        stream.on('error', (error: Error) => finish(error));
        stream.on('close', () => finish());

        client.query(stream);
      });

      const fields = (stream._result?.fields ?? []) as Array<{ name: string }>;
      columns = fields.map((field) => field.name);
    } finally {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the original failure; the connection is closed by the caller.
      }
    }

    return { columns, rowCount, truncated, durationMs: Date.now() - started };
  }

  async close(): Promise<void> {
    this.reset();
  }

  private reset(): void {
    if (this.client) {
      const client = this.client;
      this.client = null;
      client.end().catch(() => undefined);
    }
  }
}

function describeError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}
