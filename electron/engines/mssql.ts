import { ConnectionPool, Request, Transaction, type config as MssqlConfig } from 'mssql';
import type { ReadOnlyCheck, ReadOnlyReport } from '../../shared/ipc';
import { LIMITS } from './constants';
import { assertReadOnlySql } from './sql-guard';
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

interface MssqlRow {
  [column: string]: unknown;
}

function tableKey(schema: string, name: string): string {
  return `${schema}\u0000${name}`;
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isFlag(value: unknown): boolean {
  return Number(value) === 1;
}

export class MssqlAdapter implements EngineAdapter {
  private pool: ConnectionPool | null = null;

  constructor(private readonly connection: StoredConnection) {}

  private config(): MssqlConfig {
    return {
      server: this.connection.host ?? 'localhost',
      port: this.connection.port ?? 1433,
      user: this.connection.username ?? undefined,
      password: this.connection.password ?? undefined,
      database: this.connection.database ?? undefined,
      connectionTimeout: LIMITS.connectTimeoutMs,
      requestTimeout: LIMITS.statementTimeoutMs,
      options: {
        encrypt: this.connection.ssl === true,
        trustServerCertificate: true,
        enableArithAbort: true,
      },
      pool: { max: 2, min: 0, idleTimeoutMillis: 30_000 },
    };
  }

  private async open(): Promise<ConnectionPool> {
    if (this.pool) return this.pool;
    if (!this.connection.host) {
      throw new ConnectionProbeError('No SQL Server host was provided.');
    }
    const pool = new ConnectionPool(this.config());
    try {
      await pool.connect();
    } catch (error) {
      await pool.close().catch(() => undefined);
      throw new ConnectionProbeError(describeError(error, 'Could not connect to SQL Server.'));
    }
    this.pool = pool;
    return pool;
  }

  async probeReadOnly(): Promise<ReadOnlyReport> {
    const pool = await this.open();
    const checks: ReadOnlyCheck[] = [];

    try {
      const result = await pool.request().query<MssqlRow>(
        `SELECT SUSER_SNAME() AS loginName, DB_NAME() AS databaseName, @@VERSION AS version,
                IS_SRVROLEMEMBER('sysadmin') AS isSysadmin,
                IS_MEMBER('db_owner') AS isDbOwner,
                IS_MEMBER('db_datawriter') AS isDbDataWriter,
                IS_MEMBER('db_ddladmin') AS isDbDdlAdmin,
                IS_MEMBER('db_accessadmin') AS isDbAccessAdmin,
                HAS_PERMS_BY_NAME(NULL, NULL, 'CONTROL SERVER') AS isControlServer`,
      );
      const identity = result.recordset[0] ?? {};

      checks.push({
        label: 'Authenticated',
        ok: true,
        detail: `${String(identity.loginName ?? 'unknown login')} — ${String(identity.databaseName ?? '')} — ${String(identity.version ?? '').split('\n')[0]}`,
      });

      const roles = [
        isFlag(identity.isSysadmin) ? 'sysadmin' : null,
        isFlag(identity.isControlServer) ? 'CONTROL SERVER' : null,
        isFlag(identity.isDbOwner) ? 'db_owner' : null,
        isFlag(identity.isDbDataWriter) ? 'db_datawriter' : null,
        isFlag(identity.isDbDdlAdmin) ? 'db_ddladmin' : null,
        isFlag(identity.isDbAccessAdmin) ? 'db_accessadmin' : null,
      ].filter((value): value is string => value !== null);

      checks.push({
        label: 'No server or database write roles',
        ok: roles.length === 0,
        detail: roles.length === 0
          ? 'The login is not sysadmin and has no db_owner, db_datawriter, db_ddladmin or db_accessadmin role.'
          : `The login has write-level roles: ${roles.join(', ')}.`,
      });
    } catch (error) {
      checks.push({
        label: 'Authentication and roles',
        ok: false,
        detail: describeError(error, 'Could not inspect the SQL Server login.'),
      });
    }

    try {
      const result = await pool.request().query<MssqlRow>(
        `SELECT HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'CREATE TABLE') AS createTable,
                HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'ALTER') AS alterDatabase,
                HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'CONTROL') AS controlDatabase,
                HAS_PERMS_BY_NAME(NULL, NULL, 'EXECUTE') AS executePermissions`,
      );
      const permissions = result.recordset[0] ?? {};
      const offending = [
        isFlag(permissions.createTable) ? 'CREATE TABLE' : null,
        isFlag(permissions.alterDatabase) ? 'ALTER' : null,
        isFlag(permissions.controlDatabase) ? 'CONTROL' : null,
        isFlag(permissions.executePermissions) ? 'EXECUTE' : null,
      ].filter((value): value is string => value !== null);

      checks.push({
        label: 'No database-level write permissions',
        ok: offending.length === 0,
        detail: offending.length === 0
          ? 'The login cannot create, alter or control objects in this database, and cannot execute procedures.'
          : `The login has database-level permissions: ${offending.join(', ')}.`,
      });
    } catch (error) {
      checks.push({
        label: 'No database-level write permissions',
        ok: false,
        detail: describeError(error, 'Could not inspect database-level permissions.'),
      });
    }

    try {
      const result = await pool.request().query<MssqlRow>(
        `SELECT TOP (10) QUOTENAME(s.name) + '.' + QUOTENAME(t.name) AS name
         FROM sys.tables t
         JOIN sys.schemas s ON s.schema_id = t.schema_id
         WHERE HAS_PERMS_BY_NAME(QUOTENAME(s.name) + '.' + QUOTENAME(t.name), 'OBJECT', 'INSERT') = 1
            OR HAS_PERMS_BY_NAME(QUOTENAME(s.name) + '.' + QUOTENAME(t.name), 'OBJECT', 'UPDATE') = 1
            OR HAS_PERMS_BY_NAME(QUOTENAME(s.name) + '.' + QUOTENAME(t.name), 'OBJECT', 'DELETE') = 1
         ORDER BY 1`,
      );
      const tables = result.recordset.map((row) => String(row.name));
      checks.push({
        label: 'No write permissions on tables',
        ok: tables.length === 0,
        detail: tables.length === 0
          ? 'The login has no INSERT, UPDATE or DELETE permission on any table.'
          : `The login can write to: ${tables.join(', ')}${tables.length === 10 ? '…' : ''}.`,
      });
    } catch (error) {
      checks.push({
        label: 'No write permissions on tables',
        ok: false,
        detail: describeError(error, 'Could not inspect table permissions.'),
      });
    }

    return {
      verdict: checks.every((check) => check.ok) ? 'read-only' : 'writable',
      engine: 'mssql',
      checks,
      checkedAt: new Date().toISOString(),
    };
  }

  async introspect(limits: SamplingLimits, onProgress?: (message: string) => void): Promise<RawSchema> {
    const pool = await this.open();
    onProgress?.('Reading the SQL Server catalog');

    const relationRequest = pool.request();
    relationRequest.input('limit', limits.maxTables + 1);
    const relationResult = await relationRequest.query<MssqlRow>(
      `SELECT TOP (@limit) s.name AS [schema], o.name AS name,
              CASE WHEN o.type = 'U' THEN (
                SELECT SUM(p.rows) FROM sys.partitions p
                WHERE p.object_id = o.object_id AND p.index_id IN (0, 1)
              ) ELSE NULL END AS rowEstimate
       FROM sys.objects o
       JOIN sys.schemas s ON s.schema_id = o.schema_id
       WHERE o.type IN ('U', 'V') AND o.is_ms_shipped = 0
       ORDER BY s.name, o.name`,
    );

    const truncated = relationResult.recordset.length > limits.maxTables;
    const selected = relationResult.recordset.slice(0, limits.maxTables);
    const selectedKeys = new Set(selected.map((row) => tableKey(String(row.schema), String(row.name))));

    const columnResult = await pool.request().query<MssqlRow>(
      `SELECT s.name AS [schema], o.name AS tableName, c.name AS columnName, ty.name AS dataType,
              c.is_nullable AS isNullable,
              CASE WHEN EXISTS (
                SELECT 1 FROM sys.indexes i
                JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                WHERE i.object_id = o.object_id AND i.is_primary_key = 1 AND ic.column_id = c.column_id
              ) THEN 1 ELSE 0 END AS isPrimaryKey
       FROM sys.objects o
       JOIN sys.schemas s ON s.schema_id = o.schema_id
       JOIN sys.columns c ON c.object_id = o.object_id
       JOIN sys.types ty ON ty.user_type_id = c.user_type_id
       WHERE o.type IN ('U', 'V') AND o.is_ms_shipped = 0
       ORDER BY s.name, o.name, c.column_id`,
    );

    const columnsByTable = new Map<string, RawColumn[]>();
    for (const row of columnResult.recordset) {
      const key = tableKey(String(row.schema), String(row.tableName));
      if (!selectedKeys.has(key)) continue;
      const list = columnsByTable.get(key) ?? [];
      list.push({
        name: String(row.columnName),
        dataType: String(row.dataType),
        nullable: isFlag(row.isNullable),
        primaryKey: isFlag(row.isPrimaryKey),
        references: null,
      });
      columnsByTable.set(key, list);
    }

    const foreignResult = await pool.request().query<MssqlRow>(
      `SELECT s.name AS [schema], o.name AS tableName, c.name AS columnName,
              fo.name AS foreignTable, fc.name AS foreignColumn
       FROM sys.foreign_key_columns fkc
       JOIN sys.objects o ON o.object_id = fkc.parent_object_id
       JOIN sys.schemas s ON s.schema_id = o.schema_id
       JOIN sys.columns c ON c.object_id = fkc.parent_object_id AND c.column_id = fkc.parent_column_id
       JOIN sys.objects fo ON fo.object_id = fkc.referenced_object_id
       JOIN sys.columns fc ON fc.object_id = fkc.referenced_object_id AND fc.column_id = fkc.referenced_column_id`,
    );

    const references = new Map<string, Map<string, { table: string; column: string }>>();
    for (const row of foreignResult.recordset) {
      const key = tableKey(String(row.schema), String(row.tableName));
      if (!selectedKeys.has(key)) continue;
      const map = references.get(key) ?? new Map();
      if (!map.has(String(row.columnName))) {
        map.set(String(row.columnName), {
          table: String(row.foreignTable),
          column: String(row.foreignColumn),
        });
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

    const tables: RawTable[] = [];
    for (let index = 0; index < selected.length; index += 1) {
      const relation = selected[index];
      const schema = String(relation.schema);
      const name = String(relation.name);
      onProgress?.(`Sampling ${schema}.${name} (${index + 1}/${selected.length})`);

      const key = tableKey(schema, name);
      const table: RawTable = {
        schema,
        name,
        rowCount: toNumber(relation.rowEstimate),
        columns: columnsByTable.get(key) ?? [],
        sampleColumns: (columnsByTable.get(key) ?? []).map((column) => column.name),
        sampleRows: [],
      };

      try {
        const sampleRequest = pool.request();
        sampleRequest.input('rows', Math.max(1, limits.sampleRows));
        const sample = await sampleRequest.query<MssqlRow>(
          `SELECT TOP (@rows) * FROM ${tableRef('mssql', schema, name)}`,
        );
        const recordset = sample.recordset as MssqlRow[] & {
          columns?: Record<string, { name: string }>;
        };
        const fieldNames = recordset.columns ? Object.keys(recordset.columns) : [];
        table.sampleColumns = fieldNames.length > 0 ? fieldNames : table.sampleColumns;
        table.sampleRows = sample.recordset.map((row) =>
          normalizeRow(fieldNames.map((field) => row[field]), limits.maxCellChars),
        );
      } catch {
        // Skip tables the login cannot read; the schema and columns remain.
      }

      tables.push(table);
    }

    return { tables, truncated };
  }

  async runSelect(sql: string, options: RunOptions): Promise<RunOutput> {
    const statement = assertReadOnlySql(sql);
    const pool = await this.open();
    const started = Date.now();

    let columns: string[] = [];
    let rowCount = 0;
    let truncated = false;

    const transaction = new Transaction(pool);
    await transaction.begin();

    try {
      const request = new Request(transaction);
      request.stream = true;
      request.arrayRowMode = true;

      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try {
            request.cancel();
          } catch {
            // The request may already be complete.
          }
          if (error) reject(error);
          else resolve();
        };

        const timer = setTimeout(() => {
          finish(new Error(`The query timed out after ${Math.round(options.timeoutMs / 1000)} seconds.`));
        }, options.timeoutMs);

        request.on('recordset', (recordsetColumns: Array<{ name: string }>) => {
          if (columns.length === 0 && Array.isArray(recordsetColumns)) {
            columns = recordsetColumns.map((column) => column.name);
          }
        });
        request.on('row', (row: unknown[]) => {
          if (rowCount >= options.maxRows) {
            truncated = true;
            finish();
            return;
          }
          options.onRow?.(normalizeRow(Array.isArray(row) ? row : [row]));
          rowCount += 1;
        });
        request.on('error', (error: Error) => finish(error));
        request.on('done', () => finish());

        request.query(statement).catch((error: Error) => finish(error));
      });
    } finally {
      try {
        await transaction.rollback();
      } catch {
        // The transaction may be aborted; nothing was committed either way.
      }
    }

    return { columns, rowCount, truncated, durationMs: Date.now() - started };
  }

  async close(): Promise<void> {
    if (this.pool) {
      const pool = this.pool;
      this.pool = null;
      await pool.close().catch(() => undefined);
    }
  }
}

function describeError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}
